import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Exercise an isolated copy so tests can never overwrite the user's model preference.
const extensionDir = await mkdtemp(join(tmpdir(), "pi-naming-extension-"));
const extensionFile = join(extensionDir, "index.ts");
const modelConfig = join(extensionDir, "config.json");
await copyFile(new URL("./index.ts", import.meta.url), extensionFile);
const { default: extension } = await import(pathToFileURL(extensionFile).href);
beforeEach(() => rmSync(modelConfig, { force: true }));
after(() => rm(extensionDir, { recursive: true, force: true }));

const execute = promisify(execFile);
async function waitFor(predicate, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
const user = (text) => ({ type: "message", message: { role: "user", content: text } });
const miss = { stdout: "", stderr: "not a repository", code: 128, killed: false };
const simpleModel = { provider: "fixture", id: "fixture" };
const simpleRegistry = {
	streamSimple: (_model, context) => ({ result: async () => {
		const data = JSON.parse(context.messages[0].content);
		const repo = data.repositories.length === 1 ? data.repositories[0] : undefined;
		const task = data.context.split("\n")[0].replace(/^Original request: /, "")
			.replace(/^\/(?:skill:)?[\w:-]+\s+/, "").slice(0, 80);
		return { stopReason: "stop", provider: "fixture", model: "fixture", usage: { totalTokens: 1 }, content: [{ type: "text", text: JSON.stringify({
			component: (repo?.name || data.componentHint).toLowerCase().replace(/[^a-z0-9]+/g, "-"), domain: "", task,
			repository: repo?.name ?? "", branch: repo?.branchCandidates.length === 1 ? repo.branchCandidates[0] : "",
		}) }] };
	} }),
};

function harness(options = {}) {
	const handlers = new Map();
	const commands = new Map();
	const state = { name: undefined, id: "a83f91bc", entries: [], confirmations: [], selections: [], notices: [], ...options };
	const ctx = {
		cwd: "/workspace/atlas", mode: "tui", hasUI: true, model: simpleModel, modelRegistry: simpleRegistry,
		ui: {
			notify: (message) => state.notices.push(message),
			confirm: async (...args) => { state.confirmations.push(args); return state.accept ?? true; },
			select: async (...args) => { state.selections.push(args); return state.selection; },
		},
		sessionManager: {
			getSessionId: () => state.id,
			getEntries: () => state.entries,
			getBranch: () => state.branch ?? state.entries,
		},
		...options.ctx,
	};
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		getSessionName: () => state.name,
		setSessionName: (name) => { state.name = name; },
		appendEntry: (customType, data) => state.entries.push({ type: "custom", customType, data }),
		exec: options.exec ?? (async () => miss),
	};
	const api = extension(pi);
	const drain = () => api?.drain?.() ?? Promise.resolve();
	return {
		state, ctx, handlers, commands, drain,
		start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx),
		input: async (text, source = "interactive") => {
			await handlers.get("input")({ text, source }, ctx);
			state.entries.push(user(text));
			await drain(); // Automatic naming is background work; settle it before asserting.
		},
		command: (name, args = "") => commands.get(name).handler(args, ctx),
	};
}

const aiResponse = {
	stopReason: "stop", provider: "test-provider", model: "test-model",
	content: [{ type: "text", text: JSON.stringify({ component: "atlas", domain: "", task: "fix promotion expiry", branch: "" }) }],
	usage: { input: 42, output: 5, totalTokens: 47 },
};

function aiHarness(reply = () => aiResponse, options = {}) {
	const calls = [];
	const models = [
		{ provider: "test-provider", id: "test-model" },
		{ provider: "cheap-provider", id: "vendor/fast" },
	];
	const h = harness({
		...options,
		ctx: {
			...options.ctx,
			model: models[0],
			modelRegistry: {
				find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
				getAvailable: () => models,
				streamSimple: (model, context, request) => {
					calls.push({ model, context, request });
					return { result: async () => reply(calls.at(-1)) };
				},
			},
		},
	});
	return Object.assign(h, { calls });
}

const repoExec = async (_command, args) => ({
	stdout: args[0] === "for-each-ref" ? "feat/catalog-sync\nstaging\nmain"
		: args[0] === "symbolic-ref" ? "staging"
		: args[1] === "--show-toplevel" ? "/work/Atlas.Catalog" : "abc1234",
	stderr: "", code: 0, killed: false,
});

