# strip-pi-docs

Pi extension that removes the built-in **Pi documentation** pointer from the system prompt.

By default, every Pi session injects a block like:

```text
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: …
- Additional docs: …
- Examples: …
…
```

That block is useful when hacking on Pi itself, but otherwise burns context every turn. This extension strips it.

## Install

```bash
pi install git:github.com/ZhenHuangLab/strip-pi-docs
```

Or try without installing:

```bash
pi -e git:github.com/ZhenHuangLab/strip-pi-docs
```

## Usage

Stripping is **on by default**. Preference is stored in:

```text
~/.pi/agent/strip-pi-docs.json
```

Slash command:

| Command | Effect |
|---|---|
| `/strip-pi-docs` | Show status (this session + next session) |
| `/strip-pi-docs status` | Same |
| `/strip-pi-docs on` | Enable stripping for **new** sessions |
| `/strip-pi-docs off` | Disable stripping for **new** sessions |
| `/strip-pi-docs toggle` | Flip the pending preference |

**Important:** `/strip-pi-docs on|off|toggle` only updates the saved preference. The current session keeps the setting it had at `session_start`. Start a new session (`/new`, `/clear`, or restart Pi) to apply the change.

## How it works

1. On `session_start`, the extension snapshots `enabled` from the config file.
2. On each `before_agent_start`, if enabled, it removes the Pi documentation block from `event.systemPrompt`.
3. Also matches the Claude Code-rewritten form (`Claude Code documentation…`) used by some Anthropic OAuth extensions.

Custom `--system-prompt` / `SYSTEM.md` prompts never include the default docs block, so there is nothing to strip in that case.

## Config

```json
{
  "enabled": true
}
```

Override the config path with `STRIP_PI_DOCS_CONFIG` (useful for tests).

## License

MIT
