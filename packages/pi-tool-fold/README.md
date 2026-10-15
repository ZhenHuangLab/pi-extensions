# pi-tool-fold

[![npm version](https://img.shields.io/npm/v/pi-tool-fold?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-tool-fold)
[![npm monthly downloads](https://img.shields.io/npm/dm/pi-tool-fold)](https://www.npmjs.com/package/pi-tool-fold)
[![GitHub tag](https://img.shields.io/github/v/tag/ZhenHuangLab/pi-tool-fold)](https://github.com/ZhenHuangLab/pi-tool-fold/tags)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Fold completed tool calls in the pi transcript into a single line:

```
▌ 帮我重构一下 auth 模块

  ⋯ Pondered for 1m 04s · 13 tools

重构完成，测试通过。
```

Press the shortcut again and everything comes back, byte for byte. This is a
rendering change only — the session file, the LLM context, and tool state are
never touched, so it is safe to toggle at any point, including mid-turn.

## Install

```bash
pi install npm:pi-tool-fold
```

## Usage

| | |
|---|---|
| `ctrl+e` | fold / unfold (configurable) |
| `/tool-fold` | same toggle |
| `/tool-fold on` \| `off` | set explicitly |
| `/tool-fold turn` \| `block` | switch aggregation mode (also folds) |

The toggle state is persisted, so the view you left in is the view you come back
to.

## Modes

**`turn`** (default) — everything between two user messages folds into one line,
and the intermediate assistant messages (the ones that exist only to carry tool
calls) are hidden with it. Only your prompt and the final reply remain.

```
▌ 帮我重构一下 auth 模块

  ⋯ Worked for 1m 16s · 13 tools

重构完成，测试通过。
```

**`block`** — each assistant step's batch of tool calls folds into its own line,
and the assistant's narration between steps stays visible. The durations chain
up: consecutive lines partition the turn's wall-clock time.

```
▌ 帮我重构一下 auth 模块

我先看一下现有实现。

  ⋯ Pondered for 12s · 4 tools

找到了三处重复逻辑，开始改。

  ⋯ Wrangled for 1m 04s · 9 tools

重构完成，测试通过。
```

## While the agent is working

Only tool calls that actually returned fold. Whatever is running right now keeps
rendering in full, as does the assistant message that is currently streaming.
Toggling mid-turn therefore folds the completed history and leaves the live work
on screen, and the fold line's duration grows as more calls complete.

A call cut short by an abort or an error never returns, so it never folds: its
`Operation aborted` notice stays on screen next to the fold line. Assistant
messages that stopped for any reason other than a clean handoff to tools stay
visible in `turn` mode for the same reason. A fold line never swallows a
failure.

## Duration

`turn` mode measures from your prompt to the last completed tool call in the
turn. `block` mode measures from the moment the request went out to the model to
the last completed call of that step — so it covers generation *and* tool
execution, and consecutive blocks tile the turn without gaps or overlap.

## Configuration

`~/.pi/agent/pi-tool-fold.json`, written with defaults on first run:

```jsonc
{
  "shortcut": "ctrl+e",   // any pi keybinding, see pi's docs/keybindings.md
  "mode": "turn",         // "turn" | "block"
  "collapsed": false,     // persisted toggle state
  "verbs": ["Worked", "Pondered", "Solved", "..."]
}
```

The verb is picked from `verbs` by hashing the group, so a given fold line keeps
its verb across re-renders, width changes, and restarts. Edit the list to taste.

Run `/reload` after editing the file.

`ctrl+e` is also pi's built-in `tui.editor.cursorLineEnd`. Extension shortcuts
take precedence, so pi prints one conflict warning at startup and this binding
wins; `end` and `ctrl+end` still move the cursor to end of line. Set `shortcut`
to something else to leave the emacs binding alone.

## Cost

Measured on a synthetic 5,401-entry session with 4,001 tool components, timing a
full-transcript render pass:

| | lines | ms/frame |
|---|---|---|
| stock pi | 16,004 | 2.44 |
| patched, folding off | 16,004 | 2.66 |
| folded, `block` | 2,004 | 0.48 |
| folded, `turn` | 404 | 0.45 |

Folding off is within run-to-run noise of stock pi: the patch is one boolean
read per component per frame. Folding on is roughly 5× *cheaper* than not
folding, because a folded component skips markdown, syntax highlighting, and
diff rendering entirely.

Toggling costs one 5.7 ms frame on that session, to rebuild the fold plan. The
plan is cached and keyed on the branch leaf, so appends and every subsequent
frame reuse it.

## How it works

pi builds the transcript from `ToolExecutionComponent` and
`AssistantMessageComponent` instances it owns, so the only seam is their
`render` method — both classes are part of the package's public API. The patch
returns an empty array for a folded component, or one summary line for the first
call of a group.

Ordering and timing come from `sessionManager.buildContextEntries()`, which is
also what pi renders the transcript from. A tool call that is not in that plan —
still running, aborted, or older than the rendered context window — always
renders normally, so nothing can disappear without a summary standing in for it.

## Maintainer releases

For one-time setup, open the npm package's **Settings → Trusted Publisher → GitHub Actions**.
Set owner to `ZhenHuangLab`, repository to `pi-tool-fold`, and workflow
filename to `publish.yml`. Leave environment blank. You must enable
**Allow npm publish**; the default may allow only staging. Publishing uses OIDC
without a stored npm token.

Update the version in `package.json` and any tracked lockfile, then push the
commit and matching `v<version>` tag. Publish a GitHub Release for that tag to
run the workflow; pushing the tag alone does not trigger it. Prereleases publish
to `next`; stable releases publish to `latest`. Do not move old tags.