test("semantic component/domain, concrete consumers and recorded feature branch survive resume on staging", async () => {
	const id = "00000000-0000-7000-8000-000000000001";
	const description = { component: "atlas-consumer", domain: "inventory", task: "adjust master SKU, product SKU and barcode consumers", branch: "feat/catalog-sync" };
	const h = aiHarness(() => ({ ...aiResponse, content: [{ type: "text", text: JSON.stringify(description) }] }), {
		id, name: "inventory - consumer [on progress]", exec: repoExec, accept: false,
		ctx: { cwd: "/work/Atlas.Catalog/Code/Atlas.Backend/Atlas.Backend.Catalog/Atlas.Backend.Catalog.Consumers" },
		entries: [
			user('<skill name="code-quality-review">DO NOT SEND SKILL BODY</skill>\n\nAdjust the SKU and barcode consumers'),
			{ type: "compaction", summary: "Goal: integrate master-SKU support, preserve SKU/barcode. Work branch: `feat/catalog-sync`. Original base: staging. Domain: Inventory." },
			user("Are we ready to test?"), user("/reoload"),
		],
	});
	await h.start("resume");
	assert.equal(h.calls.length, 0);
	await h.command("session-autoname");
	const expected = `atlas-consumer/inventory - adjust master SKU, product SKU and barcode consumers [wip] - Atlas.Catalog@feat/catalog-sync #${id}`;
	assert.ok(h.state.confirmations[0][1].endsWith(expected));
	assert.equal(h.state.name, "inventory - consumer [on progress]");
	const evidence = JSON.parse(h.calls[0].context.messages[0].content);
	assert.ok(evidence.context.includes("Work branch:"));
	assert.ok(!evidence.context.includes("DO NOT SEND SKILL BODY"));
	assert.ok(!evidence.context.includes("/reoload"));
	assert.ok(evidence.branchCandidates.includes("feat/catalog-sync"));
	h.state.accept = true;
	await h.command("session-autoname");
	assert.equal(h.state.name, expected);
	await h.command("session-status", "done");
	assert.ok(h.state.name.includes("@feat/catalog-sync"));
});

test("unknown/ambiguous historical branch is omitted; explicit branch override is honored without an AI call", async () => {
	const h = aiHarness(() => ({ ...aiResponse, content: [{ type: "text", text: JSON.stringify({ component: "atlas-consumer", domain: "inventory", task: "adjust consumers", branch: "feat/invented" }) }] }), {
		exec: repoExec, entries: [user("Compare staging with main")],
	});
	await h.start("resume");
	await h.command("session-autoname");
	assert.ok(!h.state.name.includes("@"));
	await h.command("session-autoname", "atlas-consumer/inventory - adjust SKU and barcode --branch feat/catalog-sync");
	assert.equal(h.calls.length, 1);
	assert.equal(h.state.name, "atlas-consumer/inventory - adjust SKU and barcode [wip] - Atlas.Catalog@feat/catalog-sync #a83f91bc");
	const previous = h.state.name;
	await h.command("session-autoname", "task --branch");
	assert.equal(h.state.name, previous);
});

test("skill wrappers never become fallback titles and UUIDs sharing a timestamp prefix remain distinct", async () => {
	const ids = ["00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000002"];
	for (const id of ids) {
		const h = harness({ id });
		await h.start();
		await h.input('<skill name="code-quality-review">Long instructions\nnot a task</skill>');
		assert.equal(h.state.name, undefined);
		await h.input('<skill name="code-quality-review">Long instructions</skill>\n\nFix product barcode mapping');
		assert.equal(h.state.name, `atlas - Fix product barcode mapping [wip] #${id}`);
	}
	const malformed = harness();
	await malformed.start();
	await malformed.input('<skill name="broken">incomplete wrapper');
	assert.equal(malformed.state.name, undefined);
	const manual = harness({ name: "inventory - consumer [on progress]" });
	await manual.start();
	await manual.command("session-status", "wip");
	assert.equal(manual.state.name, "inventory - consumer [wip]");
});

