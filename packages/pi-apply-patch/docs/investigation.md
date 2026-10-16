# apply_patch availability investigation

Inspected on 2026-10-16: Pi 1.2.0, `@gotgenes/pi-subagents` 23.4.2, and `@runminton/pi-apply-patch` 0.1.0. Findings refer to those installed versions.

## Observed failure

The referenced parent session successfully called `apply_patch`. Its child reported that it had `edit` and `write`, but no `apply_patch`. A fresh Sol investigation child reproduced the missing declaration: its initial system entry listed `read,bash,write,grep,find,ls,ask_parent,notify_parent,edit`.

The local `implementer-sol.md` originally listed the seven built-ins. After adding `apply_patch` to that list, the next Sol child received the tool. This establishes the admission failure independently of patch parsing.

## Control flow

1. `pi-subagents/src/lifecycle/create-subagent-session.ts:287–301` passes the agent's tool names as an explicit SDK `tools` allowlist. Its default general-purpose list also contains only built-ins (`src/config/agent-types.ts:94–102,134–135`).
2. Pi's `dist/core/agent-session.js:2840–2896` filters extension registrations through `_isAllowedTool` before constructing the configured registry. A filtered tool is absent from `getAllTools`, as well as the active set.
3. `setActiveTools` selects names from that registry (`agent-session.js:1097–1129`). It cannot admit a filtered name.
4. The old plugin's `unified-edit.ts:2160–2182` chooses `apply_patch` only for `openai-responses` and `openai-codex-responses`. Its `session_start` and `model_select` handlers remove both editor names from the requested selection, then attempt to activate one. An OpenAI child whose allowlist excludes `apply_patch` cannot activate the requested tool. Later registry rebuilds can activate allowlisted tools such as `edit` again.
5. `inherit_context` formats user and assistant text plus compaction summaries (`pi-subagents/src/session/context.ts:34–76`). It does not transfer the parent's tool registry.

The old plugin also uses the freeform-only instruction “do not wrap the patch in JSON” as its description for function-tool calls. Pi can supply either transport. The replacement description explains each transport explicitly.

## Lifecycle distinctions

Pi's `dist/core/agent-session-runtime.js:102–249` tears down and recreates the runtime for new, fork, and resume operations. The new runtime runs extension factories again.

Reload rebuilds registered tools using the current active names and default-active extension registrations (`agent-session.js:2968–2991`). Its `session_start` event depends on installed host bindings (`2992–3001`). A child binds extensions with an empty binding object. A registration that depends only on that event is therefore fragile.

Compaction retains the live registry. It records current system and tool declarations in its checkpoint (`dist/core/session-manager.js:880–901`) and refreshes messages (`agent-session.js:2267–2283,2556–2572`). The inspected compaction path contains no tool-removal step. The original transcript does not establish a separate compact-only failure.

Tree navigation explicitly restores allowed historical declarations (`agent-session.js:1373–1381,3374–3383`). An inactive tool after `/tree` can reflect that selection.

## Resolution

The replacement registers a direct, default-active `apply_patch` in the factory and leaves capability selection to Pi. It uses Pi's native grammar support and one function schema. It has no model-selection or session-start activation hook.

Writable agents explicitly admit the tool. Read-only agents keep their allowlists. The old package must be removed from the load configuration: Pi takes the first extension registration for a duplicate name (`dist/core/extensions/runner.js:410–422`), and both packages' event handlers would still run.

This package ports the current Codex text-update algorithm rather than retaining the old extension's alternative row-script language. The grammar is copied from `codex-rs/core/assets/tools/apply_patch.lark`; provenance is in `NOTICE`.

## Verification of 0.1.0

The parent ran verification after implementation and review. These repository commands passed:

```sh
cd /home/zhenh/dev/pi-extensions
npm run check
PI_CONTEXT_LIVE=0 npm test
npm pack --workspace @zhenhuang/pi-apply-patch --dry-run --ignore-scripts
```

The first typecheck found missing explicit tool-result type parameters in the registration. Adding `registerTool<typeof patchParameters, PatchDetails>` resolved the error; the complete check then passed. Live provider cases remained disabled by `PI_CONTEXT_LIVE=0`.

Temporary filesystem assertions covered mixed line endings, BOM and actual Unicode context preservation, ordered appends, EOF cursor bounds, an update with 180,000 unchanged lines, all four file operations, repeated targets, executable move permissions, preflight failures, invalid UTF-8, cancellation, symlink updates, hardlink rejection, and concurrent patches acquiring shared paths in opposite orders. A real permission error on the second of three writes confirmed the completed/failed/pending report.

Separate offline checks loaded the package through Pi 1.2.0's actual resource loader and exercised its wrapped tool. They verified native custom-tool grammar and function-tool schemas, failed-result flags, model changes, reload with empty child bindings, manual compaction, runtime fork/new, saved-session resume, explicit child allowlists, and exclusions. The compaction check supplied its summary through Pi's supported extension hook. Test-only runtime credentials stayed inside the isolated setup, and network requests were blocked. Initial fixture setup needed explicit direct-provider selection and sufficient recent context for Pi to form a compaction cut; those setup failures did not require product changes.

No test files were added. The temporary directories were removed after the checks.
