# Pi 上下文管理插件实现计划（第 2 版）

更新日期：2026-10-14。本文是实现方案，尚未运行实际接口测试。Pi 是编程代理；Anthropic 是 Claude 的服务商；OpenAI 是另一家模型服务商。compaction（压缩）指把较早的上下文换成摘要；thinking 指服务端返回、可在后续请求中继续使用的推理块；preserved thinking 指较新的 Claude 模型在后续请求中读取以前的 thinking 块，并检查这些块之前的内容是否改变的机制。

第 2 版先确定设计原则，再按原则精简第 1 版。主要变化是：用 Pi 1.2.0 已有的会话文件、`context_edit`、截断和压缩接口代替自建归档；模型只看到一个省 token 的召回工具；去掉跨会话检索、阈值压缩模式和默认严格模式；回退压缩可以指定模型。第 1 版保存在 `pi_context_management_plan.v1.md`。

## 1. 设计原则

1. 对 Anthropic 优先适配 preserved thinking。Claude Fable 5.1、Opus 5.5、Sonnet 5.5 和 Haiku 5.5 会检查每个 thinking 块之前的 `system`、`tools` 和 `messages` 是否与生成它时相同；不同时，这个块和之后的所有 thinking 块失效。[S3] 所以插件只追加内容，不修改已发送的内容：会话内 `system` 和 `tools` 保持不变，插件唯一的工具在加载时注册；不在客户端缩短、删除、重排或改写已发送的消息；工具结果只在首次发送前限制长度；旧内容的清理和压缩交给服务端，服务端的编辑不算前缀修改；召回的原文作为新的工具结果追加；压缩请求使用会话原模型、原 `system` 和原 `tools`；不在 `tool_use` 和它的 `tool_result` 之间压缩；切换模型时不在客户端删除 thinking，由 API 丢弃当前模型不能读的块，切回原模型后这些块重新可读。[S3, S10] Pi 1.2.0 已经对支持的 Claude 模型用 `tool_addition`/`tool_removal` 处理中途的工具变化，把提示变化作为会话中的系统消息追加，并把 `input_transformations` 写入助手消息的诊断信息。插件不能破坏这些行为。[S5, S9]

2. 上下文管理优先使用官方原生方法。插件只为没有原生支持的部分写代码：召回工具，以及在 Pi 原生支持之前回放服务商的压缩块。对应关系如下。

| 需求 | Anthropic | OpenAI Responses | 其他模型 |
| --- | --- | --- | --- |
| 清理旧工具结果 | 服务端 `clear_tool_uses_20250919` | Pi `context_edit` | Pi `context_edit` |
| 保留 thinking | `clear_thinking_20251015`，`keep: "all"` | 原样回传加密 reasoning 项（Pi 已实现） | 按 Pi 适配器的服务商规则 |
| 压缩 | 按需压缩，beta `compact-2026-09-04` | `POST /v1/responses/compact` | Pi 压缩，可指定模型 |
| 保存原文 | Pi 会话 JSONL | Pi 会话 JSONL | Pi 会话 JSONL |
| 超长输出 | Pi 截断，完整输出写入文件 | 同左 | 同左 |
| 用量与清理统计 | `usage`、`context_management.applied_edits` | `usage` | Pi 上下文用量 |

3. 用“清理加召回”释放空间。大的工具结果离开上下文，原文留在 Pi 会话文件中，模型需要时可以取回。处理顺序是：首次发送前只截短超过上限的结果；之后从旧到新清理工具结果，保留最近 8 次工具调用；模型需要旧结果时调用 `recall`。Anthropic 的服务端清理只能按时间顺序选择，不能按大小选择；在客户端按大小删除旧结果又会使之后的 thinking 失效。[S3, S6] 所以在 Anthropic 上，按大小选择只在首次发送前进行。服务端清理保留工具调用参数（`clear_tool_inputs: false`），模型仍然知道调用过什么工具、用过什么参数，可以据此召回。

