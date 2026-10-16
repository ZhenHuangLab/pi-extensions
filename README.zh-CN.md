# pi-extensions

[![CI](https://github.com/ZhenHuangLab/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhenHuangLab/pi-extensions/actions/workflows/ci.yml)

[English](README.md)

本仓库使用 npm workspaces 维护多个独立的 [Pi](https://github.com/earendil-works/pi) 扩展。每个包保留自己的 npm 名称、版本、发布周期和许可证。私有根包提供开发和发布工具。

## 扩展包

| 包 | 用途 | 许可证 | npm |
| --- | --- | --- | --- |
| [pi-pleat](packages/pi-pleat) | 管理上下文，按需恢复旧工具输出。 | [MIT](packages/pi-pleat/LICENSE) | [![npm 版本](https://img.shields.io/npm/v/pi-pleat)](https://www.npmjs.com/package/pi-pleat) |
| [strip-pi-docs](packages/strip-pi-docs) | 移除系统提示词中的 Pi 文档指引。 | [MIT](packages/strip-pi-docs/LICENSE) | [![npm 版本](https://img.shields.io/npm/v/strip-pi-docs)](https://www.npmjs.com/package/strip-pi-docs) |
| [prompt-per-model](packages/prompt-per-model) | 为不同模型添加对应的 Markdown 系统提示词。 | [MIT](packages/prompt-per-model/LICENSE) | [![npm 版本](https://img.shields.io/npm/v/prompt-per-model)](https://www.npmjs.com/package/prompt-per-model) |
| [pi-better-explore](packages/pi-better-explore) | 将代码搜索交给 sift-light，并限制工具操作。 | [MIT](packages/pi-better-explore/LICENSE) | [![npm 版本](https://img.shields.io/npm/v/pi-better-explore)](https://www.npmjs.com/package/pi-better-explore) |
| [@zhenhuang/pi-xai-search](packages/pi-xai-search) | 使用 xAI 原生搜索工具搜索 X。 | [MIT](packages/pi-xai-search/LICENSE) | [![npm 版本](https://img.shields.io/npm/v/%40zhenhuang%2Fpi-xai-search)](https://www.npmjs.com/package/@zhenhuang/pi-xai-search) |
| [pi-better-math](packages/pi-better-math) | 在 Pi 终端界面中将 LaTeX 数学公式渲染为 Unicode。 | [GPL-3.0-or-later](packages/pi-better-math/LICENSE) | [![npm 版本](https://img.shields.io/npm/v/pi-better-math)](https://www.npmjs.com/package/pi-better-math) |
| [pi-tool-fold](packages/pi-tool-fold) | 折叠对话记录中已完成的工具调用。 | [MIT](packages/pi-tool-fold/LICENSE) | [![npm 版本](https://img.shields.io/npm/v/pi-tool-fold)](https://www.npmjs.com/package/pi-tool-fold) |
| [pi-session-mentions](packages/pi-session-mentions) | 搜索并引用本机 Pi、Claude Code 和 Codex 会话。 | [MIT](packages/pi-session-mentions/LICENSE) | 尚未发布 |

## 安装

按需运行各个包的安装命令：

```sh
pi install npm:pi-pleat
pi install npm:strip-pi-docs
pi install npm:prompt-per-model
pi install npm:pi-better-explore
pi install npm:@zhenhuang/pi-xai-search
pi install npm:pi-better-math
pi install npm:pi-tool-fold
```

配置与使用方法见各包的 README。

从本地仓库使用 `pi-session-mentions`，执行 `pi install ./packages/pi-session-mentions`。

## 本地开发

使用 Node.js 22.19.0 或更高版本，以及 npm 11.5.1 或更高版本。根包的包管理器设为 `npm@11.19.0`。从仓库根目录安装依赖，所有工作区共用根目录的锁文件。

```sh
git clone https://github.com/ZhenHuangLab/pi-extensions.git
cd pi-extensions
npm ci
npm run check
PI_CONTEXT_LIVE=0 npm test
```

也可以单独检查和测试一个工作区：

```sh
npm run check --workspace pi-pleat
PI_CONTEXT_LIVE=0 npm test --workspace pi-pleat
npm run check --workspace @zhenhuang/pi-xai-search
PI_CONTEXT_LIVE=0 npm test --workspace @zhenhuang/pi-xai-search
```

本地和 CI 测试均保持 `PI_CONTEXT_LIVE=0`。调用真实提供商的测试需要明确许可，并且可能产生费用。各包的依赖和版本保持独立。Changesets、发布标签和 npm Trusted Publishing 的使用方法见 [RELEASING.md](RELEASING.md)。

## 仓库历史

七个原仓库通过未压缩提交的 Git subtree 导入，完整保留每个原仓库 `main` 分支的历史。后续开发在 `packages/` 中进行。原仓库保留以供查阅历史发布。

带包名前缀的历史标签保留原标签对象，仍指向采用原单包目录结构的提交。不得使用这些标签重新发布。新发布从补丁升级后的版本开始，并使用新标签；标签指向的提交必须包含根目录的发布工作流。

## 许可证

[根目录的 MIT 许可证](LICENSE) 适用于根目录的工具和文档。每个包保留自己的许可证：`pi-better-math` 使用 GPL-3.0-or-later，并依赖使用 GPL 许可证的 `libtexprintf`；其余包使用 MIT。使用或分发前，请查阅相应包的许可证和声明。
