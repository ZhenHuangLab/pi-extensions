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

### Codex 开源客户端

查证版本为 OpenAI/codex 的
[`95273b84fbff40f9df7d71d50f1ca52c6489b25d`](https://github.com/openai/codex/commit/95273b84fbff40f9df7d71d50f1ca52c6489b25d)
（2026-10-14）。这比仅根据某个 HTTP 端点状态判断 Codex 能力更直接：

- [请求追加 compaction_trigger](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2_attempt.rs#L172)
- [等待完整终止与一个压缩项](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2.rs#L375)
- [重建压缩后历史](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2.rs#L480)
- [客户端保留项规则](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/core/src/compact_remote_v2.rs#L529)
- [trigger 是请求控制项](https://github.com/openai/codex/blob/95273b84fbff40f9df7d71d50f1ca52c6489b25d/codex-rs/protocol/src/models.rs#L1292)

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