test("a truncated reasoning response never offers to replace an existing session name", async () => {
	const h = aiHarness(() => ({ ...aiResponse, stopReason: "length", content: [], usage: { reasoning: 4096, output: 4096 } }), {
		name: "rails - /templates", entries: [user("Port the templates endpoints")],
	});
	await h.start("resume");
	await h.command("session-autoname");
	assert.equal(h.state.name, "rails - /templates");
	assert.equal(h.state.confirmations.length, 0);
	assert.equal(h.state.entries.filter((entry) => entry.customType === "auto-session-name:v1").length, 0);
});

test("home-launched sessions find target repo and late worktree branch without mixing source branches", async () => {
	const temp = await mkdtemp(join(tmpdir(), "pi-naming-repos-"));
	try {
		const source = join(temp, "Atlas.Catalog");
		const target = join(temp, "atlas-service");
		const worktree = `${target}.directory-compat`;
		for (const cwd of [source, target]) {
			await execute("git", ["init", "--initial-branch=main", cwd]);
			await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd });
		}
		await execute("git", ["branch", "test/source-characterization"], { cwd: source });
		await execute("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "feat/directory-compatibility", worktree], { cwd: target });
		const exec = async (command, args, options) => {
			try { return { ...await execute(command, args, options), code: 0, killed: false }; }
			catch { return miss; }
		};
		for (const branch of ["feat/directory-compatibility", "test/source-characterization"]) {
			const h = aiHarness(() => ({ ...aiResponse, content: [{ type: "text", text: JSON.stringify({
				component: "atlas-rails", domain: "directories", task: "port directory compatibility routes", repository: "atlas-service", branch,
			}) }] }), {
				ctx: { cwd: temp }, exec, name: "Old name",
				entries: [
					user(`Port /v1/directories from ${source} into Rails at ${target}`),
					{ type: "compaction", summary: "Goal: port directory routes.\n" + "Long historical constraints.\n".repeat(180)
						+ `\nWorktree: ${worktree}\nBranch: feat/directory-compatibility\nSource branch: test/source-characterization` },
				],
			});
			await h.start("resume");
			await h.command("session-autoname");
			const evidence = JSON.parse(h.calls[0].context.messages[0].content);
			assert.ok(evidence.context.includes("feat/directory-compatibility"));
			assert.equal(evidence.repositories.filter((repo) => repo.name === "atlas-service").length, 1);
			assert.ok(evidence.repositories.find((repo) => repo.name === "atlas-service").paths.includes(worktree));
			assert.equal(h.state.name, `atlas-rails/directories - port directory compatibility routes [wip] - atlas-service${branch.startsWith("feat/") ? "@feat/directory-compatibility" : ""} #a83f91bc`);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("automatic naming runs in the background and never blocks the input handler", async () => {
	let resolve;
	const h = aiHarness(() => new Promise((done) => { resolve = done; }));
	await h.start();
	await h.handlers.get("input")({ text: "Fix checkout", source: "interactive" }, h.ctx);
	await new Promise((done) => setImmediate(done));
	assert.equal(h.state.name, undefined); // The handler returned before naming resolved.
	assert.equal(h.calls.length, 1); // Naming did start in the background.
	resolve({ ...aiResponse });
	await h.drain();
	assert.equal(h.state.name, "atlas - fix promotion expiry [wip] #a83f91bc");
});

test("model selection persists globally across instances without changing chat model or title", async () => {
	const h = aiHarness(undefined, { name: "Existing title" });
	await h.start("resume");
	const chatModel = h.ctx.model;
	await h.command("session-name-model", "cheap-provider/vendor/fast");
	assert.deepEqual(JSON.parse(readFileSync(modelConfig, "utf8")), { model: "cheap-provider/vendor/fast" });
	assert.equal(h.ctx.model, chatModel);
	assert.equal(h.state.name, "Existing title");
	const fresh = aiHarness();
	await fresh.start();
	fresh.ctx.model = undefined; // A pinned naming model does not need a selected chat model.
	await fresh.input("Fix promotion expiry");
	assert.equal(fresh.calls[0].model.id, "vendor/fast");
	await h.command("session-name-model", "current");
	const following = aiHarness();
	await following.start();
	await following.input("Fix expiry");
	assert.equal(following.calls[0].model, following.ctx.model);
});

test("model picker supports selection and cancellation; unknown models do not overwrite config", async () => {
	const h = aiHarness(undefined, { selection: "cheap-provider/vendor/fast" });
	await h.start();
	await h.command("session-name-model");
	assert.ok(h.state.selections[0][1].includes("current"));
	assert.ok(h.state.selections[0][1].includes("cheap-provider/vendor/fast"));
	const config = readFileSync(modelConfig, "utf8");
	await h.command("session-name-model", "unknown/model");
	assert.equal(readFileSync(modelConfig, "utf8"), config);
	h.state.selection = undefined;
	await h.command("session-name-model");
	assert.equal(readFileSync(modelConfig, "utf8"), config);
	assert.ok(h.state.notices.some((message) => message.includes("Unknown model")));
});

test("unreadable or missing pinned models keep names unchanged, never silently switch providers", async () => {
	for (const data of ["{broken", JSON.stringify({ model: "missing/model" })]) {
		writeFileSync(modelConfig, data);
		const h = aiHarness();
		await h.start();
		await h.input("Fallback task");
		assert.equal(h.calls.length, 0);
		assert.equal(h.state.name, undefined);
	}
	const h = aiHarness();
	await h.start();
	await h.command("session-name-model", "current");
	await h.input("Fix expiry");
	assert.equal(h.calls.length, 1);
});

test("cancelled model picker and plain naming leave no config behind", async () => {
	const h = aiHarness();
	await h.start();
	await h.command("session-name-model");
	await h.input("Fix expiry");
	assert.equal(existsSync(modelConfig), false);
});

test("AI names once using the current model and bounded prompt, without tools", async () => {
	const h = aiHarness();
	await h.start();
	await h.input("Could you investigate this?\nPromotions don't expire as expected. " + "detail ".repeat(2000));
	assert.equal(h.state.name, "atlas - fix promotion expiry [wip] #a83f91bc");
	assert.equal(h.calls.length, 1);
	const { model, context, request } = h.calls[0];
	assert.equal(model, h.ctx.model);
	const evidence = JSON.parse(context.messages[0].content);
	assert.equal(evidence.context.length, 6000);
	assert.ok(evidence.context.includes("Promotions don't expire"));
	assert.equal(context.tools, undefined);
	assert.equal(request.maxRetries, 0);
	assert.equal(request.maxTokens, 4096);
	assert.equal(request.reasoning, "low");
	assert.notEqual(request.sessionId, h.state.id);
	assert.deepEqual(h.state.entries.find((entry) => entry.customType === "auto-session-name:usage").data.usage, aiResponse.usage);
	await h.input("Now add tests");
	await h.command("session-status", "done");
	assert.equal(h.calls.length, 1);
});

test("explicit AI naming includes original goal and recent user context, not tools or other branches", async () => {
	const branch = [user("Original goal"), user("Older detail to omit")];
	for (let i = 0; i < 3; i++) branch.push(user(`Clarification ${i} ` + "detail ".repeat(400)));
	branch.push({ type: "message", message: { role: "toolResult", content: "DO NOT SEND TOOL OUTPUT" } });
	branch.push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "DO NOT SEND THINKING" }] } });
	const h = aiHarness(undefined, { entries: [user("DO NOT SEND OTHER BRANCH")], branch });
	await h.start("resume");
	assert.equal(h.calls.length, 0);
	await h.command("session-autoname");
	const sent = JSON.parse(h.calls[0].context.messages[0].content).context;
	assert.ok(sent.includes("Original goal"));
	assert.ok(sent.includes("Clarification 2"));
	assert.ok(!sent.includes("Older detail"));
	assert.ok(!sent.includes("DO NOT SEND"));
	assert.ok(sent.length <= 6000);
	await h.command("session-autoname", "atlas/api - keep my exact label");
	assert.equal(h.calls.length, 1);
	assert.equal(h.state.name, "atlas/api - keep my exact label [wip] #a83f91bc");
});

