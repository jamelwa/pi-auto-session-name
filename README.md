# Pi Auto Session Name

Semantic session names for [Pi](https://github.com/earendil-works/pi), without overwriting manual titles or confusing the current checkout with the branch that holds the work.

```text
component/domain - concrete task [wip|blocked|done] - repo@work-branch #full-session-id

atlas-api/orders - fix order expiry [wip] - atlas-service@fix/order-expiry #00000000-0000-7000-8000-000000000001
```

Names and identifiers in examples/tests are synthetic.

## Install

Requires Node.js 22.19+ and `@earendil-works/pi-coding-agent`. Tested with Pi 1.1.0. Git is optional at runtime; without it, names omit repository/branch metadata.

```bash
pi install git:github.com/jamelwa/pi-auto-session-name
```

Run `/reload` in an existing Pi terminal. Start a new session to try automatic naming; existing sessions are deliberately not renamed on reload.

If you already installed a standalone copy, disable or remove that copy before loading this package to avoid duplicate commands/hooks. Installing this package does not migrate the standalone copy's model preference; select it again with `/session-name-model`.

To try a local checkout without installing it:

```bash
pi --extension ./index.ts
```

## Commands

| Command | Behavior |
| --- | --- |
| `/session-autoname` | Generate a name from the current session's work context; confirm before replacing an existing title. |
| `/session-autoname component/domain - task` | Supply a label directly, without an AI call. A task alone is also accepted. |
| `/session-autoname [label] --branch branch-name` | Override the title's work branch; never check out or modify Git branches. With no label, still generates the name using AI. |
| `/session-status wip\|blocked\|done` | Change status explicitly, without refreshing the task or branch. |
| `/session-name-model` | Pick the naming model from available models. |
| `/session-name-model provider/model-id` | Pin a model for naming only. |
| `/session-name-model current` | Follow the current chat model (the default). |

Examples:

```text
/session-autoname atlas-consumer/inventory - fix catalog mapping --branch feat/catalog-sync
/session-status blocked
/session-status done
```

Pi's built-in `/name` remains available for fully manual titles. `done` means the session task is complete, not that changes are merged or deployed. Regenerating a name starts at `wip`.

## Behavior

- Only new, unnamed interactive terminal sessions are automatically named, on the first meaningful prompt. Greetings, command-only inputs and extension-generated prompts are skipped.
- Automatic naming runs **in the background**: the first request reaches the model immediately, and the title is applied when the naming call returns. It never blocks the prompt, and a failed or slow naming call simply leaves the session unnamed until you retry.
- Resuming a session or reloading with existing history never auto-renames it. Manual names win, including during a pending AI request. Explicit replacement shows a confirmation preview.
- Names use a stable application/domain and a concrete task, not a filesystem path or the raw first prompt. Recent scope approvals and completion reports take precedence over stale summary progress.
- Repository candidates come from Git at the launch directory and up to eight existing directories explicitly mentioned in the work context. No broad directory crawl. Linked worktrees normalize to their canonical repository.
- Work-branch precedence is an explicit override, a previously recorded branch for the same repository, then an evidenced local branch. AI can only select validated repository/branch pairs. Ambiguous historical branches are omitted, rather than replaced with today's checkout. New sessions can snapshot their launch branch or detached commit when no work-branch evidence exists.
- Forks inheriting an extension-owned title get their new full Pi ID and `wip`; manual fork titles are preserved. Full IDs avoid collisions between UUIDv7 timestamp prefixes.
- Print, JSON and RPC modes do not trigger automatic naming. Replacements without a confirmation-capable UI are refused.
- Invalid output, unavailable models/authentication, truncation and timeouts leave the title unchanged. A failed first automatic attempt leaves the session unnamed: retry explicitly or supply a manual label.

## Naming model and local configuration

Naming uses Pi's existing authentication and `ctx.modelRegistry.streamSimple()`. There is no separate credential store and no added runtime dependency.

Each naming attempt makes one request: **low reasoning**, a requested **4,096-token output budget**, a **30-second deadline**, and **no retries**. Provider capabilities and token accounting may vary. Chat model/thinking settings are never changed.

The model selector is saved in `config.json` beside the installed `index.ts`, shared by sessions using that installation. It is created only after an explicit model selection and is excluded from Git. An unavailable pinned model never silently falls back to a different provider.

## Privacy and cost

The selected naming provider receives up to 6,000 characters of work context (original request, summary excerpt, extracted work locations, recent user clarifications and recent assistant updates), plus title, component, repository path and branch hints. Expanded skill instructions, raw tool output and thinking blocks are excluded. Branch/worktree facts are extracted before truncating summary prose.

**Context is not a secret-redaction system.** User messages and summaries can contain sensitive data, and generated titles appear in session lists. Choose a provider appropriate for your data and keep secrets out of prompts/task labels. Supplying an explicit label avoids the extra naming request.

Available side-call usage is saved as `auto-session-name:usage` session metadata without raw naming prompts/responses. It is **not included in Pi's built-in `/session` cost totals**. An aborted request may incur provider charges without reported usage. Declining a replacement preview does not undo its AI call.

This repository contains no local model preference, credentials, session transcripts or live-preview artifacts.

## Development

With Node.js, Git, npm and Pi installed in the current global npm prefix:

```bash
npm test
```

No dependency installation is needed to run the tests. For a distro/Nix installation or a different npm prefix:

```bash
PI_PACKAGE_DIR=/path/to/pi-coding-agent npm test
```

The 27 tests mock model calls and use isolated extension copies, disposable Git repositories/worktrees and temporary sessions. They cover naming, branch evidence, source/target isolation, model preferences, failure/timeout handling, lifecycle races, confirmation, and real Pi loading/session persistence. They do not call an AI provider or change your real configuration/sessions.

## Remove

```bash
pi remove git:github.com/jamelwa/pi-auto-session-name
```

Then run `/reload`. Saved session names remain intact.

## License

No open-source license has been selected. The package is marked `UNLICENSED` and `private` to prevent accidental npm publication; it remains installable from Git.