4. thinking 最后才压缩。工具结果的截短和清理都在 thinking 之前进行。只有上下文达到压缩阈值 T 时，才通过压缩把较早的 thinking 换成摘要。依据如下。MiniMax 报告，在多轮交互中保留以前的 thinking 比丢弃它在 SWE-bench Verified 上高 2.2 分（69.4 对 67.2），在 τ²-Bench 上高 23 分（87 对 64），在 BrowseComp 上高 12.6 分（44.0 对 31.4），在 GAIA 上高 7.8 分，在 xBench 上高 6.0 分。[S15] OpenAI 报告，GPT-5 通过 Responses API 保留推理状态后，TAUBench 得分比 Chat Completions 高 5%。[S16] Anthropic 的测试显示，丢弃 thinking 会增加输出 token：每个会话丢弃一次，max 强度下增加 20.1%；第一轮之后每轮都丢弃，max 强度下增加 67.1%。[S3] 也有研究发现，任务状态已经写入代码、文件或工具输出后，有选择地删除旧推理能略微提高得分（0.699 到 0.718）并减少 token。[S17] 这说明删除推理需要条件判断，不适合作为默认行为。因此 `clear_thinking_20251015` 始终使用 `keep: "all"`，插件从不在客户端删除 thinking。达到 T 时优先使用原生压缩：Anthropic 的摘要请求会读取被摘要范围内的 thinking，近期保留轮次的 thinking 继续有效；OpenAI 的压缩项也携带以前的推理状态。[S2, S10, S11]

5. 内置工具省 token，并遵循上下文工程的基本做法。模型只看到一个工具 `recall`，它有两个可选参数，说明加参数约 100 个 token。插件不向系统提示添加内容。被清理结果的占位文字约 20 个 token。发给模型的文字固定、可以复现，不含时间戳或计数器，以免改变前缀和缓存。错误信息用一句话说明原因和下一步。只给用户看的功能（状态和统计）放在 `/context` 命令和状态栏，不放进模型工具。大的召回结果按 Pi 的惯例处理：只返回开头部分和完整文件路径，由模型用 `read` 分段读取。[S5]

6. 轻量，开箱即用。安装后不需要任何设置。所有阈值由模型窗口和 Pi 已有的 `compaction` 设置（包括 `modelOverrides`）算出。插件不预先探测能力：第一次需要时直接尝试原生方法，如果失败原因是不支持，就记住这个服务商、接口和模型，本会话不再尝试。插件不建数据库、索引或哈希库，不做跨会话检索，不实现阈值压缩模式。它替代 `pi-better-compaction`，同一时间只启用一个管理历史的插件；它与只在首次发送前压缩输出的插件（例如 `pi-rtk-optimizer`）共存，不重复处理已截短的结果。

7. 回退压缩可以指定模型。设置 `fallbackModel`（格式为 `provider/model`）和 `fallbackThinking` 后，回退压缩使用这个模型，例如更便宜或更快的模型。回退压缩只用于三种情况：服务商没有原生压缩；当前模型不支持原生压缩；原生压缩重试一次后仍然失败。原生压缩始终使用会话原模型，因为保留轮次的 thinking 要保持有效，压缩请求必须运行在具备 preserved thinking 的模型上，最简单的做法就是使用会话原模型。[S10]

## 2. 总体流程

1. 工具结果首次进入上下文前：结果超过 Pi 的上限时截短，完整内容写入文件，结果末尾写出文件路径（第 5.1 节）。
2. 每次 Anthropic 请求：请求体带上服务端清理配置（第 5.2 节）。
3. 其他服务商：在 `turn_end` 边界成批追加 `context_edit`，把旧的大结果换成占位文字（第 5.3 节）。
4. 模型需要旧结果：调用 `recall`，原文作为新的工具结果返回（第 5.4 节）。
5. 达到压缩条件：Anthropic 用按需压缩，OpenAI 用压缩接口，其他模型用 Pi 压缩；原生方法失败时回退（第 6–9 节）。

## 3. 依赖的 Pi 接口

固定 Pi 的发布版本（本文基于 1.2.0），用目标版本的类型检查和实际运行确认下列接口。[S4, S5]

| 接口 | 本插件用途 |
| --- | --- |
| `tool_result` | 首次发送前截短超限结果 |
| `before_provider_request` | 为 Anthropic 请求加入 `context_management` 和 `betas`；回放原生压缩块 |
| `provider_stream_event` | 读取 `input_transformations`、`context_management.applied_edits` 和压缩块 |
| `turn_end` | 为其他服务商追加 `context_edit`；检查是否需要压缩 |
| `session_before_compact` | 选择原生压缩或回退压缩，把结果交给 Pi 写入压缩条目 |
| `session_start`、`model_select` | 从当前分支恢复状态；检查压缩块能否发给新模型 |
| `ctx.modelRegistry.streamSimple()` | 复用 Pi 的服务商适配器发送压缩请求，鉴权、代理和请求头都由 Pi 处理 |