test("AI failures and invalid output leave names unchanged without retrying", async () => {
	for (const response of [
		new Error("Auth unavailable"),
		{ ...aiResponse, stopReason: "error" },
		{ ...aiResponse, stopReason: "length" },
		{ ...aiResponse, stopReason: "toolUse" },
		...["", "line one\nline two", "x".repeat(65)].map((text) => ({ ...aiResponse, content: [{ type: "text", text }] })),
	]) {
		const h = aiHarness(() => { if (response instanceof Error) throw response; return response; });
		await h.start();
		await h.input("Fallback task\nFurther detail");
		assert.equal(h.state.name, undefined);
		assert.equal(h.calls.length, 1);
	}
	const fenced = aiHarness(() => ({ ...aiResponse, content: [{ type: "text", text: `\`\`\`json\n${aiResponse.content[0].text}\n\`\`\`` }] }));
	await fenced.start();
	await fenced.input("Fallback task");
	assert.equal(fenced.state.name, "atlas - fix promotion expiry [wip] #a83f91bc");
});

test("AI deadline leaves name unchanged even if the provider ignores abort", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = aiHarness(() => new Promise(() => {}));
	await h.start();
	const input = h.input("Fallback task");
	await new Promise((resolve) => setImmediate(resolve));
	t.mock.timers.tick(30_000);
	await input;
	assert.equal(h.state.name, undefined);
	assert.equal(h.calls[0].request.signal.aborted, true);
});

