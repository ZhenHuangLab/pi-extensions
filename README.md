# pi-extensions

[![CI](https://github.com/ZhenHuangLab/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhenHuangLab/pi-extensions/actions/workflows/ci.yml)

[简体中文](README.zh-CN.md)

Independent [Pi](https://github.com/earendil-works/pi) extensions maintained in one npm workspace repository. Each package keeps its npm name, version, release cycle, and license. The private root provides development and release tooling.

## Packages

| Package | Purpose | License | npm |
| --- | --- | --- | --- |
| [pi-pleat](packages/pi-pleat) | Manage context and recall old tool output. | [MIT](packages/pi-pleat/LICENSE) | [![npm version](https://img.shields.io/npm/v/pi-pleat)](https://www.npmjs.com/package/pi-pleat) |
| [strip-pi-docs](packages/strip-pi-docs) | Remove Pi's documentation pointer from the system prompt. | [MIT](packages/strip-pi-docs/LICENSE) | [![npm version](https://img.shields.io/npm/v/strip-pi-docs)](https://www.npmjs.com/package/strip-pi-docs) |
| [prompt-per-model](packages/prompt-per-model) | Add Markdown system prompts for each model. | [MIT](packages/prompt-per-model/LICENSE) | [![npm version](https://img.shields.io/npm/v/prompt-per-model)](https://www.npmjs.com/package/prompt-per-model) |
| [pi-better-explore](packages/pi-better-explore) | Route code searches through sift-light and enforce tool limits. | [MIT](packages/pi-better-explore/LICENSE) | [![npm version](https://img.shields.io/npm/v/pi-better-explore)](https://www.npmjs.com/package/pi-better-explore) |
| [@zhenhuang/pi-xai-search](packages/pi-xai-search) | Search X with xAI's native search tool. | [MIT](packages/pi-xai-search/LICENSE) | [![npm version](https://img.shields.io/npm/v/%40zhenhuang%2Fpi-xai-search)](https://www.npmjs.com/package/@zhenhuang/pi-xai-search) |
| [pi-better-math](packages/pi-better-math) | Render LaTeX math as Unicode in Pi's terminal UI. | [GPL-3.0-or-later](packages/pi-better-math/LICENSE) | [![npm version](https://img.shields.io/npm/v/pi-better-math)](https://www.npmjs.com/package/pi-better-math) |
| [pi-tool-fold](packages/pi-tool-fold) | Fold completed tool calls in the transcript. | [MIT](packages/pi-tool-fold/LICENSE) | [![npm version](https://img.shields.io/npm/v/pi-tool-fold)](https://www.npmjs.com/package/pi-tool-fold) |
| [pi-session-mentions](packages/pi-session-mentions) | Search and reference local Pi, Claude Code, and Codex sessions. | [MIT](packages/pi-session-mentions/LICENSE) | [![npm version](https://img.shields.io/npm/v/pi-session-mentions)](https://www.npmjs.com/package/pi-session-mentions) |

## Install

Run the command for each package you want:

```sh
pi install npm:pi-pleat
pi install npm:strip-pi-docs
pi install npm:prompt-per-model
pi install npm:pi-better-explore
pi install npm:@zhenhuang/pi-xai-search
pi install npm:pi-better-math
pi install npm:pi-tool-fold
pi install npm:pi-session-mentions
```

See each package's README for configuration and usage.

## Development

Use Node.js 22.19.0 or later and npm 11.5.1 or later. The root records `npm@11.19.0` as its package manager. Install dependencies from the root using the single root lockfile.

```sh
git clone https://github.com/ZhenHuangLab/pi-extensions.git
cd pi-extensions
npm ci
npm run check
PI_CONTEXT_LIVE=0 npm test
```

You can also check and test one workspace:

```sh
npm run check --workspace pi-pleat
PI_CONTEXT_LIVE=0 npm test --workspace pi-pleat
npm run check --workspace @zhenhuang/pi-xai-search
PI_CONTEXT_LIVE=0 npm test --workspace @zhenhuang/pi-xai-search
```

Keep `PI_CONTEXT_LIVE=0` for local and CI tests. Live provider tests require explicit permission and can incur charges. Package dependencies and versions remain independent. See [RELEASING.md](RELEASING.md) for Changesets, release tags, and npm Trusted Publishing.

## Repository history

The seven repositories were imported using non-squashed Git subtrees, preserving each original `main` branch's complete history. Development continues under `packages/`. The original repositories retain their historical releases.

Historical tags retain their original tag objects under namespaced refs and point to the original single-package layout. Never republish them. New Releases begin at patch-bumped versions and require new tags whose commits contain the root publish workflow.

## Licenses

The [root MIT license](LICENSE) covers root tooling and documentation. Each package retains its own license: `pi-better-math` is GPL-3.0-or-later and depends on GPL-licensed `libtexprintf`; the other packages are MIT licensed. Review the license and notices in each package before use or distribution.
