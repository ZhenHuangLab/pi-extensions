# pi-pleat 框架

为超长时间 agent 工作以及超长对话而生。

状态：v0.1.0 已实现，宿主为 Pi 1.2.0。本文记录已实现的设计，行为以 `src/` 为准。实测范围见
[验证记录](validation.md)，未完成的验证和评估见[路线图](roadmap.md)。

“已验证”只指验证记录中列出的模型、通道、版本和检查；设计说明不能代替测试。

## 1. 产品范围

pi-pleat 管理当前会话的上下文大小和压缩过程。处理顺序是清理旧工具结果、按需取回结果，
最后在达到阈值时压缩历史。thinking 默认保留，由支持的原生压缩方法处理被摘要范围内的推理。

首版使用 Pi 的会话树、压缩条目和 `context_edit`。模型只获得一个 `recall` 工具；
用户通过 `/context` 查看状态，通过 `/context fallback` 为当前会话切换回退摘要模型。首版不加入
跨会话记忆、数据库、语义索引或后台压缩。

插件与其他修改历史或接管压缩的扩展互斥。只在首次发送前改写工具结果的扩展可以共存。
Pi 1.2.0 把 `tool_result` 和 `message_end` 改写后的结果写入 JSONL，模型看到的也是这个版本
（见[验证记录](validation.md#仓库复测)），所以召回不会绕过在这两处脱敏的扩展。只在每次请求时
临时改写内容的扩展（例如使用 `context` 事件）不改变 JSONL；它能否遮住召回的输出，取决于它
是否处理所有工具的结果。请求快照取自 pi-pleat 的 `before_provider_request` 返回值；在它之后
再改写请求体的扩展会使快照与实际 HTTP body 不一致，这种组合不在支持范围内。

虚拟模型不在支持范围内。当前选择没有正的窗口大小或 base URL 时，处理请求、回复和压缩的事件
处理器不做任何事，`/context` 显示 `no physical model selected`，`recall` 仍可使用。处理回复的
处理器还要求 assistant 消息的 provider、API 和模型与当前选择一致。

## 2. 设计原则与约束

### 设计原则

1. Anthropic 优先适配 preserved thinking。会话内 `system` 和 `tools` 保持不变，客户端不修改已经发送的消息。旧工具结果只由服务端清理；取回内容作为新的工具结果追加。
2. 上下文管理优先使用官方原生方法：Anthropic 服务端清理和按需压缩、两个 OpenAI Responses 通道使用的 Codex 官方客户端 Responses-trigger，以及 Pi 的 `context_edit` 和压缩条目。插件代码只处理这些方法没有覆盖的部分：召回、非 Anthropic 通道的清理选择，以及 Pi 尚未支持的原生压缩响应和回放。
3. 用清理加召回释放空间。清理按简单、可预测的顺序进行，被清理的结果都可以召回；结果是否还有用，由模型在需要时通过召回判断（第 8 节）。
4. thinking 最后才压缩。客户端从不删除 thinking，`clear_thinking_20251015` 使用 `keep: "all"`；达到压缩阈值后，才由原生压缩处理被摘要范围内的推理。
5. 模型可见的内容尽量少，高效利用 token，遵循 SOTA 的 prompt engineering/context engineering 实践。模型只看到一个 `recall` 工具，插件不向系统提示添加内容；发给模型的文字固定，不含时间戳或计数器。状态和统计只在 `/context` 中给用户看。
6. 轻量，开箱即用。阈值由模型窗口和 Pi 的 `compaction` 设置得出，清理参数使用默认值，也可通过 `pi-pleat.clearing` 设置；回退摘要的模型和 thinking 级别同样可选，可以在对话中用 `/context fallback` 为当前会话切换。
7. 回退摘要可以使用指定模型。原生压缩始终使用会话模型，使保留轮次的 thinking 继续有效。

保留 thinking 的依据来自模型厂商的测试。MiniMax 对 M2 的测试中，保留前几轮 thinking 后，
SWE-bench Verified 由 67.2 升到 69.4，τ²-Bench 由 64 升到 87，BrowseComp 由 31.4 升到 44.0。
Anthropic 在多轮编程测试中发现，max 强度下每个会话丢弃一次 thinking，输出 token 增加 20.1%；
第一轮之后每轮都丢弃，增加 67.1%。来源见[研究报告](references.md#研究报告)和
[Preserved thinking](references.md#服务商)。这些结果支持默认保留，不能证明每种任务下
保留全部历史都最优；实际任务通过率、费用和延迟仍需对照验证。

### 不变约束

1. 已保存的原始条目保持不变。客户端清理通过追加 `context_edit` 表达。
2. `tool_use` 与对应结果共同保留；一批工具结果未齐全时不压缩。
3. 压缩输出覆盖的范围和保留范围必须连续，不能漏掉或重复消息。
4. 只有完整、成功且仍适用于当前会话状态的压缩结果可以提交。
5. 使用模型的真实服务商、API、有效端点和模型标识判断能力。普通推理成功不代表压缩可用。
6. 未知能力、请求错误和统计缺失要明确表示。没有 thinking 的请求不能证明 thinking 保留成功。

## 3. 模块职责

| 文件 | 负责 | 不负责 |
| --- | --- | --- |
| `src/index.ts` | 注册 `recall` 和 `/context`；接入 Pi 事件；装配模块；去重的提示和最近诊断 | 直接发送模型请求 |
| `src/session.ts` | 通道标识；能力记录和回退覆盖条目；压缩 details 格式与校验；覆盖范围；工具结果记录 | 选择清理策略 |
| `src/budget.ts` | 由模型窗口和 Pi `compaction` 设置计算阈值；清理设置校验和 4,096 安全 tokens；Anthropic 清理前大小；用量统计与保守的 applied_edits 归属 | 修改消息 |
| `src/recall.ts` | 当前分支按 ID 或查询取回；超长结果写临时文件；检查输出文件引用 | 原位恢复历史、重跑命令 |
| `src/edits.ts` | 非 Anthropic 通道的批量 `context_edit` 草案与占位文字 | 修改 JSONL 或 thinking |
| `src/requests.ts` | 请求快照与回复条目的绑定；原生状态回放的校验与拼接 | 决定何时压缩 |
| `src/compact.ts` | 唯一压缩协调器：选择方法、重试、状态检查、能力记录、回退 | 自己写入压缩条目 |
| `src/fallback.ts` | 解析回退摘要模型；生成 Pi 格式文本摘要（必要时分块）；Anthropic `turn_end` 回退的切点 | 擅自切换到未配置的服务商 |
| `src/status.ts` | `/context` 文本；`/context fallback` 的解析与写入 | 添加模型提示或工具 |
| `src/providers/http.ts` | 两个原生请求共用的捕获 `fetch`：先记录 HTTP 状态和 `retry-after`（`retry-after-ms`、秒数或 HTTP 日期），把响应读到 EOF，再交给 Pi 一份副本；记录网络或读取失败 | 解析服务商协议 |
| `src/providers/anthropic.ts` | 清理参数；原生压缩请求；完整原始 SSE、签名块与用量的校验 | 把 Pi 归一化错误当作成功 |
| `src/providers/openai.ts` | Responses-trigger 请求、完整 SSE 校验、压缩窗口与用量 | 使用独立 `/responses/compact` 端点 |

使用普通函数和明确的数据类型连接这些模块，不引入插件框架、策略注册系统或数据库。
服务商模块只返回候选结果；提交由 Pi 的事件返回值完成。

## 4. 数据来源与持久化

### 4.1 召回的内容

召回恢复工具结果被清理前模型看到的内容。来源是当前分支的 Pi JSONL 中进入模型上下文的
顶层工具结果，召回内容与该结果的 `content` 逐字一致。`details` 不发送给模型，召回也不返回它。
Pi 已经截掉、且未保存的内容不能靠插件重建。

工具结果的长度在首次发送前由 Pi 和工具限制。Pi 的 `read` 和 `bash` 输出不超过 2,000 行或
50 KB；MCP 文本结果超过 20 KB 时去掉中间部分，完整内容写入临时文件。Pi 的扩展文档要求
其他工具自行截短，并告诉模型完整输出的位置。pi-pleat 不增加第二道截断：首次发送前的限制
已经存在，发送后又不能在客户端缩短（第 8 节）。不遵守该要求的工具会把完整结果送入模型，
这类结果由正常的清理和压缩处理。

工具给出的 `fullOutputPath` 或输出文件路径只是引用，可能指向临时文件。召回时检查文件是否
仍然存在并报告结果，不承诺它长期存在。不能把后来重跑工具或重新读取已变化文件的结果当作原文。

带 `parentToolCallId` 的嵌套调用服务于调用它的程序，例如 codemode。Pi 不为这些调用保存
独立的结果条目；召回只覆盖最终送入模型的父工具结果。

### 4.2 存储位置

Pi 会话条目保留原始消息和分支关系，原文只存在于 Pi JSONL。原生压缩块或窗口放在压缩条目的
`details`。插件的小型状态是两类自定义条目，不加入模型上下文：`pi-pleat.capability` 保存能力记录
（第 7.3 节），`pi-pleat.fallback` 保存 `/context fallback` 的会话覆盖。两类条目都只从当前分支读取，
同一键以分支上最新的有效条目为准，重启后仍然有效。

请求快照、回复用量、清理和回退计数、最近 5 条诊断只在内存中，`session_start` 和
`session_shutdown` 时清空。超长召回结果使用的临时文件每次从 JSONL 重新生成，不属于会话存储。

### 4.3 压缩记录

pi-pleat 写入的压缩条目 `details`：

| 字段 | 含义 |
| --- | --- |
| `plugin`、`version` | 固定为 `"pi-pleat"`、`1` |
| `strategy` | `anthropic`、`responses-trigger` 或 `pi-summary` |
| `provider`、`api`、`endpoint`、`model` | 生成该结果的通道；`endpoint` 是去掉用户信息、查询参数和 fragment 的 base URL |
| `firstCoveredEntryId`、`lastCoveredEntryId` | 当前投影中被替换的第一个和最后一个有内容的条目，可以是上一个压缩条目 |
| `firstKeptEntryId` | 保留后缀的第一个条目，必须与压缩条目的同名字段相同 |
| `native` | Anthropic：返回的完整签名块、请求 `system` 和 `tools` 的 SHA-256（键排序后的 JSON）、首个保留 assistant 的 thinking 签名和 tool_use ID；Responses：保留的用户消息加完整 compaction 项组成的窗口 |
| `reason`、`readFiles`、`modifiedFiles` | `pi-summary`：没有使用原生方法的原因，以及 Pi 格式的文件列表 |
| `usageComplete` | 只在用量不完整时写入 `false`：某个请求没有报告用量，`usage` 缺失或只含已知部分 |

压缩条目的 `summary`：Anthropic 为签名块中的摘要文字；Responses 为回退摘要模型并行生成的可读摘要；
`pi-summary` 为文本摘要。`usage` 记录压缩请求的已知用量，Responses 为原生请求与可读摘要之和；
服务商没有报告的部分不补零。`details` 形状校验失败的条目按普通 Pi 摘要处理，不回放。不保存认证头。

重启只从当前分支重建状态。回放只读取分支上最新的压缩条目，不选择其他分支的压缩块，
也不在最新压缩失效后回放更旧的块。

## 5. 运行流程与提交

```text
before_provider_request
  → 校验并回放当前分支最新压缩条目的原生状态
  → Anthropic：加入服务端清理配置
  → 记录最终请求快照
message_end → turn_end
  → 把快照绑定到成功回复的 assistant 条目
  → Anthropic：清理前大小超过阈值时，返回 compaction 草案
  → 其他通道：超过清理触发点时，返回一批 context_edit 草案
session_before_compact（Pi 阈值、/compact、溢出恢复）
  → 同一协调器：原生压缩、文本摘要、交回 Pi 或取消
agent_before_settle
  → 清理不受支持时的一次恢复（第 7.1 节）
```

Anthropic 运行中的主动压缩使用 `turn_end` 返回 `compaction` 草案。不得在这里调用 `ctx.compact()`：
Pi 1.2.0 的该入口会先中止当前运行，且不会自动恢复它。`turn_end` 只在本轮 `outcome` 为 `completed`、
且 `compaction.enabled` 不为 false 时压缩。

手动 `/compact`、Pi 自动阈值压缩和溢出恢复通过 `session_before_compact` 调用同一个协调器。
协调器本身不写压缩条目；`turn_end` 和 `session_before_compact` 各自返回一次结果，避免重复提交或递归。
`session_before_compact` 的结果有三种：返回 `compaction`；不返回，由 Pi 用会话模型做默认压缩；
返回 `cancel: true` 并提示原因。处理 Pi 的手动压缩时遵守其停止当前任务的既有语义。

协调器状态为 `idle → preparing → requesting → validating → idle`。同一扩展实例的压缩操作串行执行，
新的操作等待前一个结束。开始时记录会话 ID、分支叶节点和通道；每次服务商请求之后、返回结果之前
重新检查它们和取消信号。取消、切换会话/分支/模型或叶节点变化使候选结果失效：丢弃结果，
不重试，不进入回退，保持原有有效状态。压缩期间状态栏显示 `compacting…`。

首版采用同步边界压缩。新消息的排队和继续执行交给 Pi；不自行启动另一个 agent。`turn_end`
从不请求 `continue`；唯一的 `continue` 来自清理不受支持时的一次恢复。

## 6. 请求边界与回放

### 6.1 请求绑定

`requests.ts` 记录 pi-pleat 在 `before_provider_request` 返回的请求体。回复以 `stop` 或 `toolUse`
结束并在 `turn_end` 持久化后，该请求绑定到回复的 assistant 条目。绑定按事件顺序进行，不比较
对象身份，因为前面的扩展可以在 `message_end` 替换消息对象。一个快照只能绑定一次；Anthropic 的
`max_tokens: 1` 请求（Pi 缓存预热使用该值）不记录、不绑定。绑定只在其 assistant 条目仍在当前分支、
且通道相同时可用。

### 6.2 Anthropic 原生边界

只压缩最近一次实际发送、且其回复成为第一个保留条目的请求 R。压缩请求复用 R 的请求体，
返回块替代 R 的全部 `messages`；R 的回复 A 就是 `firstKeptEntryId`。压缩块因此恰好代替 A 生成时的
完整前缀，A 紧跟在块之后；严格前缀绑定下的真实检查接受了这种回放（见验证记录）。

满足以下全部条件才发送原生请求：

- R 和 A 存在，A 在当前投影中，A 之前有可覆盖的内容；
- A 的每个工具调用在 A 之后都有对应结果；
- 当前投影只有一个 system 消息。会话中改过提示或工具时，Pi 的 checkpoint 会改变 `system` 或
  `tools`，保留的 thinking 无法证明有效，原因记为 `system-changed`；
- R 的 `max_tokens` 不小于 4096。Pi 按输入后的剩余空间限制实际请求的 `max_tokens`，原生请求复用同一
  输入和同一输出额度；`reserveTokens` 只决定触发点，不是原生请求的预算。

条件不满足时使用文本摘要。A 到叶节点的保留后缀估算值单独超过阈值 T 时，原生摘要无法缩小这部分，
本次压缩跳过（原生和文本摘要都不做），保留历史并提示。原生结果提交前还要通过第 9 节的窗口检查。

### 6.3 Responses 切点

Responses 通道使用 Pi 准备的切点 `firstKeptEntryId`，由 `keepRecentTokens` 决定。前缀是当前投影中
切点之前的全部消息，包括 system 消息，所以压缩请求的 `instructions` 和 `tools` 与普通请求相同。

两个协议都只压缩切点之前的连续前缀，然后追加未覆盖的保留后缀。不发送整个当前窗口去压缩后，
又追加一份已覆盖的近期历史。这使 Pi 的 `firstKeptEntryId` 保持明确，也避免依赖手动压缩结果类型
尚未表达的 retain-none 行为。

### 6.4 回放校验

每个请求只考虑当前分支最新的压缩条目，且其 details 的 provider、API、endpoint、model 必须与当前模型
完全相同；否则不回放，模型读到条目的可读摘要。回放只在固定位置校验，不在历史中搜索摘要文字，
也不丢弃窗口中的项目：

- Anthropic：`messages[0]` 必须是只含压缩摘要文字（Pi 对 compactionSummary 的转换结果）的用户消息；
  其后跳过 Pi 的 effort 标记（`{role: "system", content: [], output_config}`），下一个必须是保留的
  assistant，其 thinking 签名（redacted 块用 `data`）和 tool_use ID 依次与记录相同；请求 `system` 和
  `tools` 的哈希与记录相同。通过后把摘要消息和这些 effort 标记替换为 `{role: "assistant", content: [块]}`，
  并加入 `compact-2026-09-04` beta。
- Responses：第一个输入项必须是只含一个 `input_text` 摘要文字的用户消息；`openai-responses`
  先保留 Pi 放在开头的一条 developer/system 指令。通过后把该消息替换为记录的完整窗口。

任一检查失败时请求原样发送，模型读到可读摘要，`/context` 显示拒绝原因。连续第二次压缩时，
Anthropic 绑定的请求已经以前一个块开头，Responses 前缀在发送前先换成前一个窗口，所以新压缩覆盖
当前有效的原生前缀及新内容，并替换旧状态。

## 7. 服务商与传输

### 7.1 Anthropic

适用通道为 provider `anthropic`、API `anthropic-messages`。

普通请求在 `before_provider_request` 加入 `context_management`：先放 `clear_thinking_20251015`
（`keep: "all"`；请求没有 thinking 或 thinking 为 disabled 时省略），再放 `clear_tool_uses_20250919`，
并加入 `context-management-2025-06-27` beta。请求已有 `context_management` 时保持原样，记录一次诊断；
带 `compaction` 的请求不加清理。`provider_stream_event` 从 `message_delta` 读取 `applied_edits`。

Pi 1.2.0 把有效的 `compaction` 结束原因归一化为 `Unhandled stop reason: compaction` 错误。原生压缩因此
通过 `ctx.modelRegistry.streamSimple()` 发送：`onPayload` 换成压缩请求体，`providers/http.ts` 的捕获
`fetch` 读取完整的原始 HTTP 响应，Pi 的归一化结果不作为压缩结果。认证、请求头、有效 base URL 和
传输设置由 Pi 适配器提供；代理配置未单独验证。

压缩请求体是 R 的副本：删除 `context_management`、`stop_sequences`、类型为 `any` 或 `tool` 的
`tool_choice` 和 `output_config.format`；加入 `compact-2026-09-04` beta 和 `compaction: {type: "summarize"}`；
`/compact` 的自定义说明放入 `instructions`（固定英文说明加用户内容，最多 16,384 字符）。`max_tokens`、
`system`、`tools`、`thinking` 和 `messages` 不变。

成功要求 HTTP 200，SSE 中恰好一个 `message_start`、恰好一个 `compaction` 内容块（`content` 和
`signature` 非空，没有 delta）、`stop_reason` 为 `compaction` 的 `message_delta`，最后是 `message_stop`。
用量取 `usage.iterations` 中的 compaction 项；每一项都要有有效的 input 和 output 计数，缓存计数可以
省略，出现时也必须有效。不满足时用量记为未知，details 写 `usageComplete: false`，不补零。

HTTP 状态在读取响应体之前记录，响应体读取中断时仍按状态分类。429、5xx 和流中的
`overloaded_error`/`api_error` 为暂时失败；404，或 400 且错误说明 compaction 不受支持，为不支持；
其他 4xx 为无效；没有 HTTP 错误状态时的网络或读取失败为暂时失败；没有压缩块且结束原因为
`max_tokens`、`model_context_window_exceeded`、`tool_use`、`refusal` 或 `end_turn` 为无摘要；发送前的
认证或配置错误、其他非 200 和完整性检查失败为无效。处理方式见第 9 节。

清理和压缩是两个独立能力。普通请求因清理不受支持而失败时（错误同时提到 `context_management`、
`clear_tool_uses` 等名称和 `not supported`、`Extra inputs are not permitted`、`invalid beta` 等说明），
`agent_before_settle` 用 `context_edit`（`replacement: null`）省略失败的回复，写入 clearing 不支持的
能力记录，并请求一次 `continue`。之后当前分支的 Anthropic 请求不再加清理，所以不会再次触发恢复。

### 7.2 OpenAI Responses

所有者决定（2026-10-14）：`openai-codex`/`openai-codex-responses` 和 `openai`/`openai-responses` 都使用
Codex 官方客户端的 Responses-trigger 协议，在普通 Responses 输入末尾追加 `{type: "compaction_trigger"}`。
OpenAI SDK 7.19.0 定义了 `ResponseInputItem.CompactionTrigger`，说明为 “Compacts the current context.
Must be the final input item.”（[参考资料](references.md#openai-sdk)）。不使用独立 `/responses/compact`
端点：Codex 后端对该路径返回 404，Codex OAuth 令牌访问 `api.openai.com` 被拒，Codex 官方客户端的
endpoint 模块中也没有独立压缩模块（[验证记录](validation.md#实现后的探测)）。`openai-responses`
只有本地模拟服务验证。

Responses-trigger 只在 `session_before_compact` 中运行，`turn_end` 不发送。当前通道的
responses-trigger 能力记录为不支持，或 `/compact` 带自定义说明时（该协议无法携带说明，原因记为
`custom-instructions`），本次改用文本摘要。

请求经过 Pi 的适配器发送，使用 `transport: "sse"`、`maxRetries: 0`、会话 thinking 级别和会话 ID。
`onPayload` 先按第 6.4 节把上一窗口拼入前缀（拼接被拒时不发送，本次压缩跳过），记录实际发送的
`input`，再追加 trigger。控制项不进入持久历史。Pi 的 Codex 适配器读到第一个终止事件就停止解析，
其 SSE 解析只按 LF 分帧；共用的捕获 `fetch` 因此先把 HTTP 响应读到 EOF，再把副本交给 Pi，插件独立
解析全部帧（CRLF 先换成 LF）。

成功要求：HTTP 200；Pi 结果为 `stop`；没有 `error`、`response.failed`、`response.incomplete` 事件；
恰好一个状态为 `completed` 的 `response.completed` 或 `response.done`，其后只允许一个 `[DONE]`；
完成响应的 `output` 与流中 `response.output_item.done` 的项目逐项相同；恰好一个 `encrypted_content`
非空的 `compaction` 项。用量取完成响应的 `usage`，`cached_tokens` 记为缓存读取。

窗口按 Codex 客户端规则构建：取实际发送的 `input` 中的用户消息，从新到旧累计，不超过 64,000 tokens
（文字字符数 / 4），只保留整条消息，遇到第一条放不下的消息即停止；窗口为按原顺序排列的这些消息
加完整 compaction 项。任一用户消息含 `input_text` 以外的内容（例如图片）时，本次改用文本摘要，
能力记录不变。开发者消息不作为明文保留。图片、开发者消息和多代理项的保留规则未经真实验证。

插件只在相同通道回放 opaque 窗口，其他通道和模型需要可读摘要，所以每次 Responses-trigger 压缩都
同时生成可读摘要：原生请求与可读摘要并行运行。可读摘要使用回退摘要模型（第 9 节），存为条目的
`summary`。可读摘要失败、且回退模型是另行配置的其他通道时，用会话模型重试一次；仍失败则跳过压缩、
保留历史。原生和可读摘要都成功时提交 `responses-trigger` 结果；原生可恢复失败而可读摘要成功时提交
`pi-summary` 结果；原生结果无效时跳过压缩。原生请求或可读摘要的用量不完整时，details 写
`usageComplete: false`。

失败分类：404，或 400 且错误文字提到 compaction、`compaction_trigger`、未知类型或项目、无效输入，
为不支持；401、403 和其他 4xx 为无效；429、5xx 和读取过程中的网络失败为暂时失败。HTTP 200 时先校验
完整原始流，完成后的多余事件或格式错误总是无效。

Codex 官方客户端在 2026-10-13 加入了后台压缩（[参考资料](references.md#codex-后台压缩)）。开启
`AsyncCompaction` 且活动上下文达到窗口的 `async_compaction_threshold_percent` 时，它在回合前、回合中、
回合后的检查点对捕获的历史发出压缩请求，并在之后的检查点采用已就绪的结果：采用前校验历史代数、
前缀长度、模型和认证所有者，只替换捕获的前缀，保留之后追加的消息和工具输出；采用后仍超过上限时
再做一次前台压缩。TokenBudget 开启时该功能关闭；同一历史版本、模型、压缩哈希和认证所有者只发一次。
请求协议没有变化：仍是带捕获历史和 `compaction_trigger` 的 Responses 请求，恰好一个 compaction 项，
保留规则相同。前缀的安装形状（压缩前缀加捕获之后追加的项目）也与 pi-pleat 在 Responses 通道使用的
形状（Pi 切点之前的前缀加保留后缀）相同，所以 v0.1.0 与之协议兼容。pi-pleat v0.1.0 按设计只做同步
压缩（第 1 节），后台压缩列在[路线图](roadmap.md)中。

### 7.3 能力记录与通道切换

能力记录按通道键（provider、API、endpoint、model）和功能（`clearing`、`anthropic-compaction`、
`responses-trigger`）区分，写成 `pi-pleat.capability` 自定义条目。服务端明确表示不支持时写入
`unsupported`；原生压缩首次验证成功时写入一次 `supported`，clearing 只写 `unsupported`。普通推理成功
不写记录。记录属于当前分支，不跨会话共享。`turn_end` 的记录随压缩草案一起提交；
`session_before_compact` 的记录在状态检查之后用 `pi.appendEntry()` 写入。

跨通道切换时不发送其他通道的原生块或窗口，模型读到条目的可读摘要：Anthropic 为块中的摘要文字，
Responses 为压缩时生成的可读摘要。客户端不删除原始 thinking；是否能再次原生回放取决于当前覆盖范围
和通道状态，不能承诺切回模型后全部推理自动恢复。

### 7.4 其他服务商

其他通道没有原生压缩。清理使用本地 `context_edit`（第 8.1 节）。Pi 阈值或 `/compact` 触发压缩时，
配置了回退摘要模型则由插件生成文本摘要，否则交回 Pi 用会话模型压缩。

### 7.5 Pi 1.2.0 的限制

| 限制 | 插件的处理 |
| --- | --- |
| Anthropic 适配器把 `compaction` 结束原因报告为 `Unhandled stop reason: compaction` | 自定义 `fetch` 读取完整原始响应并自行校验 |
| Codex 适配器读到第一个终止事件就停止读取 | 读到 HTTP EOF，校验完整 SSE |
| Codex 适配器的 SSE 解析只按 LF 分帧 | 解析前把 CRLF 换成 LF |
| `prepareCompaction` 没有导出 | Anthropic `turn_end` 回退按 Pi 的投影切点规则自行准备 |
| 缓存预热复用 provider 回调 | Anthropic `max_tokens: 1` 的预热请求仍得到回放和清理配置，但不记录快照、不绑定；无法归属的 applied_edits 只计入会话总数，并使回复的归属变为未知 |
| 虚拟模型按请求路由到物理模型 | 不支持；当前选择不是物理模型时处理器不做任何事 |

## 8. 清理与召回

Anthropic 的 preserved thinking 规定，客户端清空或缩短已发送的 `tool_result`，会使之后的
全部 thinking 失效。官方建议在首次发送前缩短结果，以后的清理交给服务端。因此工具结果的
长度只在首次发送前限制（见 4.1），发送后的空间由清理和召回释放。

### 8.1 清理规则

所有服务商使用同一顺序：上下文超过清理触发点后，从最早的工具结果开始清理，保留最近 K 次
工具调用，保留全部调用参数；一批达不到释放下限时不清理。K、触发点、释放下限和最小清理大小
可通过 `pi-pleat.clearing` 设置，默认值见第 9 节。

Anthropic 由服务端执行这个规则。`clear_tool_uses_20250919` 的 `trigger`、`keep` 和
`clear_at_least` 分别对应触发点、K 和释放下限，`clear_tool_inputs: false` 保留调用参数。
服务端只按时间顺序选择，小结果也会被清理。客户端不能改为按大小或用途选择，因为客户端修改
会使之后的 thinking 失效。Anthropic 通道不做本地清理。

其他服务商由 pi-pleat 在 `turn_end` 追加一批 `context_edit`。上下文大小取 Pi 的
`getContextUsage().tokens`，未知时不清理。候选是当前投影中的顶层工具结果，从旧到新排列，排除
已被 `context_edit` 指向的条目、最近 K 次工具调用的结果、小于最小清理大小（默认 1 KB）的结果（文字按 UTF-8 字节，
图片按 base64 长度），以及分支上位于最后一个 Claude thinking assistant 之前的结果：修改它们会在
切回 Claude 时使之后的 thinking 失效。替换小结果省不了多少空间，却让模型失去内容。按顺序累计
节省的估算 tokens，达到释放下限即提交这一批；全部候选也达不到下限时不清理。

占位文字只由结果大小（Pi 的 `formatSize`）和召回 ID（Pi 条目 ID）决定，例如
`[Output cleared to save context (48.0KB). recall id="c3d4e5f6"]`。

### 8.2 判断结果是否还有用

清理时不逐个判断结果的用途，这个判断在召回时由模型完成。模型调用 `recall` 时知道自己需要
什么；清理时判断则要预测以后的需要，容易出错。清错一个结果的代价只是一次召回。

让模型自己选择清理目标，需要在每次请求中加入工具说明和结果 ID，每次选择多一轮调用，
并在不确定的时间改变前缀、重写缓存。用 Jev 这类分类模型逐个判断（扩展通过
`ctx.modelRegistry.classify()` 调用），需要用户另外配置分类模型服务商的凭据，要把会话内容
发给另一家服务商，每次判断增加延迟，结果也难以复现。在 Anthropic 上，这两种方式都只能
通过客户端修改生效，会使之后的 thinking 失效。

简单规则有对照数据支持：在 SWE-agent 和 SWE-bench Verified 上，只屏蔽较早观察结果的方法
比原始代理费用减半，解决率与 LLM 摘要相当，有时略高（[The Complexity Trap](references.md#研究报告)）。
阶段 6 统计清理后不久又被召回的结果。比例高时先调整 K 和触发点；仍不够时，再为非 Anthropic
通道评估分类模型。

### 8.3 召回工具

模型只看到一个工具，插件不向系统提示添加内容：

```ts
recall({ id?: string, query?: string })
```

工具说明约 40 tokens：

```text
Get the full output of an earlier tool call that was cleared to save context.
Pass `id` from a cleared-output note, or `query` (command, path, tool name, or text) to get the newest match.
```

两个参数必须二选一。`id` 依次匹配 Pi 条目 ID（即占位文字中的召回 ID）、工具调用 ID、工具调用 ID
中 `|` 之前的部分。`query` 在当前分支的工具名、调用参数和结果文本中匹配：整条查询（小写、合并空白）
是子串，或每个词都出现。以前的召回结果不参与查询。返回最新一条匹配，末尾用一行列出其他匹配的 ID
（最多 5 个），例如 `Other matches: a1b2c3d4, e5f6a7b8`。模型需要更早的结果时，再用其中的 ID 取回。

返回内容先是一行来源说明，例如 `[c3d4e5f6 · bash "npm test" · 48.0KB]`，参数取 `command`、`path`、
`pattern`、`query`、`url` 中第一个字符串，否则取截到 80 字符的参数 JSON；出错的结果加 `· error`。
其后是原内容块。工具结果的 `details` 表明 Pi 只保存了部分输出时，来源说明加一句
`Pi kept only this part of the output.`，有 `fullOutputPath` 时再报告该文件在召回时是否存在。

在 Anthropic 上，占位文字由服务端在它收到的请求中生成，Pi 本地历史仍是完整结果，所以
pi-pleat 无法在占位文字中加入召回 ID；首次发送前加入的 ID 也会随结果一起被服务端替换。
服务端保留调用本身（`clear_tool_inputs: false`），模型用其中的命令或路径作为 `query`，
多数情况下调用一次即可取回。最新一条不是所需结果时，模型会多读一份无用结果（最多 50 KB）
并再调用一次。这份结果早于随后取回的结果，清理时会先被移除；在 Anthropic 上，它在压缩前
仍计入完整历史的大小。

召回内容超过 2,000 行或 50 KB 时，按 Pi 的惯例返回开头部分和说明行，完整文字写入
`<tmpdir>/pi-pleat/<session-id>/<entry-id>.txt`，由模型用 `read` 分段读取；该文件每次从 JSONL
重新生成。图片按原块返回。召回范围是当前分支，包括已压缩和已清理的原条目。

召回结果作为新的工具结果追加，以后也会像其他结果一样被清理。ID 不属于当前分支、找不到匹配
或参数无效时，错误用一句话说明原因和下一步。召回不重跑旧命令，也不把取回的文本当作新指令执行。

## 9. 预算、统计与失败

压缩阈值 T 沿用 Pi 的 `C − reserveTokens`，C 是当前模型的窗口，计算结果最小为 0。
`reserveTokens` 和 `keepRecentTokens` 各自依次取 `compaction.modelOverrides["provider/modelId"]`、
`compaction` 的同名设置和 Pi 默认值（16,384、20,000），只接受非负安全整数。键精确区分大小写，模型 ID
可以包含斜线。普通值无效（即使模型覆盖有效）、匹配条目不是对象或匹配字段无效时，Pi 会抛错；pi-pleat
警告并按上述顺序使用有效值或默认值，警告说明使用的值。不匹配的条目不读取；`compaction` 或其
`modelOverrides` 不是对象时，token 设置与 Pi 一样不报告问题。清理触发点和释放下限都按这个模型的 T 计算。

Anthropic 在 `turn_end` 自行触发压缩。服务端清理后的用量会低估完整历史，而原生压缩请求不能带
`context_management`，必须装入未清理的历史。因此触发值取 Pi 的上下文估算加上最新回复报告的
`cleared_input_tokens`；只在 Pi 仍使用该回复的用量时相加，即其后没有 `context_edit` 或压缩条目。
applied_edits 只在能确定属于该回复时才计入：同时打开的流、缺少 ID 的流、预热留下的未结束流和无法
对应的 `message_stop` 都使归属变为未知。归属未知或没有该回复的统计时，触发值改用当前投影全部消息的
估算值，并标记为估算。该值超过 T 时压缩。其他通道由 Pi 的阈值触发 `session_before_compact`。
缺少服务端统计时 `/context` 标记“估算”，不能把缺失值当零。

清理触发点 0.5T、释放下限 0.1T、保留最近 8 次工具调用（K）和最小清理大小 1 KB
是 `pi-pleat.clearing` 的默认值，可通过其 `modelOverrides` 按模型覆盖，由阶段 6 的对照结果评估和调整。
`triggerRatio` 接受大于 0 且不超过 1 的有限数，`floorRatio` 接受不小于 0 且小于 1 的有限数；两者按当前
模型 T 的比例计算，四舍五入后最少为 1 token。`keepToolUses` 接受不小于 1 的安全整数；`minBytes` 接受
不小于 0 的安全整数，只影响非 Anthropic 通道的本地清理，Anthropic 服务端不考虑大小。候选合计达不到下限
时不清理。按 Anthropic 的[上下文编辑文档](https://platform.claude.com/docs/en/build-with-claude/context-editing)，
释放下限越低，清理和提示缓存重写越频繁。清理减少输入内容，并不保证抵消缓存重写费用。

清理触发点不影响 thinking，对压缩时间的影响也很小。Anthropic 的压缩请求不能同时带
`context_management`，要发送未清理的历史并装入窗口，所以 Anthropic 上的压缩时间只由完整
历史的大小决定。其他服务商在上下文到达压缩阈值之前，都会清理所有符合规则的结果；触发点早晚
只改变清理发生的时间。触发点控制两件事：从什么时候开始减少每次请求的输入，以及旧结果在上下文
中保留多久。触发点早，请求更早变小；触发点晚，模型更少需要召回，清理和缓存重写的次数也可能
更少。服务端清理多久重写一次缓存尚未实测，留待阶段 6 与效果评估一起确定触发点。

原生压缩请求复用绑定请求的 `max_tokens`（至少 4,096）作为摘要输出和 thinking 空间。

回退摘要模型的输入预算是该模型的窗口减去摘要回复额度、4,096 安全 tokens 和 2,000 提示 tokens。
回复额度为 `min(floor(0.8 × reserveTokens), maxTokens)`，`reserveTokens` 按回退模型解析；该模型在 Pi 中
需要另加 thinking 预算时（Anthropic Messages 且未设 `forceAdaptiveThinking`，或 Bedrock 上较旧的 Claude
模型），按 Pi 的 `adjustMaxTokensForThinking` 再加上所选级别的 thinking 预算（Pi 的 `thinkingBudgets`
设置，默认 minimal 1,024、low 2,048、medium 8,192、high 16,384，xhigh 和 max 按 high），总额不超过
`maxTokens`。输入大小为序列化
对话、上一摘要和自定义说明的字符数 / 4。放得下时调用 Pi 的 `compact()`；放不下时按顺序分块，每块带上
前一块的摘要，最后按 Pi 格式追加文件列表；单条消息放不下时回退摘要失败。回退摘要的回复必须以 `stop`
结束、不含工具调用、文字非空；服务商错误交给 Pi 的 `retry` 设置处理。回复用量全为零时视为服务商没有
报告（Pi 在这种情况下初始化为零），不计入，并标记用量不完整。

每个压缩结果提交前还要估算压缩后的下一请求：当前 system 消息（提示和工具）、替代内容（Anthropic 为
块中的摘要文字，Responses 为窗口的 JSON，`pi-summary` 为摘要文字，按字符数 / 4）和保留后缀之和，加上
4,096 安全 tokens。超过会话模型的窗口时跳过该结果并保留历史，原因为
`compacted context does not fit the window`。交回 Pi 的默认压缩不经过这项检查。插件不通过静默删消息
解决超限；Anthropic 保留后缀单独超过 T 时直接跳过（第 6.2 节）。

Anthropic 压缩用量读取 `usage.iterations` 中的 compaction 项，存入压缩条目的 `usage`；普通请求和
压缩用量分开记账，避免只读顶层零值或重复计费。任何部分缺失时条目记 `usageComplete: false`。

| 结果 | 处理 |
| --- | --- |
| 明确不支持清理 | 写入能力记录，省略失败的回复并重试正常请求一次；不因此立即压缩 |
| 明确不支持原生压缩 | 写入能力记录，本次转文本摘要；其他功能保持各自状态 |
| 网络中断、限流、服务过载 | 原生请求最多重试三次，等待 `retry-after` 或 1、2、4 秒（最长 30 秒）；仍失败则转文本摘要 |
| 取消或会话状态变化 | 丢弃候选；不重试、不进入回退 |
| 认证/权限错误、无效请求、无法确认完整性 | 保留历史，明确报告；不归类成“模型不支持” |
| 压缩后的下一请求估计超过窗口 | 跳过该结果，保留历史并提示 |
| 原生压缩可恢复失败或条件不满足 | 已配置回退模型时由它生成文本摘要；未配置时，`turn_end` 和已发出 trigger 的 Responses 压缩使用会话模型的摘要，其他 `session_before_compact` 交回 Pi 默认压缩 |
| 指定回退模型失败 | `turn_end` 和 Responses-trigger 压缩用会话模型重试一次，其他 `session_before_compact` 交回 Pi 默认压缩；回退模型与会话模型相同时跳过并保留历史 |

回退摘要沿用 Pi 格式和工具序列化。它可能使保留的 Claude thinking 失效，所以 details 记录原因，
插件提示 `Using a text summary: <原因>.`；交回 Pi 和跳过时也提示原因。每条提示在一个会话中只显示一次。
所有允许的方法均失败时保持原历史并报告错误。

可选设置位于 Pi 设置中 `pi-pleat` 键下：`fallbackModel`（`provider/model`）、`fallbackThinking` 和
`clearing`。清理的四项均可省略，也可在 `pi-pleat.clearing.modelOverrides["provider/modelId"]` 中按模型设置；
每项依次取匹配的模型覆盖、`pi-pleat.clearing` 的同名值和默认值。键精确区分大小写，模型 ID 可以包含斜线。
普通值无效时警告并用默认值；普通的 `floorRatio >= triggerRatio` 时，两个比例都恢复默认值，只显示一条警告。
覆盖字段无效时保留解析后的普通值或默认值，警告说明使用的值。覆盖后的 `floorRatio >= triggerRatio` 时，
两个比例都恢复为解析后的普通比例，警告说明冲突值和恢复值；其他覆盖字段仍生效。
`pi-pleat` 或 `pi-pleat.clearing` 不是对象时使用全部清理默认值并警告；清理的 `modelOverrides` 或匹配条目
不是对象时警告并忽略相应覆盖。不匹配的条目不读取、不校验；普通清理设置和匹配条目中的未知键警告并忽略，
覆盖条目不能再嵌套 `modelOverrides`。设置警告在会话内去重，并保留在 `/context` 的最近诊断中。
回退摘要模型依次取当前分支最新的 `/context fallback` 会话覆盖、设置、会话模型。thinking 依次取覆盖或
设置中的级别；都未设置时，指定的模型用 `off`，会话模型用会话的 thinking 级别；最后按模型能力限制。
配置无效时记录诊断（`/context` 显示错误），改用会话模型。`/context fallback <provider/model> [level]`
确认模型存在且为物理模型后写入会话覆盖；`/context fallback default` 清除覆盖。

`/context` 显示：当前通道；有效用量、窗口与比例、估算标记、Anthropic 清理前大小、压缩阈值和清理
触发点、释放下限和 K；清理状态（服务端已应用的次数和 tokens，或本地批次数和当前分支被清理的结果数）；当前分支
各策略的压缩次数、压缩用量和费用（没有已知用量时显示 unknown，有条目缺少用量或用量不完整时标记
partial）；原生回放状态或拒绝原因；当前通道的能力记录；召回次数；服务端报告的 thinking 丢弃次数和
首个路径；回退摘要模型及其来源；最近诊断。`prefix_binding_mismatch` 是现象，不能直接归因于某个插件。

## 10. 验证边界

完整原生响应处理、Pi checkpoint 后的请求重建、原生状态的重启恢复、取消和状态变化、提交前的
窗口检查、用量完整性，以及清理和召回的规则都有确定性本地检查。Anthropic 和 Codex 的集成真实检查覆盖自动压缩、严格前缀绑定下的
回放（Anthropic）、含函数调用的保留后缀（Codex）和重启回放。实际服务端清理、真实模型下的召回、
缓存重写、摘要质量、费用与延迟、`openai-responses` 真实通道，以及 Responses 窗口中的图片和开发者
消息仍未验证，见[验证记录](validation.md#仍未验证)和[路线图](roadmap.md)。

仅把原生块存在 JSONL 中不等于恢复已通过；能从回放窗口读到标识也不等于摘要保留质量已通过。