test("shutdown aborts AI and prevents stale writes; a manual rename wins", async () => {
	for (const change of ["shutdown", "rename"]) {
		let resolve;
		const h = aiHarness(() => new Promise((done) => { resolve = done; }));
		await h.start();
		const input = h.input("Original task");
		await new Promise((done) => setImmediate(done));
		if (change === "shutdown") {
			await h.handlers.get("session_shutdown")({}, h.ctx);
			await input;
			assert.equal(h.calls[0].request.signal.aborted, true);
			assert.equal(h.state.name, undefined);
			assert.equal(h.state.entries.filter((entry) => entry.type === "custom").length, 0);
		} else {
			h.state.name = "Manual wins";
			resolve(aiResponse);
			await input;
			assert.equal(h.state.name, "Manual wins");
		}
	}
});

test("new session: skip greeting, name once, status stays explicit", async () => {
	const h = harness();
	await h.start();
	await h.input("hi");
	assert.equal(h.state.name, undefined);
	await h.input("Fix promotion expiry\nMore details");
	assert.equal(h.state.name, "atlas - Fix promotion expiry [wip] #a83f91bc");
	await h.input("Actually also add tests");
	assert.equal(h.state.name, "atlas - Fix promotion expiry [wip] #a83f91bc");
	await h.command("session-status", "done");
	assert.equal(h.state.name, "atlas - Fix promotion expiry [done] #a83f91bc");
	await h.start("reload");
	await h.input("continue");
	assert.match(h.state.name, /\[done\]/);
	await h.command("session-status", "blocked");
	assert.match(h.state.name, /\[blocked\]/);
	const before = h.state.name;
	await h.command("session-status", "merged");
	assert.equal(h.state.name, before);
});

test("existing sessions are untouched on resume/startup/reload", async () => {
	for (const reason of ["resume", "startup", "reload"]) {
		for (const name of [undefined, "My manual title"]) {
			const h = harness({ name, entries: [user("Original task")] });
			await h.start(reason);
			await h.input("New task");
			assert.equal(h.state.name, name);
		}
	}
	const empty = harness();
	await empty.start("resume");
	await empty.input("Don't rename a resumed empty session");
	assert.equal(empty.state.name, undefined);
});

test("explicit autoname uses active history and allows project/scope override", async () => {
	const h = harness({ entries: [user("Wrong branch")], branch: [user("hello"), user([{ type: "text", text: "Fix expiry" }])] });
	await h.start("resume");
	await h.command("session-autoname");
	assert.equal(h.state.name, "atlas - Fix expiry [wip] #a83f91bc");
	assert.equal(h.state.confirmations.length, 0);
	await h.command("session-autoname", "atlas/promotion - fix timeout");
	assert.equal(h.state.name, "atlas/promotion - fix timeout [wip] #a83f91bc");
	assert.equal(h.state.confirmations.length, 1);
});

