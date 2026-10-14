# 验证记录

日期：2026-10-14。宿主契约固定为 Pi 1.2.0。v0.1.0 插件已实现。第一部分记录插件验证；
[实现前的协议验证](#实现前的协议验证历史记录)保留实现前的记录，其中的状态描述以当时为准。

## 插件验证（v0.1.0）

### 本地测试

依赖记录在 `package-lock.json`：Pi coding-agent、pi-ai、pi-agent-core 1.2.0，OpenAI SDK 7.19.0，
TypeBox 1.3.27，TypeScript 6.0.3。

| 命令 | 结果 |
| --- | --- |
| `npm run check` | `tsc` 类型检查和 `test/*.mjs` 语法检查通过 |
| `npm test` | 168 项：164 通过，0 失败；4 项真实接口检查在未设置 `PI_CONTEXT_LIVE=1` 时跳过 |
| `PI_CACHE_RETENTION=long npm test` | 结果相同 |

本地测试使用真实的 Pi `AgentSession`、`SessionManager` 和临时会话目录。Anthropic、Codex 和 OpenAI
测试让 Pi 自带的适配器连接本地 HTTP 模拟服务（Codex 请求体为 zstd，OpenAI 经过 OpenAI SDK），按实际
HTTP body 断言；通用路径使用合成 provider。重启检查用新的会话和扩展实例重新打开同一会话文件。
测试不需要服务商凭据，CI 运行同样的两条命令。

| 文件 | 项数 | 覆盖内容 |
| --- | ---: | --- |
| `test/anthropic-native.test.mjs` | 30 | `turn_end` 原生压缩复用最后一次 HTTP body；连续两次压缩；`max_tokens` 正好 4096；保留后缀超过阈值时跳过；提交前检查替代内容和保留后缀能否装入窗口；重启回放和分支导航；通道切换；手动压缩与自定义说明；不支持、529 重试、暂时失败三次后回退、取消、状态变化、`system-changed`、完整性失败、refusal、回放拒绝；单 token 请求不绑定；发送前失败、网络失败和响应体截断时的 HTTP 错误分类与 retry-after；每个 compaction 用量项都要有有效计数，缺用量时重启后仍显示未知 |
| `test/anthropic.test.mjs` | 10 | 清理配置进入实际 HTTP body 且不改提示、工具和 thinking；已有配置保持不变；applied_edits 按回复计数，清理前大小加上已清理 tokens；清理不受支持时一次恢复，重启后保持关闭；不形成恢复循环；Anthropic 不做本地清理 |
| `test/clearing.test.mjs` | 11 | 阈值与按模型覆盖；本地清理的触发点、下限、最近 8 次调用、1 KB、已编辑/已省略/已覆盖结果和 Claude thinking 之前的结果；分支内提交并可召回原文；覆盖范围；用量与估算标记；applied_edits 归属未知时改用完整投影估算 |
| `test/fallback.test.mjs` | 32 | 分块摘要、前一摘要串联和 Pi 文件列表；放得下时使用 Pi `compact()`；回退模型解析顺序；配置模型失败后交回 Pi 或改用会话模型；`turn_end` 回退切点与 Pi 投影规则一致；回复校验；摘要期间和排队期间的状态变化；摘要回复额度、thinking 预算和安全余量，上一摘要和自定义说明计入输入预算；只记已知用量并标记不完整；文本压缩提交前的窗口检查及其边界 |
| `test/lifecycle.test.mjs` | 6 | 实现前的 Pi 宿主契约，见[本地生命周期](#本地生命周期) |
| `test/recall.test.mjs` | 9 | 按条目 ID、调用 ID 和查询取回；分支隔离；压缩和清理后的原文；按字节、行数和单个长行截断并写临时文件；图片；保存片段说明；错误信息；经 Pi 调用工具 |
| `test/requests.test.mjs` | 14 | 请求按顺序绑定；回放校验摘要、effort 标记、保留身份和哈希；Responses 窗口替换和 OpenAI 指令项；缓存预热流的 applied_edits 归属，迟到的 delta 或 stop 使归属未知，没有清理的完整流记为已知的零；物理模型判断；真实检查的回放核对逻辑 |
| `test/responses.test.mjs` | 42 | `openai-codex` 和 `openai` 各 20 项：Pi 阈值压缩的前缀带提示和工具、窗口回放、第二次压缩替换旧窗口、重启与通道切换、图片转文本摘要、400 不支持、自定义说明、可读摘要失败重试、并行与状态变化、暂时失败三次后回退、无效响应、取消、完整原始 SSE 校验、完成后的失败事件、HTTP 与网络失败分类、响应体截断时的 retry-after、原生和可读摘要用量的完整性、窗口放不下时保留历史；另 2 项为通道判断和 64,000 tokens 保留预算 |
| `test/status.test.mjs` | 10 | 通道标识与键排序 JSON；插件条目读取；details 与窗口形状校验；`/context` 格式；用量的未知、部分和完整三种显示；`/context fallback` 解析、显示与写入 |

`openai`/`openai-responses` 只有上述本地模拟验证。

### 集成真实检查

`test/live.test.mjs` 的两项检查在最终代码上于 2026-10-14 分别运行并通过，原始结果见
[Anthropic 记录](evidence/plugin-anthropic.tap)和 [Codex 记录](evidence/plugin-codex.tap)。

两项都用真实的 `ModelRuntime` 和 `createAgentSession` 加载 pi-pleat，关闭缓存预热和重试，只发送合成
内容。合成工具 `fixture_lookup` 每次返回约 8.7 KB 文本。任务要求依次查询 alpha、beta、gamma，再报告
三者之和与项目标识；标识只出现在第一条用户消息中。为了让小任务触发压缩，检查把 `reserveTokens`
设为窗口减 3,000（Anthropic）或窗口减 3,500（Codex，另设 `keepRecentTokens: 800`）。Anthropic 检查在
pi-pleat 之前加载一个扩展，把每个带 thinking 的请求设为 `prefix_mismatch_behavior: "error"`，任何保留
thinking 的绑定失败都会变成 HTTP 400。重启检查用新的运行时、会话和扩展实例打开同一会话文件，
再要求只回复项目标识。每次压缩的回放核对一次：较早的压缩用其后的第一个任务请求，最后一次压缩用
重启后的第一个请求。

#### Anthropic 集成检查

| 项目 | 结果 |
| --- | --- |
| 模型 | `claude-haiku-5-5`，high thinking |
| 任务请求 | 4 次：3 次 `toolUse`，1 次 `stop`；4 次回复都有签名 thinking，都没有 input transformations 诊断 |
| 压缩 | 4 次，全部为 `anthropic` 原生压缩，由 `turn_end` 触发 |
| 回放核对 | 4 次：块原样位于最前，保留的 assistant 紧随其后，thinking 签名和 tool_use ID 不变 |
| 严格绑定 | 第一次压缩后的每个请求都带 `prefix_mismatch_behavior: "error"`，全部成功 |
| 重启 | 1 次请求，以最新块开头，结束原因 `stop`，回复含项目标识，没有转换诊断 |
| 最终回答 | 含正确的和与项目标识 |

| 请求 | input | cacheRead | cacheWrite | output |
| --- | ---: | ---: | ---: | ---: |
| 任务 1 | 4 | 0 | 838 | 92 |
| 任务 2 | 2 | 686 | 4,680 | 82 |
| 任务 3 | 2 | 686 | 4,742 | 83 |
| 任务 4 | 2 | 686 | 4,754 | 96 |
| 重启 | 4 | 686 | 756 | 32 |

压缩后的三次任务请求 cacheRead 都是 686，其余输入大部分写入缓存。记录不含压缩请求本身的用量。
这些数字只描述这个强制每轮压缩的小任务，不代表正常设置下的缓存重写频率。

#### Codex 集成检查

| 项目 | 结果 |
| --- | --- |
| 模型 | `gpt-6-luna`，low thinking；可读摘要由配置的回退模型 `anthropic/claude-haiku-5-5`（thinking off）生成 |
| 任务请求 | 4 次：3 次 `toolUse`，1 次 `stop`，全部成功 |
| 压缩 | 2 次，全部为 `responses-trigger`，由 Pi 阈值在第 3、4 次请求前触发 |
| 窗口 | 每次为 1 条保留的用户消息加 1 个 compaction 项 |
| 回放核对 | 2 次：完整窗口位于 `input` 开头，其后的保留后缀含函数调用项，服务端接受 |
| 重启 | 1 次请求，以最新窗口开头，结束原因 `stop`，回复含项目标识 |
| 最终回答 | 含正确的和与项目标识 |

任务请求的 input 为 251、1,647、1,786、1,743 tokens，cacheRead 均为 0；重启请求的 input 为 265 tokens，
cacheRead 为 1,536 tokens。

#### 结果边界

标识读回只说明回放后的窗口可读并被服务端接受，不单独证明摘要质量：Anthropic 重启时保留的最终
回答本身含标识；Codex 窗口保留的用户消息就是含标识的任务消息。实现前的隔离检查
（[Codex 记录](evidence/codex-trigger.tap)）把事实只放在被移除的 assistant 消息中，是压缩状态能恢复
事实的较强证据，但也只覆盖一个合成事实。

Anthropic 的每个请求都带服务端清理配置，但任务只有 3 次工具调用，少于保留数 8，清理没有触发，
记录中没有 `applied_edits`。Codex 的本地清理同样没有候选，因为最近 8 次调用的结果受保护。

### 实现后的探测

2026-10-14 主会话的探测结果如下。仓库中没有这些探测的原始记录。

| 请求 | 结果 |
| --- | --- |
| Codex OAuth 令牌访问 `https://api.openai.com/v1/responses` | 401，`Missing scopes: api.responses.write` |
| Codex OAuth 令牌访问 `https://api.openai.com/v1/responses/compact` | 401，`Missing scopes: api.responses.write` |
| `https://chatgpt.com/backend-api/codex/responses/compact` | 404，与实现前结果相同 |
| chatgpt.com 上的 `/codex/v1/responses/compact` 和 `/v1/responses/compact` | 403，返回 HTML |

OpenAI/codex 提交 `95273b84fbff40f9df7d71d50f1ca52c6489b25d` 的 `codex-rs/codex-api/src/endpoint`
只有 `mod.rs` 和 images、memories、models、realtime（`realtime_call.rs`、`realtime_websocket/`）、
responses、responses_websocket、search、session 模块，没有独立压缩模块。OpenAI SDK 7.19.0 定义了
`ResponseInputItem.CompactionTrigger`。来源见参考资料中的 [OpenAI SDK](references.md#openai-sdk) 和
[Codex 开源客户端](references.md#codex-开源客户端)。

所有者据此决定两个 OpenAI 通道都使用 Responses-trigger，不使用独立压缩端点。本机没有 OpenAI
API key，也没有 “Sign in with ChatGPT” 登录，所以 `openai`/`openai-responses` 没有真实请求。

Codex 官方客户端在 2026-10-13 加入后台压缩（提交 `1a69ad32`、`9167a0b2`、`9e03960c`，见参考资料中的
[Codex 后台压缩](references.md#codex-后台压缩)）。核对 `9e03960c` 的源码：`run_background_compaction` 调用与前台
相同的 `run_remote_compact_v2_attempt`，请求输入末尾同样追加 `CompactionTrigger`；`async_compaction.rs` 只在
`AsyncCompaction` 开启、`TokenBudget` 关闭且服务商支持远程 V2 压缩时启用，并按历史版本、模型、压缩哈希和认证所有者去重。这只是
源码和提交说明的核对。pi-pleat 没有实现后台压缩，也没有用真实请求检查过这种模式。

### 仍未验证

- `openai`/`openai-responses` 真实通道，目前只有本地模拟服务。
- 实际服务端清理：`applied_edits` 的真实值，清理后缓存从哪里开始重写、多久重写一次。
- 非 Anthropic 通道的本地清理在真实任务中触发后的表现。
- 真实模型的召回行为：是否在需要时调用 `recall`，查询能否一次取到所需结果。
- Responses 窗口中的图片、开发者消息和多代理项。目前图片使本次压缩改用文本摘要，开发者消息不作为
  明文保留。
- 原生摘要和回退摘要的质量、长任务表现、费用与延迟（路线图阶段 6）。
- 只在本地模拟中检查过的路径：清理不受支持时的恢复，原生压缩的不支持、暂时失败、无摘要和完整性
  失败，`system-changed`，自定义说明，取消和状态变化，回退摘要的分块，提交前窗口检查的跳过，用量缺失时的
  显示。
- 其他模型和 Pi 版本、代理配置，以及与其他扩展的组合。
- Codex 官方客户端的后台压缩：pi-pleat 没有实现，协议兼容的判断来自源码核对。

## 实现前的协议验证（历史记录）

以下记录写于插件实现之前。“尚未实现”“仍在路线图中”等描述反映当时状态；已被插件验证或所有者
决定取代的结论在相应位置注明。

### 本地生命周期

以下三项已在真实 Pi 会话机制上通过，provider 响应由测试提供：

| 检查 | 结果 |
| --- | --- |
| 在 `turn_end` 调用 `ctx.compact()` | 中止当前运行，原因为 manual，`willRetry` 为 false；不会自动继续 |
| `turn_end` 返回 `compaction` 条目 | 提交一次，保留 assistant/toolResult 配对，随后正常继续 |
| 直接调用 `ctx.modelRegistry.streamSimple()` | 不自动触发扩展请求/响应事件；显式回调生效 |

本仓库另加入嵌套调用、分支编辑/持久化，以及改写后工具结果的保存检查，均已通过。
运行结果在下方仓库复测节记录。
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
（Pi 1.2.0 仍有该缺口；插件通过读取完整原始响应处理，见[架构](architecture.md#71-anthropic)。）

**用量缺口：** 压缩顶层 input/output 为零；实际值位于 `usage.iterations` 的 compaction 项。
费用统计不能只读顶层。

**验证边界：** 保留回复本身含项目标识，所以读回标识只证明整个回放窗口可读，
不独立证明摘要质量。未报告转换也不证明模型内部使用了全部历史推理。
当前 fixture 没有非空工具定义、工具配对或 Pi checkpoint 恢复（插件集成检查已覆盖这三项）。

首次简单算术题使用 medium thinking 时未返回签名块，测试按前置条件不足失败。
加强任务和推理级别之后才产生上述记录。

### OpenAI Codex

#### 首轮独立端点检查

模型为 `gpt-6-astra`，API 为 `openai-codex-responses`。普通请求返回 200，
同一认证来源下的实际独立压缩请求两次返回：

```text
POST https://chatgpt.com/backend-api/codex/responses/compact
HTTP 404
{"detail":"Not Found"}
```

一次中间重跑遇到普通推理服务过载；随后仅重试 Codex，再次取得普通请求 200 和压缩 404。
这个结果只适用于所测账户、通道及路径。首轮没有先核对开源 Codex 客户端的压缩协议，
只检查了独立端点，因此当时未执行成功的 Codex 原生压缩回放。

#### 按官方 Codex 客户端核对后的复测

已核对 OpenAI/codex 提交
[`95273b84fbff40f9df7d71d50f1ca52c6489b25d`](https://github.com/openai/codex/commit/95273b84fbff40f9df7d71d50f1ca52c6489b25d)。
其中 `compact_remote_v2_attempt.rs` 向普通 Responses 输入追加 `compaction_trigger`；
`compact_remote_v2.rs` 等待完整终止和一个压缩项，再按客户端规则重建历史。
具体代码位置见[参考资料](references.md#codex-开源客户端)。

本轮使用：

```text
POST https://chatgpt.com/backend-api/codex/responses
input: [...history, {"type":"compaction_trigger"}]
store: false
```

`gpt-6-astra` 的基线请求、两次压缩和两次回放全部返回 HTTP 200。
两次压缩都收到恰好一个完整的 `compaction` 项和 `response.completed`，
并确认完成响应中的 output 与流中已完成项目一致。

| 请求 | 输入 tokens | 输出 tokens | 结果 |
| --- | ---: | ---: | --- |
| 第一次压缩 | 117 | 100 | 返回完整 encrypted compaction 项 |
| 第一次回放 | 180 | 24 | 原样回放压缩项，取回被移除的事实 |
| 第二次压缩 | 224 | 123 | 新压缩项替换上一次压缩状态 |
| 第二次回放 | 221 | 24 | 再次取回同一事实 |

本轮随机标识仅放在合成 assistant 消息中。压缩后只保留普通用户消息和完整的新压缩项，
旧 assistant 明文和旧压缩项不重新插入。实际 HTTP body 的全部明文字段都不含答案，
没有使用 `previous_response_id`，两次回复仍精确返回该标识。
这比仅从还保留原答案的窗口读回标识更强，但仍只验证一个合成事实，不代表一般摘要质量。

请求快照使用 JSON 可发送值，避免把 Pi 的可选 `phase: undefined` 在序列化时正常省略
误判为内容变化。该调整没有放宽实际 HTTP input 与预期 input 的一致性检查。

**结论：Codex 原生入口阻塞已解除。** 独立端点的旧 404 没有改变；
当前可用且验证通过的是官方客户端的 Responses-trigger 协议。
OpenAI API-key 独立压缩通道仍未验证。完整 Pi checkpoint、重启、工具和多模态保留规则仍在路线图中。
（已被取代：所有者决定两个 OpenAI 通道都使用 Responses-trigger，不再使用独立端点；Pi checkpoint、
重启和工具由插件验证覆盖；多模态仍未验证。）

### 复核后补强

本地生命周期代码由 GPT-6.1-sol 起草，GPT-6-astra 检查并执行。
原生检查由 GPT-6-astra 编写，先经 Grok-4.7 初审，后改用 GPT-6.1-sol 完成补充复核。
后续框架审查使用 GPT-6.1-sol。
Responses-trigger 验证程序也经 GPT-6.1-sol 复核；官方源码的获取与逐段核对、真实请求执行由主会话完成。

补充复核要求检查实际 HTTP body 中的 system、tools、thinking、context_management、
compaction、output_config 及 beta 请求头，尤其是 strict binding。仓库已加入这些断言并完成复测。
早期记录仍只证明当时的断言，新增断言由下面的独立记录支持。

### 仓库复测

以下是实现前（包版本 0.0.0）的结果。依赖已记录在 `package-lock.json`；本机安装核对确认 Pi
coding-agent、pi-ai 和 pi-agent-core 均为 1.2.0，OpenAI SDK 为 7.19.0，TypeBox 为 1.3.27。

| 命令或检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run check` | 两个验证文件语法检查通过 | Node 退出码 0 |
| `npm test` | 本地 6 项通过，0 失败 | [本地结果](evidence/local-contracts.log) |
| Anthropic 单独真实检查 | 新 HTTP 字段断言及两次压缩/回放通过 | [传输字段复测](evidence/anthropic-http-fields.tap) |
| Codex Responses-trigger 真实检查 | 两次压缩/回放及移除明文后的事实恢复通过 | [Codex 新入口](evidence/codex-trigger.tap) |

新增本地检查确认：

- 压缩边界确实替换原始前缀：首次请求包含独有来源标记，续轮及下一次请求都不再包含它，
  原始用户条目仍保存在历史中；续轮仅保留摘要和配对的工具调用/结果。
- 嵌套调用有 `parentToolCallId`，父工具能读取完整结构化值；只有父结果进入 transcript。
  `nestedCalls` 保存调用元数据，不保存子调用结果。
- `context_edit` 不改原条目；回到编辑前的分支可见原内容；重新打开 JSONL 后，
  当前分支的编辑和压缩 details 数据仍然存在，另一分支的编辑不会生效。
- 改写后的工具结果会被保存：`tool_result` 和 `message_end` 处理器各遮盖一个合成秘密值。
  第二次模型请求、会话条目和重新打开的 JSONL 都只含改写后的内容，会话文件中两个原值都不存在；
  `message_end` 收到的内容已经包含 `tool_result` 的改写。召回按设计读取 JSONL，因此会得到
  模型看到的版本；召回本身尚未实现（已在 v0.1.0 实现，见 `test/recall.test.mjs`）。

测试草稿曾遗漏允许调用的子工具名，并把 JSONL 不保存 `undefined` 属性误判为差异。
修正工具白名单和 JSON 值比较后，当时的五项通过；没有修改 Pi 来迎合测试。
改写保存检查首次运行即通过。

新增真实检查在最终 HTTP body 中确认 strict binding 为 `error`，两次回放均带 1 个签名 thinking 块，
未报告转换。两次原生摘要的 Pi 归一化错误仍然存在，压缩用量仍在 iterations 中。
这次检查同样不证明非空工具、实际清理、摘要质量或 Pi checkpoint 后的原生状态恢复。

旧的 Codex 独立路径失败作为历史证据保留，本轮没有再次请求该路径。
首轮隔离验证已完成；后续只按路线图推进尚未验证的集成范围。

### 原始记录

- [初次运行](evidence/initial-run.log)：本地 3 项通过，Claude thinking 前置条件不足，Codex 压缩 404。
- [原生回放初次通过](evidence/native-initial.tap)：Anthropic 两次回放通过，另一次 Codex 服务过载。
- [确认 Codex 路径](evidence/codex-404.tap)：普通请求 200，实际独立压缩路径 404。
- [Codex 官方请求方式](evidence/codex-trigger.tap)：普通 Responses 加 trigger，连续两次压缩与回放成功。

早期记录中的行号对应迁入仓库前的验证程序。发布前替换本机目录路径为
`<validation-dir>`、`<pi-package-dir>`，并去除行末空白；没有改变服务端状态、用量或结果。
插件记录（`plugin-*.tap`）按同样规则检查，其中没有本机路径或行末空白，复制后内容未变。
所有记录都不包含认证头、签名值、encrypted state 或 thinking 文本。

运行命令见 [README](../README.md)。剩余工作见[路线图](roadmap.md)。