Anthropic 的 beta 名称直接加到请求体的 `betas` 数组。Pi 通过 SDK 的 `betas` 参数生成 `anthropic-beta` 请求头，所以插件不需要 `before_provider_headers`。不要在模型设置中写 `anthropic-beta`：Pi 遇到这个设置时会用它代替自己计算的 beta 列表，`thinking-binding-controls-2026-08-01` 和 `inline-tools-2026-09-15` 等功能会因此缺失。[S9]

## 4. 状态

Pi 会话 JSONL 已经保存完整会话树和每个工具结果的原文，插件把它作为唯一的原文来源。插件只另外保存三类数据：

- 原生压缩结果：放在 Pi 压缩条目的 `details` 中，包括原样的压缩块或压缩窗口、服务商、接口、模型和格式版本。
- 首次发送前被截短的完整输出：写入会话文件旁的目录（例如 `<session>.outputs/<toolCallId>.txt`）；Pi 的 `bash` 已经提供 `fullOutputPath` 时直接使用它。
- 会话级状态（不支持原生压缩的模型、统计数字）：用 `pi.appendEntry()` 写入自定义条目，重启后从当前分支重建。

分支由 Pi 的会话树处理：召回只读当前分支上的条目，`context_edit` 和压缩条目都只在所在分支生效。原生压缩只在完整收到压缩块后才把结果交给 Pi；没有收到完整块时，插件不返回结果，转入回退流程。

## 5. 清理与召回

### 5.1 首次发送前截短

Pi 内置的 `read` 和 `bash` 已经把模型看到的内容限制在 2,000 行或 50 KB，`bash` 还会把完整输出写入 `fullOutputPath`。插件只处理超过同一上限、而且没有被其他工具或插件截短的结果，主要是 MCP 工具和自定义工具。处理方法是：用 Pi 导出的 `truncateHead` 或 `truncateTail` 截短，把完整内容写入文件，在结果末尾加一行文件路径。截短后的结果保留错误信息、退出码、文件路径和定位行号。截短只在首次发送前进行，之后不再改动这个结果。[S3, S5]

### 5.2 Anthropic：服务端清理

从会话第一个请求开始，每个 Anthropic 请求都带同一份配置。T 是第 6 节的压缩阈值。

```javascript
payload.betas = [...new Set([...(payload.betas ?? []), "context-management-2025-06-27"])];
payload.context_management = {
  edits: [
    // thinking 策略放在数组首位
    { type: "clear_thinking_20251015", keep: "all" },
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: Math.round(0.5 * T) },
      keep: { type: "tool_uses", value: 8 },
      clear_at_least: { type: "input_tokens", value: Math.max(20_000, Math.round(0.1 * T)) },
      clear_tool_inputs: false
    }
  ]
};
```

服务端清理在请求到达模型前进行，客户端历史保持不变。在 Claude Fable 5.1、Opus 5.5、Sonnet 5.5 和 Haiku 5.5 上，服务端上下文管理不会使 thinking 失效。[S6] 清理会让提示缓存从第一个被清理的位置开始重新写入；`clear_at_least` 保证每次清理的量足以抵消这次缓存重写。8、50% 和 10% 是起始值，用第 12 节的测试调整。如果网关已经在请求中加入 `context_management`，合并两份配置，不重复加入。

插件从响应最后的 `message_delta` 读取 `applied_edits`，记录清理次数和 `cleared_input_tokens`，用于状态栏和第 6 节的原始用量。

### 5.3 其他服务商：Pi `context_edit`

OpenAI 和其他服务商没有清理旧工具结果的服务端方法。插件在 `turn_end` 边界追加 `context_edit` 条目，让 Pi 在构建上下文时把旧结果换成占位文字；原始条目保持不变。[S18] 选择规则与 5.2 相同：有效用量超过 0.5 T 时，从旧到新选择最近 8 次工具调用之外、大于 1 KB 的结果，凑够至少 0.1 T 后一次追加。成批追加能减少提示缓存失效的次数。