test("manual names require confirmation; manual status only edits trailing tag", async () => {
	const h = harness({ name: "Investigate [done] parsing", accept: false });
	await h.start();
	await h.input("Do not rename");
	await h.command("session-autoname", "Replacement");
	assert.equal(h.state.name, "Investigate [done] parsing");
	h.state.accept = true;
	await h.command("session-status", "wip");
	await h.command("session-status", "done");
	assert.equal(h.state.name, "Investigate [done] parsing [done]");
	await h.command("session-autoname", "Replacement");
	assert.equal(h.state.name, "atlas - Replacement [wip] #a83f91bc");
});

test("invalid commands, no history and no confirmation UI cannot overwrite", async () => {
	const h = harness();
	await h.start();
	await h.command("session-autoname");
	await h.command("session-autoname", "project - ");
	await h.command("session-status", "done");
	assert.equal(h.state.name, undefined);
	const headless = harness({ name: "Keep this", ctx: { mode: "print", hasUI: false } });
	await headless.start();
	await headless.command("session-autoname", "Don't overwrite");
	assert.equal(headless.state.name, "Keep this");
});

test("headless and extension-generated input are not auto-named", async () => {
	for (const mode of ["json", "print", "rpc"]) {
		const h = harness({ ctx: { mode } });
		await h.start();
		await h.input("Child agent task");
		assert.equal(h.state.name, undefined);
	}
	const h = harness();
	await h.start();
	await h.input("Injected follow-up", "extension");
	assert.equal(h.state.name, undefined);
	await h.input("/skill:tdd");
	assert.equal(h.state.name, undefined);
	await h.input("/skill:tdd fix checkout");
	assert.equal(h.state.name, "atlas - fix checkout [wip] #a83f91bc");
});

