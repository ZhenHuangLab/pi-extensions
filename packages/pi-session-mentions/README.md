# pi-session-mentions

[简体中文](README.zh-CN.md)

Reference local Pi, Claude Code, and Codex conversations in a Pi message.

Type `@@` for recent sessions, then type a keyword to filter. Select a result with
the arrow keys and Tab or Enter, then send your message as usual. For several
keywords, use quotes: `@@"build cache"`.

It adds model context only when you send a selected reference.

The ordinary `@` file menu has one **Sessions** entry that inserts `@@`. Session
results have their own menu, with up to eight rows showing the title, agent,
project, and date. File results keep their order.

## Install

Requires Pi 1.2.0 or later and Node.js 22.19.0 or later. Install from npm:

```sh
pi install npm:pi-session-mentions
```

Run `/reload` in an existing Pi session. This is a personal installation, so the
extension works across projects. It has no runtime dependencies outside Pi and
Node.js, and does not require `ah`.

## Search

Search matches titles, user messages, project paths, and session IDs. Matching
ignores case and supports Chinese text. All query words must match. Title matches
come first, followed by the current project and recent activity. The current
session and subagent sessions are excluded.

Assistant messages, tool output, and thinking are not indexed. This keeps the
index smaller and avoids matches on generated text.

The index loads in a background worker and caches unchanged files. Typing searches
the in-memory index. Files refresh periodically when you search, rather than on
each keystroke. The first scan can take time for a large history; recent sessions
become available as they are indexed. There are no model calls or embeddings.

| Agent | Default session location | Environment override |
| --- | --- | --- |
| Pi | `~/.pi/agent/sessions/` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` |
| Claude Code | `~/.claude/projects/` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/sessions/`, `~/.codex/archived_sessions/` | `CODEX_HOME` |

Pi's current session directory is also included when using a custom directory.
There is no settings screen or extra command.

## What gets sent

Selecting a session inserts a short reference containing its title. On submission,
the extension replaces it with a numbered reference and adds its agent, project,
original path, and a local transcript path. Multiple references to the same
session share one attachment.

The transcript contains `user:` and `assistant:` text with source information.
It omits tool calls, tool results, images, system instructions, and thinking.
The original session stays unchanged. Each export is a snapshot, so a later edit
to the original does not change a reference that was already sent.

Only the reference and paths enter the initial model context. The model can read
the transcript as needed using its file tool. This reduces the initial token
cost; reading the conversation still uses tokens. The model needs a local file
reader to use the reference.

References inside fenced or inline code and references escaped with `\` are left
as text. An unavailable source is explicitly reported in the sent message.
Existing image attachments are preserved.

Pi exports follow the latest recorded branch. Claude Code exports follow parent
links, and Codex exports apply recorded rollbacks. If a branch ancestor is missing,
the transcript explicitly marks the available history as incomplete. A file that
changes during export must be selected again after its current write finishes.

## Local data

The search cache lives in `~/.pi/agent/session-mentions/`, or under
`PI_CODING_AGENT_DIR`. Transcript snapshots are written to
`/tmp/pi-sessions-mentions/`. Both contain private conversation text and use
private directory and file permissions. No data is sent to a separate search
service. Referenced text can reach the model provider when the model reads it;
this is not secret redaction.

Each submitted session reference generates a fresh transcript. Multiple references
to the same session in one message share one snapshot. Deleting the search cache
causes it to be rebuilt. Deleting the temporary snapshots, including during system
cleanup, makes their paths in older messages unreadable. Selecting and sending a
session again creates a new snapshot. Original sessions are never modified.

## Development

From the repository root:

```sh
npm install
npm run check --workspace pi-session-mentions
```

MIT; see [LICENSE](LICENSE).
