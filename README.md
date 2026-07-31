<h1 align="center"><code>pi-xai-search</code></h1>

<p align="center"><strong>Live X search for Pi</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zhenhuang/pi-xai-search"><img alt="npm version" src="https://img.shields.io/npm/v/%40zhenhuang%2Fpi-xai-search?color=cb3837&amp;logo=npm"></a>
  <a href="https://github.com/ZhenHuangLab/pi-xai-search/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ZhenHuangLab/pi-xai-search/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-339933?logo=node.js&amp;logoColor=white"></a>
  <a href="https://github.com/earendil-works/pi-mono"><img alt="Pi 0.83.0 or newer" src="https://img.shields.io/badge/Pi-%E2%89%A50.83.0-7c3aed"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#authentication">Authentication</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#faq">FAQ</a>
</p>

---

`pi-xai-search` adds one focused tool to [Pi](https://github.com/earendil-works/pi-mono): **`xai_search`**. It asks an xAI model to search live X (formerly Twitter) through xAI's native server-side `x_search` capability and returns a readable answer with citations.

Your main Pi session can keep using Claude, GPT, Gemini, or any other model. The search itself runs separately with **Grok 4.5 by default**, and its model can be changed without restarting Pi.

## Why choose `pi-xai-search`?

- **Model-independent** — use live X search without switching your active Pi model.
- **Native X access** — uses xAI's `x_search`, not generic web scraping or `site:x.com` queries.
- **No duplicate OAuth stack** — credentials and token refresh stay inside Pi's built-in `xai` provider.
- **Focused and predictable** — one package, one tool, no provider overrides or hidden agent hooks.
- **Fresh citations** — responses include the X URLs returned by xAI.
- **Privacy-conscious defaults** — requests set `store: false`, and the extension never reads or writes Pi's credential files.

## Features

- Live X keyword and semantic search through xAI
- Default nested model: `grok-4.5`
- Floating `/xai-search config` model picker with fuzzy search and immediate hot reload
- Live model discovery from xAI's `/models` endpoint using Pi-resolved credentials
- Per-call xAI model override
- Inclusive UTC date filtering with `from_date` and `to_date`
- Allow or exclude up to 20 X handles per search
- Optional image and X-video understanding
- Pi-managed OAuth and API-key resolution
- Automatic OAuth refresh through Pi's credential store
- Cancellation and five-minute request timeout
- Compact API errors and standard Pi output truncation
- Safe coexistence with broader packages such as `pi-xai`

## Installation

### npm (recommended)

```bash
pi install npm:@zhenhuang/pi-xai-search
```

### GitHub

```bash
pi install git:github.com/ZhenHuangLab/pi-xai-search
```

### Local development checkout

```bash
git clone https://github.com/ZhenHuangLab/pi-xai-search.git
pi install /absolute/path/to/pi-xai-search
```

Restart Pi or run `/reload` after installing the package into an existing session.

## Authentication

The extension deliberately does **not** implement its own login flow. It asks Pi's built-in `xai` provider for resolved request credentials.

### Grok / X subscription

Inside Pi, run:

```text
/login xai
```

Follow the browser/device authorization flow. Pi stores and refreshes the resulting OAuth credential.

### xAI API key

Alternatively, export an API key before starting Pi:

```bash
export XAI_API_KEY="your-xai-api-key"
```

> [!IMPORTANT]
> `pi-xai-search` never opens `~/.pi/agent/auth.json` itself and never logs, copies, or returns your token. Authentication is resolved through Pi's public `modelRegistry` API.

The same resolved OAuth token or API key is used to fetch the model catalogue when the configuration menu opens.

## Configuration

Run this command in Pi's interactive TUI:

```text
/xai-search config
```

It opens a centered floating model picker. Type to fuzzy-search models, use Up/Down to navigate, press Enter to select, or Escape to cancel. The catalogue is fetched live from xAI's `GET /v1/models` endpoint using your `/login xai` OAuth session (or `XAI_API_KEY`).

A selection is applied to the next `xai_search` call immediately—no `/reload` or restart is needed—and is persisted to:

```text
~/.pi/agent/pi-xai-search.json
```

The initial configuration is:

```json
{
  "model": "grok-4.5"
}
```

A per-call `model` argument still takes precedence without changing the persisted default.

## Usage

Ask naturally. The active model will call `xai_search` when live X data is useful:

```text
What are developers on X saying about the latest xAI release?
```

```text
Search X for reactions to Pi from the last week and summarize the main themes.
```

```text
Find recent primary-source posts about Grok 4.5 and include links.
```

The exposed tool schema supports both simple searches and xAI's advanced X-search controls:

| Parameter                    |              Type | Required | Description                                                    |
| ---------------------------- | ----------------: | :------: | -------------------------------------------------------------- |
| `query`                      |            string |   Yes    | The question or topic to search on X                           |
| `model`                      |            string |    No    | Per-call xAI model override; otherwise uses the configured one |
| `from_date`                  |      `YYYY-MM-DD` |    No    | Include posts on or after this UTC date                        |
| `to_date`                    |      `YYYY-MM-DD` |    No    | Include posts on or before this UTC date                       |
| `allowed_x_handles`          | `string[]` (≤ 20) |    No    | Only consider posts from these handles                         |
| `excluded_x_handles`         | `string[]` (≤ 20) |    No    | Exclude posts from these handles                               |
| `enable_image_understanding` |           boolean |    No    | Let xAI analyze images encountered in X posts                  |
| `enable_video_understanding` |           boolean |    No    | Let xAI analyze videos encountered in X posts                  |

`allowed_x_handles` and `excluded_x_handles` are mutually exclusive. Handles may be written with or without a leading `@`. Media understanding can incur additional xAI token usage.

Example tool input:

```json
{
  "query": "What are people saying about Grok 4.5?",
  "from_date": "2026-07-01",
  "to_date": "2026-07-31"
}
```

Restrict a search and enable media understanding when needed:

```json
{
  "query": "Summarize recent product demos from the xAI team",
  "allowed_x_handles": ["xai", "@grok"],
  "enable_image_understanding": true,
  "enable_video_understanding": true
}
```

Override the configured nested model for one call:

```json
{
  "query": "Summarize the latest xAI research discussion on X",
  "model": "grok-4.5"
}
```

## How it works

```text
Your active Pi model (Claude / GPT / Gemini / Grok / ...)
                         │
                         │ calls xai_search
                         ▼
        Pi modelRegistry.getProviderAuth("xai")
                         │
                         │ resolved OAuth or XAI_API_KEY
                         ▼
             POST https://api.x.ai/v1/responses
               model: configured model (grok-4.5 initially)
               tools: [{ type: "x_search" }]
               store: false
                         │
                         ▼
          Answer + live X citations returned to Pi
```

The extension never reads `ctx.model` to select the search model. Changing `/model` in the main session therefore does not alter the nested xAI request. `/xai-search config` separately fetches `GET /v1/models`, saves the chosen ID, and updates the in-memory default immediately.

## Comparison

| Capability                         | `pi-xai-search` | Agentic `x_search` | Broad xAI integration packages |
| ---------------------------------- | :-------------: | :----------------: | :----------------------------: |
| Works with a non-Grok active model |       ✅        |     Usually no     |             Varies             |
| Separate configurable search model |       ✅        |         No         |             Varies             |
| Uses Pi's built-in `/login xai`    |       ✅        | Provider-dependent |             Varies             |
| Registers or overrides a provider  |       No        |         No         |             Often              |
| Scope                              |  X search only  |  Main-model tool   |     Multiple xAI features      |

Use `pi-xai-search` when you want one portable X-search tool without changing how the rest of your Pi session is configured.

## Requirements

- Pi `>= 0.83.0`
- Node.js `>= 22.19.0`
- One of:
  - a successful `/login xai`, or
  - `XAI_API_KEY`
- An xAI account/plan entitled to the selected model and `x_search`

## Troubleshooting

### `No xAI credentials found`

Run `/login xai` in Pi, or launch Pi with `XAI_API_KEY` set.

### `Could not resolve xAI credentials`

The stored OAuth token could not be refreshed. Run `/login xai` again.

### HTTP 401 or 403

Re-authenticate with `/login xai`. A 403 can also mean that the account is not entitled to the selected model or search capability.

### Model not found or unsupported

Run `/xai-search config` and choose a model available to the current xAI credential. Model availability and `x_search` entitlement are controlled by xAI and may vary by account. Delete `~/.pi/agent/pi-xai-search.json` to return to `grok-4.5`.

### The tool does not appear

Run `/reload` or restart Pi, then verify installation with:

```bash
pi list
```

## FAQ

<details>
<summary><strong>Does my active Pi model need to be Grok?</strong></summary>

No. That is the main purpose of this extension. The active model only decides when to call the client-side tool; `xai_search` sends a separate request to xAI.

</details>

<details>
<summary><strong>Does this package depend on <code>pi-xai</code>?</strong></summary>

No. It uses Pi's built-in `xai` provider. Other xAI packages may be installed alongside it, but none are required.

</details>

<details>
<summary><strong>Why not use the active model's built-in search?</strong></summary>

That ties search availability and model choice to the active provider. `xai_search` remains available when the main session uses another model and keeps the nested xAI model explicit.

</details>

<details>
<summary><strong>Can I restrict search to specific X accounts?</strong></summary>

Yes. Pass up to 20 handles in either `allowed_x_handles` or `excluded_x_handles`. The two filters cannot be combined in one request.

</details>

## Development

```bash
git clone https://github.com/ZhenHuangLab/pi-xai-search.git
cd pi-xai-search
npm install
npm run check
```

Useful commands:

| Command             | Purpose                                    |
| ------------------- | ------------------------------------------ |
| `npm test`          | Run the Vitest suite                       |
| `npm run typecheck` | Run strict TypeScript checks               |
| `npm run lint`      | Run Oxlint                                 |
| `npm run format`    | Format with Oxfmt                          |
| `npm run check`     | Run formatting, lint, typecheck, and tests |

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security reports should follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

© 2026 ZhenHuangLab
