<h1 align="center">prompt-per-model</h1>

<p align="center">
  <a href="https://github.com/earendil-works/pi">Pi</a> 的按模型系统提示：每个模型一个 Markdown 文件，
  使用该模型时加入系统提示。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/prompt-per-model"><img src="https://img.shields.io/npm/v/prompt-per-model" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/prompt-per-model"><img src="https://img.shields.io/npm/dm/prompt-per-model" alt="npm 每月下载量"></a>
  <a href="https://github.com/ZhenHuangLab/pi-extensions/tags"><img src="https://img.shields.io/github/v/tag/ZhenHuangLab/pi-extensions?filter=prompt-per-model%40*" alt="GitHub 标签"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="许可证：MIT"></a>
  <img src="https://img.shields.io/badge/Pi-1.2.0-2DF9C0" alt="已在 Pi 1.2.0 上测试">
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

不同模型对同样的指令反应不同。prompt-per-model 把每个模型的指令放在单独的文件里，并把与当前模型匹配的文件加入系统提示，放在 `<cwd>` 之后的 `<model_prompt>` 段中。匹配的文件发生变化时（例如切换模型之后），Pi 在对话记录末尾记下新的段，之前的消息保持不变。

## 安装

```sh
pi install npm:prompt-per-model
```

首次启动时，扩展会创建 `~/.pi/agent/prompt-per-model/`。

## 提示文件

在 `~/.pi/agent/prompt-per-model/` 中为每个模型放一个 Markdown 文件，去掉 `.md` 的文件名就是模型 id：

```text
~/.pi/agent/prompt-per-model/
├── claude-opus-5.md
└── gpt-6.1-sol.md
```

要让一个文件用于多个模型，在 `match` frontmatter 中列出它们：

```markdown
---
match: gpt-6-astra, gpt-6.1-sol
---
Keep responses brief.
```

模式匹配模型 id（`gpt-6.1-sol`）、服务商加 id（`openai-codex/gpt-6.1-sol`）或模型的显示名称。`*` 匹配任意字符，`?` 匹配一个字符，不区分大小写：`match: anthropic/*` 用于所有 Anthropic 模型。以 `*` 开头的模式在 YAML 中要加引号，例如 `match: "*"`。多个文件同时匹配时，按文件名顺序拼接它们的文本。虚拟模型按它自己的 id 匹配，而不按它路由到的模型匹配。

在受信任的项目中，扩展还会读取 `.pi/prompt-per-model/`。项目文件会替换同名的全局文件。

每条消息之前都会重新读取这些文件，所以修改从下一条消息开始生效。

## 命令

`/prompt-per-model` 列出所有文件，标出与当前模型匹配的文件，并指出无法使用的文件，例如 frontmatter 无效或没有正文的文件。页脚显示匹配的文件。

## 开发

在仓库根目录运行：

```sh
npm ci
npm run check --workspace=prompt-per-model
```

## 维护者发布

版本管理、包标签和 npm Trusted Publisher 配置见 [RELEASING.md](https://github.com/ZhenHuangLab/pi-extensions/blob/main/RELEASING.md)。

## 许可证

MIT；见 [LICENSE](LICENSE)。
