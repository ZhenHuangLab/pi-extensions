<h1 align="center">pi-pleat</h1>

<p align="center">
  <a href="https://github.com/earendil-works/pi">Pi</a> 的上下文管理：清理旧的工具输出，让模型可以召回它，
  并在服务商提供原生压缩时使用原生压缩。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="许可证：MIT"></a>
  <img src="https://img.shields.io/badge/Pi-1.2.0-2DF9C0" alt="已在 Pi 1.2.0 上测试">
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

pi-pleat 让很长的 Pi 会话保持在模型的上下文窗口之内。旧的工具结果离开上下文，但仍保存在会话文件中，模型可以用 `recall` 工具取回。上下文达到压缩阈值时，pi-pleat 在 Anthropic 和 OpenAI Responses 模型上使用原生压缩（compaction），在其他模型上使用文本摘要。它自己从不删除 thinking。在 Anthropic 上，原生压缩之后保留轮次中的 thinking 仍然可用，真实检查在严格前缀绑定下确认了这一点。模型只多看到一个工具，系统提示不增加任何内容。

## 安装

```sh
pi install git:github.com/ZhenHuangLab/pi-pleat
```

也可以从本地克隆安装：

```sh
git clone https://github.com/ZhenHuangLab/pi-pleat
pi install ./pi-pleat
```

pi-pleat 基于 Pi 1.2.0 开发和测试，不需要任何设置。

## 工作方式

| 服务商 | 旧的工具结果 | 压缩 |
|---|---|---|
| Anthropic（`anthropic`） | 由 Anthropic 服务端的上下文编辑清理，全部 thinking 保留 | 用会话模型做原生压缩；带签名的压缩块替换被摘要的历史 |
| OpenAI Codex（`openai-codex`）和 OpenAI（`openai`，Responses API） | 在本地换成带召回 ID 的占位文字 | 与官方 Codex 客户端相同，发送 Responses `compaction_trigger` 项；加密的压缩项和用户消息替换被摘要的历史 |
| 其他服务商 | 在本地换成带召回 ID 的占位文字 | Pi 的压缩，或由回退模型写的摘要 |

在 Anthropic 上，压缩请求不能同时使用清理，所以 pi-pleat 在一轮结束时检查服务端清理之前的历史大小，超过阈值就压缩。它只压缩最近一次实际发送的请求，这个请求的回复成为第一条保留消息，紧跟在压缩块之后，因此回复中的 thinking 仍被接受。之后的每个请求（包括重启之后）都会先核对摘要、保留的回复、系统提示和工具；其中任何一项变化时，请求改为以文字形式携带摘要。

在 OpenAI 的两个通道上，压缩在 Pi 自己的阈值到达或运行 `/compact` 时开始。pi-pleat 把 Pi 切点之前的历史加上一个 `compaction_trigger` 项发出去，读取完整响应，保留纯文本的用户消息（最多 64,000 tokens）和压缩项。加密的压缩项只发给相同的服务商、API、端点和模型，所以 pi-pleat 同时用回退模型写一份可读摘要。用户消息含图片，或 `/compact` 带有说明时，改用文本摘要。

上下文超过压缩阈值的一半时，本地清理开始。它把最旧的、不小于 1 KB 的工具结果换成占位文字，例如 `[Output cleared to save context (48.0KB). recall id="c3d4e5f6"]`；最近 8 次工具调用的结果保持不变；一批释放的空间达不到阈值的十分之一时不清理。分支上后面跟着 Claude thinking 的结果也不动，因为修改它们会使那些 thinking 失效。Anthropic 的服务端清理使用相同的触发点、相同的 8 次调用和相同的最小批量。

原生压缩不可用、无法证明安全，或重试后仍然失败时，pi-pleat 写一份 Pi 格式的文本摘要，或者交给 Pi 照常压缩，并显示原因。文本摘要可能使保留的 Claude thinking 失效。遇到认证错误或不完整的响应时，跳过本次压缩，历史保持不变。压缩后的下一请求加上 4,096 tokens 的余量放不下模型窗口时，pi-pleat 也丢弃该结果并保留历史。

## `recall` 工具

模型看到的工具说明是：

```text
Get the full output of an earlier tool call that was cleared to save context.
Pass `id` from a cleared-output note, or `query` (command, path, tool name, or text) to get the newest match.
```

