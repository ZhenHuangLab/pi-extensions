# @zhenhuang/pi-apply-patch

[简体中文](README.zh-CN.md)

A Codex-style `apply_patch` tool for Pi 1.2.0 or later. The extension registers the tool when Pi loads it. Pi controls its availability through the session's tool selection and each subagent's allowlist.

## Install

Use one extension that owns the `apply_patch` name. Remove the old package before installing this one:

```sh
pi remove npm:@runminton/pi-apply-patch
pi install npm:@zhenhuang/pi-apply-patch
```

For development, install the workspace directory:

```sh
pi install /path/to/pi-extensions/packages/pi-apply-patch
```

Run `/reload` in an existing session. `/apply-patch-status` reports whether this session has registered and activated the tool. A child already running has its own runtime; start a new child after changing its configuration.

## Subagent configuration

`@gotgenes/pi-subagents` gives each agent a complete tool allowlist. Its default list contains the seven built-in tools. Add `apply_patch` to the `tools:` line of each agent that should edit files:

```yaml
---
tools: read, bash, edit, write, grep, find, ls, apply_patch
prompt_mode: append
---
```

For example, edit `~/.pi/agent/agents/implementer-sol.md`. To configure the built-in general-purpose agent, create `~/.pi/agent/agents/general-purpose.md` with that frontmatter and an empty body. Project definitions in `.pi/agents/` take precedence.

Keep read-only agents' allowlists restricted. The extension respects SDK `tools` and `excludeTools`; it does not add editing permissions. `inherit_context` passes conversation text. Capabilities still come from the child's own configuration.

For an SDK session with an explicit `tools` array, include `"apply_patch"` in that array. Registration alone cannot override an allowlist.

## Input

Pi sends the native Lark grammar to models that support grammar tools. Those calls contain raw patch text. For function tools and codemode, supply `{ "patch": "..." }`. Both interfaces execute the same parser.

```diff
*** Begin Patch
*** Update File: src/example.ts
@@
 export function answer() {
-  return 41;
+  return 42;
 }
*** End Patch
```

The format supports Add File, Delete File, Update File, Move to, `@@` context anchors, and End of File. Read the target first and include enough unchanged lines to identify the edit. Hunk order follows the source file. A hunk containing only additions appends at the end; include context to insert elsewhere.

Paths are literal and resolve from the session's working directory. Absolute paths and `../` are supported, as in Pi's built-in editing tools. The extension runs with Pi's filesystem permissions.

## File behavior

The parser and text update algorithm follow OpenAI Codex revision [`4eb4a65407d98cebc4c83bf13be440b9fbc78a7c`](https://github.com/openai/codex/tree/4eb4a65407d98cebc4c83bf13be440b9fbc78a7c/codex-rs/apply-patch), inspected on 2026-10-16. The package includes the native single-environment Lark grammar. Remote environment dispatch belongs to the host.

Context matching tries exact text, trailing whitespace, both ends' whitespace, then Codex's explicit Unicode punctuation substitutions. Unchanged context retains its actual text and each line's original LF, CRLF, or CR ending. Inserted lines use the first existing line ending. UTF-8 BOMs are preserved. Updates give the final line a terminator, as Codex does.

All parsing, reads, and matching complete before the first file write. Mutations use Pi's per-file queues and exact snapshot comparisons. Add and Move require an absent destination to protect existing files; use Update for existing content. Files must contain valid UTF-8 text. A move writes its destination before removing its source.

Updates through an existing symlink retain the link and edit its target. Deleting or moving a symlink requires naming the target explicitly. Creating a file through a symlinked directory requires its canonical path, because Pi queues missing paths by their spelling. A patch that names two hardlink aliases, or both a file and a child beneath it, is rejected before writing.

An operating-system failure or cancellation during commit can leave some changes applied. The error lists confirmed changes, the failed or uncertain operation, and pending operations. Read those paths before retrying. Multiple filesystem writes are not a transaction, and Pi's queue coordinates only tools in the same process.

Successful results contain a short file summary. Expand the tool result to see diffs. Rendering uses saved results and does not reread files after the edit.

## Lifecycle design

The factory registers one direct, default-active tool. It does not switch tools when the model changes, rewrite the system prompt, or maintain activation state in chat history. Pi selects the input transport from model capability metadata.

Fork, resume, and reload run the factory again. Compaction retains the active runtime. Explicit tool selection remains a host decision, including historical selection restored by `/tree`.

The tool description contains the input contract, one example, and recovery instructions. Two short prompt guidelines cover editing and error recovery. This keeps instructions tied to the active tool and avoids repeated model-specific prompt changes.

See [the investigation](docs/investigation.md) for the original failure and source references.

## Development and license

From the monorepo root:

```sh
npm run check --workspace @zhenhuang/pi-apply-patch
npm pack --workspace @zhenhuang/pi-apply-patch --dry-run --ignore-scripts
```

Apache-2.0. The Codex adaptation and its modifications are identified in [NOTICE](NOTICE); the license is in [LICENSE](LICENSE).
