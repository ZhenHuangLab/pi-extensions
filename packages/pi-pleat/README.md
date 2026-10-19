<h1 align="center">pi-pleat</h1>

<p align="center">
  Context management for <a href="https://github.com/earendil-works/pi">Pi</a>: clears old tool output,
  lets the model recall it, and uses the provider's native compaction where it exists.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-pleat"><img src="https://img.shields.io/npm/v/pi-pleat" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-pleat"><img src="https://img.shields.io/npm/dm/pi-pleat" alt="npm downloads per month"></a>
  <a href="https://github.com/ZhenHuangLab/pi-extensions/tags"><img src="https://img.shields.io/github/v/tag/ZhenHuangLab/pi-extensions?filter=pi-pleat%40*" alt="GitHub tag"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Pi-1.2.0-2DF9C0" alt="Tested with Pi 1.2.0">
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

pi-pleat keeps long Pi sessions inside the model's context window. Old tool results leave the
context but stay in the session file. The `recall` tool retrieves original tool results and text from
user/assistant messages covered by compaction. When the
context reaches the compaction threshold, pi-pleat uses native compaction on Anthropic and OpenAI
Responses channels, including custom channels you enable, and a text summary on other channels. It never removes thinking itself. On Anthropic,
the thinking in the turns kept after a native compaction stays usable; the live check confirmed this
under strict prefix binding. The model sees one extra tool; nothing is added to the system prompt.

## Install

```sh
pi install npm:pi-pleat
```

To install from a local clone instead:

```sh
git clone https://github.com/ZhenHuangLab/pi-extensions.git
pi install ./pi-extensions/packages/pi-pleat
```

pi-pleat is developed and tested with Pi 1.2.0. It needs no settings.

## How it works

| Provider | Old tool results | Compaction |
|---|---|---|
| Anthropic (`anthropic`) | Cleared by Anthropic's server-side context editing; all thinking is kept | Native compaction with the session model; the signed compaction block replaces the summarized history |
| OpenAI Codex (`openai-codex`) and OpenAI (`openai`, Responses API) | Kept by default; local clearing is optional | The Responses `compaction_trigger` item, as sent by the official Codex client; the encrypted compaction item and the user messages replace the summarized history |
| Custom channels in `responsesTriggerChannels` | Kept by default; local clearing is optional | The same Responses `compaction_trigger` protocol, through the channel's registered adapter |
| Other providers | Kept by default; local clearing is optional | Pi's compaction, or a summary written by the fallback model |

On Anthropic, pi-pleat compacts at the end of a turn when the history before server-side clearing
exceeds the threshold, because a compaction request cannot use clearing. It compacts exactly the
last request that was sent, and the reply to that request becomes the first kept message, right
after the compaction block, so the thinking in that reply is still accepted. Before each later
request, including after a restart, it checks the summary, the kept reply, the system prompt and the
tools; if one of them changed, the request carries the summary as text instead.

On the OpenAI channels and configured Responses-trigger channels, compaction starts when Pi's own threshold is reached or you run `/compact`.
pi-pleat sends the history before Pi's cut point with a `compaction_trigger` item, reads the whole
response, and keeps the text user messages (up to 64,000 tokens) and the compaction item. It sends
the encrypted item only to the same provider, API, endpoint and model, so it also writes a readable
summary with the fallback model at the same time. A user message with an image, or `/compact` with
instructions, uses a text summary instead.

Anthropic uses server-side clearing. Other channels keep tool results until compaction by default.
Set `pi-pleat.clearing.localEnabled: true` to enable local clearing. When enabled, it starts when the
context is larger than half of the compaction threshold and replaces the oldest tool results of
1 KB or more with a note such as
`[Output cleared to save context (48.0KB). recall id="c3d4e5f6"]`, keeps the results of the last
eight tool calls, and acts only when a batch frees at least a tenth of the threshold. Results that
are followed by Claude thinking on the branch are left alone, because editing them would invalidate
that thinking. Anthropic's server-side clearing uses the same trigger, the same eight calls and the
same minimum batch.

When native compaction is unavailable, cannot be shown to be safe, or still fails after retries,
pi-pleat writes a text summary in Pi's format or lets Pi compact as usual, and shows the reason. A
text summary can make the kept Claude thinking unusable. An authorization error or an incomplete
response skips the compaction and keeps the history unchanged. pi-pleat also discards a result, and
keeps the history, when the next request after compaction would not fit the model's window with a
margin of 4,096 tokens.

## The `recall` tool

The model sees this description:

```text
Get original tool results or text from compacted user/assistant messages on this branch.
Pass `id` (entry or tool call ID), or `query` (command, path, tool name, or text) for the newest match.
```

`id` takes a session entry id or a tool call id. `query` searches tool names, arguments, original
outputs and the visible text of user/assistant messages covered by the latest compaction. It searches
only the current branch, returns the newest match, and lists the ids of up to five other matches.
Covered messages remain searchable after repeated compactions and a restart; current prompts and
new replies are outside the chat search range. Chat results identify the original role and contain
only visible text. Thinking, signatures, system instructions and encrypted state are excluded. The result starts with a source line such as
`[c3d4e5f6 · bash "npm test" · 48.0KB]`, followed by the output exactly as the session saved it,
including results that a native compaction or text summary covered. Chat headers use `user` or
`assistant` in place of the tool name. If Pi saved only part of the original output, the
source line says so and reports whether the full output file still exists.

Output over 2,000 lines or 50 KB is written to a temporary file, and the tool returns the start of it
and the file path for `read`. On Anthropic the server's placeholder has no recall id, so the model
passes the command or path of the kept tool call as `query`. Recall never re-runs a command.

## Commands

| Command | |
|---|---|
| `/context` | context usage and thresholds, the selected compaction method, clearing and compaction counts with their usage and cost (unknown or partial when a provider did not report usage), native replay state, provider capabilities, recall calls, thinking the provider reported as dropped, the fallback model, and recent notices |
| `/context fallback` | show the fallback model |
| `/context fallback <provider/model> [level]` | use this model, and optionally this thinking level (`off` to `max`), for this session |
| `/context fallback default` | remove the session choice |

## Settings

pi-pleat reads Pi's `compaction` settings. `reserveTokens` and `keepRecentTokens` each resolve from
`compaction.modelOverrides` to `compaction` to Pi's defaults (16,384 and 20,000 tokens).
`compaction.enabled: false` turns off automatic compaction; clearing and `/compact` still work.
Invalid compaction token values, which Pi reports as errors, show a pi-pleat warning that names the
value it uses.

Set per-model compaction values in Pi's `compaction.modelOverrides`, and optional pi-pleat settings
under `pi-pleat` in Pi's `settings.json`
(`~/.pi/agent/settings.json`, or `.pi/settings.json` in a trusted project):

```json
{
  "compaction": {
    "modelOverrides": {
      "anthropic/claude-sonnet-5-5": { "reserveTokens": 32768 }
    }
  },
  "pi-pleat": {
    "fallbackModel": "anthropic/claude-haiku-5-5",
    "fallbackThinking": "off",
    "responsesTriggerChannels": [
      { "provider": "cliproxyapi", "api": "cliproxyapi-codex-responses" }
    ],
    "clearing": {
      "localEnabled": false,
      "triggerRatio": 0.5,
      "floorRatio": 0.1,
      "keepToolUses": 8,
      "minBytes": 1024,
      "modelOverrides": {
        "anthropic/claude-sonnet-5-5": { "triggerRatio": 0.3, "keepToolUses": 4 }
      }
    }
  }
}
```

`responsesTriggerChannels` defaults to an empty array and adds custom provider/API pairs to the built-in
`openai-codex`/`openai-codex-responses` and `openai`/`openai-responses` channels. Copy the provider and API
from the first line of `/context`. Matching is exact and case-sensitive; a pair applies to every model
on that provider/API. Each entry must contain only nonempty `provider` and `api` strings. Invalid entries
warn and are ignored individually; a non-array value ignores the custom list. Built-in channels remain
enabled, and Anthropic keeps its own native compaction route.

Add a pair when its adapter and endpoint support the Responses `compaction_trigger` protocol. Requests
use the selected model's registered adapter, endpoint and credentials. Native replay still requires
the same provider, API, endpoint and model. `/context` shows the selected compaction method and reports
the summary route when the provider has returned an unsupported capability. This setting selects
compaction; clearing uses its own settings and thresholds.

Both override maps use exact `provider/modelId` keys, including case; model ids can contain slashes.
Each clearing field resolves from the matching model override to `pi-pleat.clearing` to its default.
All five fields are optional, including inside an override:

| Field under `pi-pleat.clearing` | Default | Valid values | Purpose |
|---|---|---|---|
| `localEnabled` | `false` | Boolean | Enable local clearing on non-Anthropic channels; Anthropic uses server-side clearing |
| `triggerRatio` | `0.5` | Finite number, `0 < x <= 1` | Start clearing above this fraction of T |
| `floorRatio` | `0.1` | Finite number, `0 <= x < 1`, less than `triggerRatio` | Minimum tokens freed per batch, as a fraction of T |
| `keepToolUses` | `8` | Safe integer, `x >= 1` | Keep the newest tool calls and their results |
| `minBytes` | `1024` | Safe integer, `x >= 0` | Minimum result size for local clearing on non-Anthropic channels |