占位文字示例：`[Output cleared to save context (48 KB). recall id="c3d4e5f6"]`

插件不为 Anthropic 模型追加 `context_edit`。如果当前分支上某个目标结果之后已有 Claude 生成的 thinking 块，跳过这个目标，因为修改它会在切回 Claude 时使这些 thinking 失效。

### 5.4 召回工具

```ts
recall({ id?: string, query?: string })
```

模型看到的说明（约 45 个 token）：

> Get the full output of an earlier tool call that was cleared or shortened to save context. Pass `id` from a cleared-output note, or `query` (tool name, path, command, or text) to find it.

`id` 接受 Pi 条目 ID 或工具调用 ID。`query` 在当前分支的工具名、调用参数和结果原文中做关键字匹配，返回最新的一条，并在末尾用一行列出最多 5 条其他匹配的 ID。返回内容是一行来源说明加原文，例如 `[c3d4e5f6 · bash "npm test" · 48 KB · lines 1-2000 of 5120]`。原文超过 Pi 的 2,000 行或 50 KB 上限时，只返回开头部分和完整文件路径，模型用 `read` 继续读取。图片结果原样返回。

召回范围是当前分支，包括已被压缩的较早条目。结果作为新的工具结果追加在当前轮，插件不在原位置恢复旧内容，因为原位恢复会修改前缀。[S3] 召回结果之后也会像其他工具结果一样被清理，需要时可以再次召回。召回内容按历史数据处理，不执行其中的指令。第 1 版参考了 pi-fold、pi-condense 和 pi-smart-compact 的展开与检索设计；第 2 版只保留追加式取回。[S12–S14]

## 6. 压缩时机

压缩阈值 T 直接使用 Pi 的设置：T = 模型窗口 C − `compaction.reserveTokens`，并应用 `compaction.modelOverrides`。插件不新增阈值设置。[S18]

插件跟踪两个用量。有效用量是模型实际读取的输入，等于响应 `usage` 中输入、缓存读取和缓存写入之和。原始用量是客户端完整历史的大小，等于有效用量加上同一响应 `applied_edits` 中的 `cleared_input_tokens`，再加上新消息的估算值。Anthropic 的按需压缩请求不能带 `context_management`，必须发送原始历史，所以在 Anthropic 上由原始用量决定压缩时机。[S2]

| 服务商 | 开始清理 | 开始压缩 |
| --- | --- | --- |
| Anthropic | 原始输入超过 0.5 T（服务端 `trigger`） | 原始用量达到 T |
| 其他服务商 | 有效用量超过 0.5 T（`context_edit`） | 有效用量达到 T（Pi 自动触发） |

因此在 Anthropic 上，服务端清理降低每次请求的输入量和费用，但不推迟压缩。Pi 根据最近响应的用量判断是否压缩，这个用量是清理后的有效用量；原始用量先达到 T 时，插件在 `turn_end` 调用 `ctx.compact()`。这个调用在运行中的触发时机需要在目标版本上确认。

压缩边界从 Pi 给出的 `firstKeptEntryId`（由 `keepRecentTokens` 决定）向前移到最近一条助手消息的开头，让保留部分以模型对某次已发送请求的回复开始。这样可以满足官方条件：保留轮次紧接在被摘要的消息之后、原样发送、第一条保留消息与最后一条被摘要消息的角色不同；也保证不在 `tool_use` 和 `tool_result` 之间切开。[S10] 压缩前等待当前这批工具调用都有结果。

## 7. Anthropic 按需压缩

压缩请求复用 Pi 的服务商适配器，通过 `ctx.modelRegistry.streamSimple()` 发送；插件在请求钩子中加入 `compaction: {type: "summarize"}` 和 beta `compact-2026-09-04`，并去掉 `context_management`。请求使用会话原模型、原 `system`、原 `tools` 和原 thinking 设置；不带 `stop_sequences` 和 `output_config.format`，`tool_choice` 不能是 `any` 或 `tool`。`max_tokens` 同时限制摘要前的 thinking，起始值设为 16,000。[S2]

