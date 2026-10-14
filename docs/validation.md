# 验证记录

日期：2026-10-14。宿主契约固定为 Pi 1.2.0。当前是框架和验证阶段，尚未实现生产插件。

## 已有实测

### 本地生命周期

以下三项已在真实 Pi 会话机制上通过，provider 响应由测试提供：

| 检查 | 结果 |
| --- | --- |
| 在 `turn_end` 调用 `ctx.compact()` | 中止当前运行，原因为 manual，`willRetry` 为 false；不会自动继续 |
| `turn_end` 返回 `compaction` 条目 | 提交一次，保留 assistant/toolResult 配对，随后正常继续 |
| 直接调用 `ctx.modelRegistry.streamSimple()` | 不自动触发扩展请求/响应事件；显式回调生效 |

本仓库另加入嵌套调用以及分支编辑/持久化检查，均已通过。运行结果在下方仓库复测节记录。
普通 JSON 数据成功持久化只证明存储契约，不证明原生状态重启后的 API 回放。

### Anthropic

使用 `claude-sonnet-5-5`、high thinking 和合成作业分配问题：

1. 普通请求产生实际带签名的 thinking。
2. 压缩实际发送过的前缀，保留其 assistant 回复。
3. 完整签名块后紧接原样的保留回复，再追加新问题。
4. 设置 `prefix_mismatch_behavior: "error"`，连续执行两次压缩和回放。

两次压缩和两次回放均返回 HTTP 200，回放请求携带原 thinking 签名，未报告
`input_transformations`。项目标识可以从回放窗口中读出。

| 请求 | 输入 tokens | 输出 tokens | 观察 |
| --- | ---: | ---: | --- |
| 第一次压缩 | 284 | 1,636 | 一个完整签名块；原始结束原因 compaction |
| 第一次回放 | 2,242 | 1,388 | 回放 1 个 signed thinking 块，未报告转换 |
| 第二次压缩 | 2,300 | 795 | 一个完整签名块；原始结束原因 compaction |
| 第二次回放 | 2,329 | 1,429 | 回放 1 个 signed thinking 块，未报告转换 |

**适配器缺口：** 两次原生摘要均使 Pi 返回
`stopReason: "error"` / `Unhandled stop reason: compaction`。测试只在隔离请求中使用已捕获的
完整块继续验证回放，没有提交生产会话。它未证明归一化流正常完成或后续全部事件已被读取。

**用量缺口：** 压缩顶层 input/output 为零；实际值位于 `usage.iterations` 的 compaction 项。
费用统计不能只读顶层。

**验证边界：** 保留回复本身含项目标识，所以读回标识只证明整个回放窗口可读，
不独立证明摘要质量。未报告转换也不证明模型内部使用了全部历史推理。
当前 fixture 没有非空工具定义、工具配对或 Pi checkpoint 恢复。

首次简单算术题使用 medium thinking 时未返回签名块，测试按前置条件不足失败。
加强任务和推理级别之后才产生上述记录。

### OpenAI Codex

模型为 `gpt-6-astra`，API 为 `openai-codex-responses`。普通请求返回 200，
同一认证来源下的实际独立压缩请求两次返回：

```text
POST https://chatgpt.com/backend-api/codex/responses/compact
HTTP 404
{"detail":"Not Found"}
```

一次中间重跑遇到普通推理服务过载；随后仅重试 Codex，再次取得普通请求 200 和压缩 404。
这个结果只适用于所测账户、通道及路径。OpenAI API-key 通道和其他压缩方式尚未验证。
因此没有执行成功的 OpenAI 压缩窗口回放检查，也不把该失败改成通过。

## 复核后补强

本地生命周期代码由 GPT-6.1-sol 起草，GPT-6-astra 检查并执行。
原生检查由 GPT-6-astra 编写，先经 Grok-4.7 初审，后改用 GPT-6.1-sol 完成补充复核。
后续框架审查使用 GPT-6.1-sol。

补充复核要求检查实际 HTTP body 中的 system、tools、thinking、context_management、
compaction、output_config 及 beta 请求头，尤其是 strict binding。仓库已加入这些断言并完成复测。
早期记录仍只证明当时的断言，新增断言由下面的独立记录支持。

## 仓库复测

依赖已记录在 `package-lock.json`；本机安装核对确认 Pi coding-agent、pi-ai 和 pi-agent-core 均为 1.2.0，
OpenAI SDK 为 7.19.0，TypeBox 为 1.3.27。

| 命令或检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run check` | 两个验证文件语法检查通过 | Node 退出码 0 |
| `npm test` | 本地 5 项通过，0 失败 | [本地结果](evidence/local-contracts.log) |
| Anthropic 单独真实检查 | 新 HTTP 字段断言及两次压缩/回放通过 | [传输字段复测](evidence/anthropic-http-fields.tap) |

新增本地检查确认：

- 嵌套调用有 `parentToolCallId`，父工具能读取完整结构化值；只有父结果进入 transcript。
  `nestedCalls` 保存调用元数据，不保存子调用结果。
- `context_edit` 不改原条目；回到编辑前的分支可见原内容；重新打开 JSONL 后，
  当前分支的编辑和压缩 details 数据仍然存在，另一分支的编辑不会生效。

测试草稿曾遗漏允许调用的子工具名，并把 JSONL 不保存 `undefined` 属性误判为差异。
修正工具白名单和 JSON 值比较后，上述五项通过；没有修改 Pi 来迎合测试。

新增真实检查在最终 HTTP body 中确认 strict binding 为 `error`，两次回放均带 1 个签名 thinking 块，
未报告转换。两次原生摘要的 Pi 归一化错误仍然存在，压缩用量仍在 iterations 中。
这次检查同样不证明非空工具、实际清理、摘要质量或 Pi checkpoint 后的原生状态恢复。

当前已知失败的 Codex 路径保留为独立阻塞，本轮没有为相同结论再次请求该路径。

## 原始记录

- [初次运行](evidence/initial-run.log)：本地 3 项通过，Claude thinking 前置条件不足，Codex 压缩 404。
- [原生回放初次通过](evidence/native-initial.tap)：Anthropic 两次回放通过，另一次 Codex 服务过载。
- [确认 Codex 路径](evidence/codex-404.tap)：普通请求 200，实际独立压缩路径 404。

早期记录中的行号对应迁入仓库前的验证程序。发布前替换本机目录路径为
`<validation-dir>`、`<pi-package-dir>`，并去除行末空白；没有改变服务端状态、用量或结果。
不包含认证头、签名值、encrypted state 或 thinking 文本。

运行命令见 [README](../README.md)。剩余发布门槛见[路线图](roadmap.md)。
