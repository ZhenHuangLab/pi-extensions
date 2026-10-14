# Pi 上下文管理方案：初步验证记录

日期：2026-10-14。目标版本：本机 Pi 1.2.0。

结论：本地生命周期的三项检查通过。Anthropic 的两次原生压缩及严格 thinking 回放通过。当前 OpenAI Codex 订阅通道的独立压缩端点返回 404，验证仍有阻塞，不能把整份方案标记为已通过。

## 验证方式

本地检查使用真正的 Pi AgentSession、SessionManager、扩展加载器和模型运行时，由合成 provider 提供确定的响应。真实接口检查使用现有 Anthropic API 凭据和 OpenAI Codex OAuth 凭据，只发送新建的合成任务。

凭据存储使用 ReadOnlyAuthStorage，拒绝刷新或修改凭据。模型目录存储放在内存中。本地测试的会话文件写入临时目录并清理。测试没有修改现有会话、设置或安装任何插件。

生命周期测试由 GPT-6.1-sol 起草；GPT-6-astra 和 Grok-4.7 参与审查。原生接口测试由 GPT-6-astra 编写，Grok-4.7 审查。主会话执行检查并核对结果。

## 1. 本地生命周期：3 项通过

| 检查 | 实际结果 | 对方案的影响 |
| --- | --- | --- |
| 在 turn_end 调用 ctx.compact() | 当前操作的 signal 被中止；压缩原因是 manual，willRetry 为 false；没有自动继续模型请求 | 第 6 节不能用这个入口实现运行中的自动压缩 |
| turn_end 返回 compaction 条目 | 条目提交成功；保留 assistant/toolResult 配对；正常发起下一模型请求；当前 signal 未被中止 | 可用作轮次边界的压缩提交方式 |
| 直接调用 ctx.modelRegistry.streamSimple() | 不触发已注册的请求/响应/原始流扩展事件；显式传入回调后回调生效 | 第 7 节必须为独立压缩调用传入回调 |

本地检查没有实现实际摘要算法。它证明的是 Pi 生命周期和回调契约。

## 2. Anthropic：两次压缩及严格回放通过

模型：claude-sonnet-5-5。推理等级：high。

过程：

1. 发送包含随机项目标识和作业分配问题的请求，取得带签名的 thinking。
2. 压缩刚才实际发送的请求前缀，保留其 assistant 回复。
3. 将完整签名压缩块放在开头，紧接原样的保留回复，再追加新问题。
4. 使用 prefix_mismatch_behavior: "error" 继续请求。
5. 对新窗口再执行一次压缩及严格回放。

两次压缩均返回 HTTP 200、一个完整签名块和原始 stop_reason: "compaction"。两次回放均返回 HTTP 200，实际 HTTP 请求中保留了对应 thinking 签名，input_transformations 为空，随机项目标识仍可取回。

| 请求 | 原始输入 tokens | 原始输出 tokens | 结果 |
| --- | ---: | ---: | --- |
| 第一次压缩 | 284 | 1,636 | 签名块成功；Pi 归一化返回错误 |
| 第一次回放 | 2,242 | 1,388 | 严格检查通过，保留 1 个 thinking 块 |
| 第二次压缩 | 2,300 | 795 | 签名块成功；Pi 归一化返回错误 |
| 第二次回放 | 2,329 | 1,429 | 严格检查通过，保留 1 个 thinking 块 |

### 确认的实现缺口

**Pi 1.2.0 不认识原生压缩的结束原因。** 两次有效压缩响应都会使适配器返回：

```text
stopReason: error
errorMessage: Unhandled stop reason: compaction
```

原始流回调在适配器处理前收到完整块及 compaction 结束原因，因此本次隔离测试可以继续验证块的回放。但这不代表 Pi 的归一化流正常结束，也没有证明其已消费后续所有事件。正式实现需要完整处理原生响应的终止、用量、错误和取消，不能把所有 error 都当作成功，也不能仅凭收到一个块就提交生产会话状态。

**压缩费用不能只读顶层 usage。** 两次响应的顶层 input_tokens/output_tokens 都是零；真实压缩用量位于 usage.iterations 中，条目的 type 为 compaction。预算与费用统计需要分别处理普通请求和压缩请求。

**保留边界必须对应实际 provider 消息。** Pi 会插入包含 output_config.effort 的会话内 system 消息。测试从实际请求中选择保留的 assistant 边界，检查它的签名，并验证实际 HTTP body 中压缩块后紧接这条回复。简单删除 messages[0] 或只依赖 Pi 条目数量不够。

### 首轮测试的前置条件不足

首次使用简单算术题和 medium thinking，普通请求成功，但模型没有返回签名 thinking。测试正确地失败，没有把这种情况当作“零丢弃”成功。随后改用需要比较多个分配方案的合成任务和 high thinking，才完成上述验证。

## 3. OpenAI Codex：独立压缩端点阻塞

模型：gpt-6-astra；API：openai-codex-responses。

普通 Responses 请求成功，HTTP 200。SDK 使用同一认证来源请求以下独立压缩路径：

```text
https://chatgpt.com/backend-api/codex/responses/compact
```

该路径两次返回：

```text
HTTP 404
{"detail":"Not Found"}
```

最后一次检查在 fetch 边界确认了真实请求路径。中间一次重跑遇到普通 Responses 服务过载，之后仅重试 OpenAI 检查，重新取得普通请求 200 和独立压缩 404。

这项结果仅适用于本次账户、通道和路径。没有测试 OpenAI API key 通道的 /v1/responses/compact，也没有测试其他原生压缩方式。因此，OpenAI 的压缩窗口回放检查没有执行，不能标记为通过。

第 8 节应将原生压缩能力按服务商、API、实际端点和模型判断。当前 Codex 通道必须进入明确的“不支持该端点”处理路径；普通模型请求成功不代表压缩端点可用。

## 4. 尚未验证

- 实际触发服务端清理并读取 applied_edits。本次小请求只证明清理配置被接受。
- 清理后召回、嵌套工具输出的保存、图片结果。
- 原生块在 Pi 会话重启和分支切换之后的恢复。
- 模型切换，尤其是不同服务商之间的摘要交接。
- 满窗口、超大并行工具结果、压缩请求取消或不完整响应。
- 回退模型、实际任务通过率、费用收益和延迟。
- OpenAI 原生压缩及其窗口回放。

## 5. 对实施顺序的建议

先修正独立请求回调和运行中的压缩提交方式，再决定如何完整接收 Anthropic 原生压缩响应及统计 iterations 用量。之后验证实际清理、召回和重启恢复。OpenAI 当前通道的 404 作为独立阻塞处理。

插件定位应是“上下文管理与压缩”，召回服务于清理后的内容取回。名称可优先考虑 pi-pleat、pi-press、pi-crimp、pi-origami；这些名称尚未查重。

## 6. 复现与原始记录

程序：

- lifecycle.test.mjs：本地三个契约检查。
- native.test.mjs：真实 Anthropic 与 OpenAI Codex 检查，必须显式设置 PI_CONTEXT_LIVE=1。

记录：

- verification.tap：首轮运行日志，3 项本地通过；Claude 缺少 thinking 前置条件；Codex 压缩 404。该文件使用 Node 默认文本格式。
- native-verification.tap：加强前置条件后的 Anthropic 完整通过记录，以及一次 Codex 普通请求过载。
- openai-verification.tap：仅重试 Codex，确认普通请求 200、实际压缩路径 404。

命令见 README.md。不要为获得“全绿”而忽略 OpenAI 失败；该失败记录了本次通道能力限制。