响应只含一个完整的 `compaction` 块，流式传输时也一次到达。Pi 适配器不处理这种块，所以插件以 `provider_stream_event` 中的原始事件为准，把块原样存入压缩条目的 `details`，块中的文字同时作为 Pi 的摘要文字。之后的 Anthropic 请求在 `before_provider_request` 中把 Pi 的摘要消息换成这个块，放在 `messages` 首位，并继续带 `compact-2026-09-04`；保留轮次和新消息原样跟在后面。[S2, S8]

没有得到摘要时，按 `stop_reason` 处理：`max_tokens` 时增大 `max_tokens` 重试一次；`model_context_window_exceeded` 时减少被摘要的消息后重试一次；`tool_use` 时加入要求不调用工具的 `instructions` 后重试一次；`refusal` 或 `end_turn` 时进入回退压缩。[S2]

压缩块可以发给其他 Claude 模型，API 会接受它；保留轮次中新模型不能读的 thinking 会被丢弃。[S10] 压缩块不发给其他服务商；切到其他服务商时，Pi 使用块中的摘要文字。

后续可以加入后台压缩：Anthropic 支持在任务继续时生成摘要，Pi 的 `turn_end` 可以追加压缩条目，两者结合可以不暂停任务。第一版只做同步压缩。[S1, S5]

## 8. OpenAI 原生压缩

Pi 触发压缩时，插件调用 `POST /v1/responses/compact`，发送当前完整窗口，保存返回的整个 `output`，把它原样作为下一轮输入的开头，再追加新消息。返回窗口中的项目一个也不删，包括加密的压缩项，它携带以前的状态和推理。[S11] 普通请求中的服务端阈值压缩（`context_management` 加 `compact_threshold`）作为后续选项。订阅或转发通道需要单独测试；不支持时记住结果并回退。[S7, S11]

加密压缩项只能发回 OpenAI。切到其他服务商时，插件用回退模型从本地原文生成一次可读的交接摘要。

## 9. 回退与失败处理

失败时的处理顺序是：原生方法 → 临时错误重试一次 → 回退压缩（使用 `fallbackModel`，未设置时使用当前模型）→ Pi 默认压缩。插件不会为了等待用户选择而停止任务；每次转到下一步时，在状态栏提示一次。

回退压缩调用 Pi 导出的 `compact()`，使用 Pi 的摘要格式；Pi 序列化对话时不包含 thinking。[S18] 在 Anthropic 上，客户端写的摘要会使保留轮次的 thinking 无法通过前缀检查。Pi 对这些模型发送 `prefix_mismatch_behavior: "drop_block"`，所以请求会继续，API 只丢弃这些 thinking 一次，插件提示一次。这是回退路径可以接受的代价。[S3, S9]

插件不把 Pi 的 `drop_block` 改为 `error`，因为 `error` 会让任务在中途失败。插件读取每个响应的 `input_transformations`；出现 `prefix_binding_mismatch` 时，在状态栏计数并显示第一个失效块的 `path`，说明某个插件改动了历史。Anthropic 建议的做法也是统计并提醒。[S3] 测试时可以临时使用 `error`（第 12 节）。

插件不实现阈值压缩（`compact_20260112`）。它不能保留重新插入轮次中的 thinking，按需压缩已经覆盖它的用途，Anthropic 也建议在可用时使用按需压缩。[S1]

## 10. 设置

所有设置都是可选的；配置文件不存在时全部使用默认值。

```jsonc
// ~/.pi/agent/extensions/<插件名>/config.json
{
  "fallbackModel": null,     // 回退压缩模型，格式 "provider/model"；null 表示当前模型
  "fallbackThinking": "off"  // 回退压缩的 thinking 级别
}
```

阈值来自 Pi 的 `compaction` 设置。清理比例和保留数量是内部常数，测试后确定，不开放为设置。用户命令只有 `/context`，显示有效用量和原始用量、清理次数和释放量、压缩次数和方式、thinking 丢弃次数，以及原生能力状态。

## 11. 模块与开发顺序

