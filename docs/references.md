# 参考资料

Pi 本地检查固定使用 npm `@earendil-works/pi-coding-agent@1.2.0` 和
`@earendil-works/pi-ai@1.2.0`。下面的 GitHub main 链接会变化；接口事实以该版本的类型、
源码和仓库中的验证记录为准。

## Pi

- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Extension types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [Session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [Anthropic adapter](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/anthropic-messages.ts)
- [Classifier models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-classifier-models)

## 服务商

- [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
- [Compaction and preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks)
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)

### OpenAI SDK

`openai@7.19.0` 是 `@earendil-works/pi-ai@1.2.0` 的依赖，版本由 `package-lock.json` 锁定。
`npm ci` 之后，`node_modules/openai/resources/responses/responses.d.ts` 中：

- 第 3530 行的 `ResponseInputItem` 联合类型包含 `ResponseInputItem.CompactionTrigger`；
- 第 4246–4254 行定义 `CompactionTrigger`，只有 `type: 'compaction_trigger'` 一个字段，
  说明为 “Compacts the current context. Must be the final input item.”

### Codex 开源客户端

查证版本为 OpenAI/codex 的
[`95273b84fbff40f9df7d71d50f1ca52c6489b25d`](https://github.com/openai/codex/commit/95273b84fbff40f9df7d71d50f1ca52c6489b25d)
（2026-10-14）。这比仅根据某个 HTTP 端点状态判断 Codex 能力更直接：

- [请求追加 compaction_trigger](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2_attempt.rs#L172)
- [等待完整终止与一个压缩项](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2.rs#L375)
- [重建压缩后历史](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2.rs#L480)
- [客户端保留项规则](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2.rs#L529)
- [trigger 是请求控制项](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/protocol/src/models.rs#L1292)
- [endpoint 模块](https://github.com/openai/codex/tree/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/codex-api/src/endpoint)：
  只有 `mod.rs`、`images.rs`、`memories.rs`、`models.rs`、`realtime_call.rs`、`realtime_websocket/`、
  `responses.rs`、`responses_websocket.rs`、`responses_websocket/`、`search.rs` 和 `session.rs`，
  没有独立压缩端点模块。

### Codex 后台压缩

Codex 官方客户端在 2026-10-13 加入后台（异步）压缩。pi-pleat v0.1.0 没有实现这一功能：

- [#53614 `1a69ad32`](https://github.com/openai/codex/commit/1a69ad3237fc485273ccfa9731239fdf789b43e4)：
  后台远程 V2 压缩的基础设施；捕获历史、提示元数据、路由状态和认证所有者，按历史版本、模型、
  压缩哈希和认证所有者去重。
- [#53620 `9167a0b2`](https://github.com/openai/codex/commit/9167a0b2d4a74d44a4d388057d304682e47313c6)：
  复用后台结果；安装前校验历史代数、前缀长度、模型和认证所有者；只替换捕获的前缀，保留之后的消息和
  工具输出。
- [#53800 `9e03960c`](https://github.com/openai/codex/commit/9e03960cf8807c37fc987bf17b4e745b8b3339d2)：
  在回合前、回合中、回合后的检查点启动；在检查点采用就绪结果；采用后仍超过上限时做一次前台压缩。
- [async_compaction.rs](https://github.com/openai/codex/blob/9e03960cf8807c37fc987bf17b4e745b8b3339d2/codex-rs/core/src/session/async_compaction.rs)：
  `AsyncCompaction` 开启、`TokenBudget` 关闭且服务商支持远程 V2 压缩时启用，启动阈值为 `async_compaction_threshold_percent`。
- [后台请求使用同一个 trigger 请求](https://github.com/openai/codex/blob/9e03960cf8807c37fc987bf17b4e745b8b3339d2/codex-rs/core/src/compact_remote_v2_attempt.rs#L285)：
  `run_background_compaction` 调用与前台相同的 `run_remote_compact_v2_attempt`，后者在输入末尾追加
  [`CompactionTrigger`](https://github.com/openai/codex/blob/9e03960cf8807c37fc987bf17b4e745b8b3339d2/codex-rs/core/src/compact_remote_v2_attempt.rs#L172)。

## 研究报告

- [Interleaved Thinking Unlocks Reliable MiniMax-M2 Agentic Capability](https://www.minimax.io/news/why-is-interleaved-thinking-important-for-m2)
  （MiniMax，2025-11-03）：保留与丢弃前几轮 thinking 的基准对照。
- [The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management](https://arxiv.org/abs/2508.21433)
  （Lindenbauer 等，arXiv:2508.21433）：SWE-agent 中屏蔽旧观察结果与 LLM 摘要的对照。

这些报告说明设计取舍的依据，不代表 pi-pleat 在同类任务上的效果。

## 相关实现

- [pi-better-compaction](https://github.com/lll9p/pi-better-compaction)
- [pi-fold](https://github.com/shaneconner/fold)
- [pi-condense](https://github.com/jjuraszek/pi-condense)
- [pi-smart-compact](https://github.com/alpertarhan/pi-smart-compact)

相关实现提供设计参考，不构成 pi-pleat 当前已经实现或验证某项功能的证据。