`id` 接受占位文字中的召回 ID 或工具调用 ID。`query` 在当前分支以前的工具结果中搜索工具名、参数和文字输出，返回最新的一条匹配，并列出最多 5 个其他匹配的 ID。结果第一行说明来源，例如 `[c3d4e5f6 · bash "npm test" · 48.0KB]`，后面是会话保存的原样输出，包括已被压缩摘要覆盖的结果。如果 Pi 只保存了原始输出的一部分，来源说明会写明，并报告完整输出文件是否还在。

超过 2,000 行或 50 KB 的输出会写入临时文件，工具返回开头部分和文件路径，模型再用 `read` 分段读取。在 Anthropic 上，服务端的占位文字里没有召回 ID，模型用保留的工具调用中的命令或路径作为 `query`。召回从不重新运行命令。

## 命令

| 命令 | |
|---|---|
| `/context` | 上下文用量和阈值、清理和压缩的次数及其用量和费用（服务商没有报告用量时显示 unknown 或 partial）、原生回放状态、服务商能力、召回次数、服务商报告丢弃的 thinking、回退模型和最近的提示 |
| `/context fallback` | 显示回退模型 |
| `/context fallback <provider/model> [level]` | 本会话使用这个模型，可以同时指定 thinking 级别（`off` 到 `max`） |
| `/context fallback default` | 取消本会话的选择 |

## 设置

pi-pleat 读取 Pi 的 `compaction` 设置。压缩阈值等于模型的上下文窗口减去 `reserveTokens`，`compaction.modelOverrides` 按模型生效。`compaction.enabled: false` 关闭自动压缩；清理和 `/compact` 仍然可用。

它自己只有一个设置，用来选择回退模型，写在 Pi 的 `settings.json`（`~/.pi/agent/settings.json`，或受信任项目中的 `.pi/settings.json`）的 `pi-pleat` 下：

```json
{
  "pi-pleat": {
    "fallbackModel": "anthropic/claude-haiku-5-5",
    "fallbackThinking": "off"
  }
}
```

回退模型负责写文本摘要，以及 OpenAI 通道上的可读摘要。设置了模型时，`fallbackThinking` 默认是 `off`。没有设置回退模型时，这些摘要由会话模型按会话的 thinking 级别来写；`/compact` 或 Pi 的阈值找不到可用的原生压缩时，由 Pi 自己压缩。原生压缩始终使用会话模型。

## 兼容性

- 不要和其他修改对话历史或接管压缩的扩展一起使用。只在工具结果首次发送前改写它的扩展可以一起使用。
- 不支持虚拟模型。选中虚拟模型时，pi-pleat 只响应 `recall`，`/context` 会说明当前没有选中物理模型。
- 只在 Pi 1.2.0 上测试过。

## 验证范围

本地测试（164 项通过）在本地模拟服务上运行 Pi 的会话机制，以及它的 Anthropic、Codex 和 OpenAI 适配器。2026-10-14 的真实接口检查通过：Anthropic `claude-haiku-5-5` 在一个任务中完成 4 次原生压缩，之后的每个请求都在严格前缀绑定下成功，重启也通过；OpenAI Codex `gpt-6-luna` 完成 2 次 `compaction_trigger` 压缩，重启也通过。`openai` 的 Responses 通道只有本地模拟测试。真实的服务端清理、真实模型的召回行为、摘要质量，以及对费用和延迟的影响都还没有验证。

记录见 [docs/validation.md](docs/validation.md)，设计见 [docs/architecture.md](docs/architecture.md)。

## 开发

需要 Node.js 22.19.0 或更高版本。

```sh
npm ci
npm run check   # 类型检查，以及测试文件的语法检查
npm test        # 本地测试；跳过真实接口检查
```

真实接口检查会发出实际请求，可能产生费用：

```sh
npm run test:live

# 只运行 Anthropic 集成检查
PI_CONTEXT_LIVE=1 node --test --test-name-pattern="live integrated Anthropic" test/live.test.mjs
```

它们使用你在 Pi 中为 `anthropic` 和 `openai-codex` 配置的凭据，并以只读方式打开凭据存储：需要刷新 OAuth 令牌的请求会直接失败，不会改动已保存的凭据。检查只发送合成内容。`test/live.test.mjs` 在 Pi 会话中运行 pi-pleat，使用 `claude-haiku-5-5` 和 `gpt-6-luna`；其中的 Codex 检查还用 `anthropic/claude-haiku-5-5` 写可读摘要。`test/native.test.mjs` 直接检查服务商协议，使用 `claude-sonnet-5-5` 和 `gpt-6-astra`。设置 `PI_CONTEXT_ANTHROPIC_MODEL` 和 `PI_CONTEXT_OPENAI_MODEL` 可以换用其他模型。

## 许可证

MIT，见 [LICENSE](LICENSE)。