| 顺序 | 模块 | 完成条件 |
| --- | --- | --- |
| 1 | `budget.ts`、`anthropic.ts` | 清理配置随每个 Anthropic 请求发送；能读到 `applied_edits` 和 `input_transformations`；相邻请求的前缀不变 |
| 2 | `capture.ts`、`recall.ts` | 超限结果在首次发送前截短并写入文件；`recall` 按 ID 和关键字取回逐字一致的原文；压缩、切换分支和重启后仍然有效 |
| 3 | `compact-anthropic.ts`、`replay.ts` | 按需压缩能连续执行两次；在 `error` 模式下保留轮次的 thinking 通过检查；重启后继续回放 |
| 4 | `compact-openai.ts` | 压缩窗口原样回放；能连续压缩两次并在重启后恢复 |
| 5 | `edits.ts`、`fallback.ts`、`status.ts` | 其他服务商的 `context_edit` 成批生效；回退顺序正确；`/context` 显示统计 |

## 12. 验收测试

确定性测试检查请求和状态：相邻两次 Anthropic 请求的 `system`、`tools` 和共有的 `messages` 完全相同；召回结果与会话文件中的原文逐字一致；`context_edit` 只作用于预期条目，并跳过 Claude thinking 之前的目标；压缩边界从助手消息开始；工具调用没有全部返回时不压缩；连续两次压缩、切换分支和重启恢复后状态正确。

真实模型测试使用会进行前缀检查的模型（例如 Claude Fable 5.1），并临时设置 `prefix_mismatch_behavior: "error"`。依次验证：产生 thinking；服务端清理旧结果；`recall` 用关键字取回；继续请求成功且 `input_transformations` 为空；按需压缩并保留近期轮次；下一次请求成功；切到其他模型再切回；重启后继续。测试前确认历史中确实有 thinking 块，否则“零丢弃”没有意义。[S3, S10]

效果测试比较三组：Pi 默认压缩；只清理；清理加原生压缩加召回。固定模型、thinking 级别、工具和任务，多次运行。比较任务通过率、输出 token、含缓存读写的费用、压缩次数、召回次数、召回后是否重复操作、thinking 丢弃次数。用结果确定 0.5 T、0.1 T 和保留 8 次这三个起始值。

## 资料索引

S1–S3、S6、S10–S11、S16 为服务商官方文档；S4–S5、S7–S9、S12–S14、S18 为项目文档或源码；S15 为模型厂商的测试报告；S17 为论文。本计划的阈值、模块划分和失败策略是设计建议。

```text
[S1] Anthropic — Compaction overview / threshold
https://platform.claude.com/docs/en/build-with-claude/compaction
https://platform.claude.com/docs/en/build-with-claude/compaction-threshold

[S2] Anthropic — Compaction on demand
https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand

[S3] Anthropic — Preserved thinking
https://platform.claude.com/docs/en/build-with-claude/preserved-thinking

[S4] Pi — Extension types
https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts

[S5] Pi — Extensions documentation
https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

[S6] Anthropic — Context editing
https://platform.claude.com/docs/en/build-with-claude/context-editing

[S7] pi-better-compaction — README
https://github.com/lll9p/pi-better-compaction

[S8] pi-better-compaction — Runtime and Anthropic implementation
https://github.com/lll9p/pi-better-compaction/blob/main/src/extension-runtime.ts
https://github.com/lll9p/pi-better-compaction/blob/main/src/anthropic-compaction.ts

[S9] Pi — Anthropic adapter
https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/anthropic-messages.ts

[S10] Anthropic — Compaction and preserved thinking
https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks

[S11] OpenAI — Compaction
https://developers.openai.com/api/docs/guides/compaction

[S12] pi-fold — peek / expand / in-place folding
https://github.com/shaneconner/fold

[S13] pi-condense — recoverable tool calls / context_tree_query
https://github.com/jjuraszek/pi-condense

[S14] pi-smart-compact (Pi Continuity) — archived tool output and cross-session evidence search
https://github.com/alpertarhan/pi-smart-compact/blob/main/ARCHITECTURE.md

[S15] MiniMax — Interleaved Thinking Unlocks Reliable MiniMax-M2 Agentic Capability (2025-11-03)
https://www.minimax.io/news/why-is-interleaved-thinking-important-for-m2

[S16] OpenAI — Why we built the Responses API
https://developers.openai.com/blog/responses-api

[S17] When Can Agents Forget Their Reasoning? ICLR for Long-Horizon Agent Context Compression (arXiv:2609.29875)
https://arxiv.org/abs/2609.29875

[S18] Pi — Compaction reference; session format (ContextEditEntry)
https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md
https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
```
