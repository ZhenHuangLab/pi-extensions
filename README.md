# strip-pi-docs

[![npm version](https://img.shields.io/npm/v/strip-pi-docs)](https://www.npmjs.com/package/strip-pi-docs)
[![npm downloads per month](https://img.shields.io/npm/dm/strip-pi-docs)](https://www.npmjs.com/package/strip-pi-docs)
[![GitHub tag](https://img.shields.io/github/v/tag/ZhenHuangLab/strip-pi-docs)](https://github.com/ZhenHuangLab/strip-pi-docs/tags)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

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
pi install npm:strip-pi-docs
```

Or try without installing:

```bash
pi -e npm:strip-pi-docs
```

Requires Pi 1.2.0 or later and Node.js 22.19.0 or later.

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
2. On each `before_agent_start`, if enabled, it replaces `event.systemPromptOptions.sections.docs` with a newline. Pi rebuilds the system prompt with an empty documentation section.

Forced system prompts are left unchanged. Custom prompts without a documentation section are also left unchanged.

## Config

```json
{
  "enabled": true
}
```

Override the config path with `STRIP_PI_DOCS_CONFIG` (useful for tests).

## Maintainer releases

Automatic publication requires one-time authorization on npm. In this package's
**Settings → Trusted Publisher → GitHub Actions**, set owner to `ZhenHuangLab`, repository to
`strip-pi-docs`, workflow filename to `publish.yml` (filename only), and leave environment blank.
Enable **Allow npm publish**; npm may otherwise allow staged publication only. The workflow uses
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no stored npm token
is needed.

Update the version in `package.json`, then push the commit and matching `v<version>` tag and publish
a GitHub Release for that tag. Publishing the GitHub Release triggers npm publication; a tag push
alone does not. GitHub prereleases and versions with a SemVer prerelease suffix publish to `next`;
stable releases publish to `latest`.

## License

MIT