Both ratios use `T = max(0, contextWindow - reserveTokens)` for that model's window and resolved
reserve. The clearing trigger and floor are rounded to tokens, with a minimum of 1. Anthropic ignores
result size; `minBytes` only affects local clearing.

Invalid ordinary clearing values warn and use defaults. If the ordinary `floorRatio >= triggerRatio`,
both ratios use their defaults with one warning. Invalid override fields warn and keep the resolved
ordinary or default value; the warning names that value. If an override makes `floorRatio >= triggerRatio`,
both ratios return to the resolved ordinary pair with one warning; other override fields still apply.
A non-object `pi-pleat` or `pi-pleat.clearing` uses all clearing defaults with a warning. A non-object
clearing `modelOverrides` or matching entry warns and is ignored. Unknown keys in ordinary clearing
settings or a matching override warn and are ignored; non-matching entries are not validated.
Warnings appear once per session and stay in `/context`'s recent notices. According to
[Anthropic's context editing docs](https://platform.claude.com/docs/en/build-with-claude/context-editing),
a lower floor clears more often and rewrites the prompt cache more often.

The fallback model writes the text summaries and the readable summaries on Responses-trigger channels.
`fallbackThinking` defaults to `off` when a model is set. Without a fallback model, the session model
writes these summaries at the session's thinking level, and Pi's own compaction runs when `/compact`
or Pi's threshold finds no native compaction to use. Native compaction always uses the session model.

## Compatibility

- Do not use pi-pleat together with other extensions that edit the conversation history or take over
  compaction. Extensions that only rewrite tool results before they are first sent can be used with it.
- Virtual models are not supported. While one is selected, pi-pleat only answers `recall`, and
  `/context` reports that no physical model is selected.
- Native compaction and replay require a stable endpoint in the selected model's `baseUrl`. Providers
  that change the endpoint during authentication are outside the supported scope: Pi 1.2's request
  hook does not expose the effective endpoint after authentication.
- Only Pi 1.2.0 has been tested.

## Verified scope

The local tests (164 passing) run Pi's session machinery and its Anthropic, Codex and OpenAI adapters
against local mock servers. Live checks passed on 2026-10-14 for Anthropic `claude-haiku-5-5`, with
four native compactions in one task, every later request under strict prefix binding, and a restart,
and for OpenAI Codex `gpt-6-luna`, with two `compaction_trigger` compactions and a restart. The
`openai` Responses channel is covered by the local mocks only. Custom Responses-trigger channels need
separate provider verification. Real server-side clearing, recall by
real models, summary quality, and the effect on cost and latency are not verified yet.

[docs/validation.md](docs/validation.md) has the records, and [docs/architecture.md](docs/architecture.md)
the design; both are in Chinese.

## Development

Requires Node.js 22.19.0 or later. Run these commands from the repository root:

```sh
npm ci
npm run check --workspace=pi-pleat   # type check, and syntax check of the tests
npm test --workspace=pi-pleat        # local tests; the live checks are skipped
```

The live checks make real requests and can incur charges:

```sh
npm run test:live --workspace=pi-pleat

# Only the integrated Anthropic check
PI_CONTEXT_LIVE=1 npm exec --workspace=pi-pleat -- node --test --test-name-pattern="live integrated Anthropic" test/live.test.mjs
```

They use your Pi credentials for `anthropic` and `openai-codex` and open the credential store
read-only: a request that needs an OAuth refresh fails instead of updating the stored credentials.
They send only synthetic content. `test/live.test.mjs` runs pi-pleat in a Pi session with
`claude-haiku-5-5` and `gpt-6-luna`; its Codex check also uses `anthropic/claude-haiku-5-5` for the
readable summary. `test/native.test.mjs` checks the provider protocols directly with
`claude-sonnet-5-5` and `gpt-6-astra`. Set `PI_CONTEXT_ANTHROPIC_MODEL` and `PI_CONTEXT_OPENAI_MODEL`
to use other models.

## Maintainer releases

See [RELEASING.md](https://github.com/ZhenHuangLab/pi-extensions/blob/main/RELEASING.md)
for versioning, package tags, and npm trusted publishing.

## License

MIT; see [LICENSE](LICENSE).