test("missing Git, long prompts and terminal escapes are safe", async () => {
	const h = harness({ exec: async () => { throw new Error("ENOENT"); } });
	await h.start();
	await h.input("\x1b[31mFix [done] \x1b[0m" + "long detail ".repeat(40));
	assert.match(h.state.name, /atlas - Fix done long detail/);
	assert.ok(h.state.name.length < 140);
	assert.ok(!h.state.name.includes("\x1b"));
	assert.equal(h.state.name.match(/\[/g).length, 1);
});

test("manual rename or session shutdown while Git runs wins", async () => {
	for (const change of ["rename", "shutdown"]) {
		let resolve;
		const h = harness({ exec: () => new Promise((done) => { resolve = done; }) });
		await h.start();
		const input = h.input("Original task");
		await Promise.resolve(); // The optional AI fallback yields before Git starts.
		if (change === "rename") h.state.name = "Manual wins";
		else await h.handlers.get("session_shutdown")({}, h.ctx);
		resolve(miss);
		await input;
		assert.equal(h.state.name, change === "rename" ? "Manual wins" : undefined);
	}
});

test("session replacement during confirmation cancels the pending rename", async () => {
	const h = harness({ name: "Original" });
	await h.start();
	h.ctx.ui.confirm = async () => {
		await h.handlers.get("session_shutdown")({}, h.ctx);
		h.state.name = "Different session";
		return true;
	};
	await h.command("session-autoname", "Replacement");
	assert.equal(h.state.name, "Different session");
});

test("forks update generated IDs/status only; manual and unnamed forks survive", async () => {
	const h = harness();
	await h.start();
	await h.input("Fix expiry");
	await h.command("session-status", "done");
	h.state.id = "bbcc1122-other-session";
	await h.start("fork");
	assert.equal(h.state.name, "atlas - Fix expiry [wip] #bbcc1122-other-session");
	h.state.name = "Manual fork";
	h.state.id = "ccdd3344-other-session";
	await h.start("fork");
	assert.equal(h.state.name, "Manual fork");
	const unnamed = harness({ entries: [user("An older task")] });
	await unnamed.start("fork");
	assert.equal(unnamed.state.name, undefined);
});

test("switching to /new resets automatic eligibility", async () => {
	const h = harness({ name: "Existing" });
	await h.start("resume");
	h.state.name = undefined;
	h.state.entries = [];
	h.state.id = "abcd1234-new-session";
	await h.start("new");
	await h.input("Build new feature");
	assert.equal(h.state.name, "atlas - Build new feature [wip] #abcd1234-new-session");
});

test("real Git: short fallback, unborn branch, stable work branch, detached HEAD, no repo", async () => {
	const temp = await mkdtemp(join(tmpdir(), "pi-session-name-"));
	try {
		const repo = join(temp, "project");
		const cwd = join(repo, "api");
		await mkdir(cwd, { recursive: true });
		await execute("git", ["init", "--initial-branch=main", repo]);
		const exec = async (command, args, options) => {
			try {
				const result = await execute(command, args, options);
				return { ...result, code: 0, killed: false };
			} catch (error) {
				return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code, killed: !!error.killed };
			}
		};
		const h = harness({ ctx: { cwd }, exec });
		await h.start();
		await h.input("Fix API timeout");
		assert.equal(h.state.name, "project - Fix API timeout [wip] - project@main #a83f91bc");
		await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: repo });
		await execute("git", ["checkout", "--detach"], { cwd: repo });
		await h.command("session-autoname", "Review detached work");
		assert.match(h.state.name, /project@main #a83f91bc$/); // Preserve the recorded work branch.
		const detached = harness({ ctx: { cwd }, exec });
		await detached.start();
		await detached.input("Review detached work");
		assert.match(detached.state.name, /project@[0-9a-f]+ #a83f91bc$/);
		const outside = harness({ ctx: { cwd: temp }, exec });
		await outside.start();
		await outside.input("Plan a task");
		assert.ok(!outside.state.name.includes("@"));
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("installed Pi loader and real session persistence/resume/fork", async () => {
	const piRoot = process.env.PI_PACKAGE_DIR ?? join((await execute("npm", ["root", "--global"])).stdout.trim(), "@earendil-works/pi-coding-agent");
	assert.ok(existsSync(join(piRoot, "dist/core/extensions/loader.js")), "Set PI_PACKAGE_DIR to your pi-coding-agent package directory if Pi is not in the current global npm prefix.");
	const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
	const { SessionManager } = await import(pathToFileURL(join(piRoot, "dist/core/session-manager.js")).href);
	const temp = await mkdtemp(join(tmpdir(), "pi-session-storage-"));
	try {
		let manager = SessionManager.create(temp, join(temp, "sessions"));
		async function load(reason) {
			const runtime = createExtensionRuntime();
			runtime.getSessionName = () => manager.getSessionName();
			runtime.setSessionName = (name) => manager.appendSessionInfo(name);
			runtime.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
			const loaded = await loadExtensions([extensionFile], temp, undefined, runtime);
			assert.deepEqual(loaded.errors, []);
			const ext = loaded.extensions[0];
			assert.deepEqual([...ext.commands.keys()], ["session-autoname", "session-name-model", "session-status"]);
			const ctx = { cwd: temp, mode: "tui", hasUI: false, sessionManager: manager, model: simpleModel, modelRegistry: simpleRegistry };
			await ext.commands.get("session-name-model").handler("current", ctx);
			assert.deepEqual(JSON.parse(readFileSync(modelConfig, "utf8")), { model: "current" });
			const emit = async (type, data) => {
				for (const handler of ext.handlers.get(type) ?? []) await handler({ type, ...data }, ctx);
			};
			await emit("session_start", { reason });
			return { emit, status: (value) => ext.commands.get("session-status").handler(value, ctx) };
		}
		let loaded = await load("startup");
		await loaded.emit("input", { text: "Fix persistence", source: "interactive" });
		manager.appendMessage({ role: "user", content: "Fix persistence", timestamp: Date.now() });
		await waitFor(() => manager.getSessionName()); // Automatic naming runs in the background.
		await loaded.status("done");
		const originalName = manager.getSessionName();
		const originalId = manager.getSessionId();
		manager = SessionManager.open(manager.getSessionFile());
		loaded = await load("resume");
		await loaded.emit("input", { text: "Do not rename", source: "interactive" });
		assert.equal(manager.getSessionName(), originalName);
		await loaded.status("blocked");
		assert.match(manager.getSessionName(), /\[blocked\]/);
		manager.createBranchedSession(manager.getLeafId());
		await load("fork");
		assert.notEqual(manager.getSessionId(), originalId);
		assert.match(manager.getSessionName(), /\[wip\]/);
		assert.ok(manager.getSessionName().endsWith(`#${manager.getSessionId()}`));
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
