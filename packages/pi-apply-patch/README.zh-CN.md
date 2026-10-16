# @zhenhuang/pi-apply-patch

[English](README.md)

为 Pi 1.2.0 及以上版本提供 Codex 风格的 `apply_patch` 工具。扩展在加载时注册工具，工具是否可用由会话设置和子代理白名单决定。

## 安装

`apply_patch` 应由一个扩展提供。先移除旧包，再安装本包：

```sh
pi remove npm:@runminton/pi-apply-patch
pi install npm:@zhenhuang/pi-apply-patch
```

本地开发可直接安装工作区目录：

```sh
pi install /path/to/pi-extensions/packages/pi-apply-patch
```

在已有会话中运行 `/reload`。`/apply-patch-status` 显示工具是否已注册、是否已激活。已经运行的子代理拥有独立运行时；修改配置后应新建子代理。

## 子代理配置

`@gotgenes/pi-subagents` 将每个代理的 `tools:` 作为完整工具白名单。默认列表只有七个内置工具。需要编辑文件的代理应显式加入 `apply_patch`：

```yaml
---
tools: read, bash, edit, write, grep, find, ls, apply_patch
prompt_mode: append
---
```

例如修改 `~/.pi/agent/agents/implementer-sol.md`。配置内置 general-purpose 代理时，创建 `~/.pi/agent/agents/general-purpose.md`，使用上述 frontmatter，正文留空。项目中的 `.pi/agents/` 配置优先。

只读代理应保留自己的工具限制。本扩展遵守 SDK 的 `tools` 和 `excludeTools`。`inherit_context` 传递对话文字，子代理的工具能力仍由自身配置确定。

通过 SDK 显式传入 `tools` 数组时，也要在数组中加入 `"apply_patch"`。

## 输入格式

支持 grammar tools 的模型使用原生 Lark grammar，直接提交补丁文字。普通函数调用及 codemode 使用 `{ "patch": "..." }`。两种接口使用同一个解析器。

```diff
*** Begin Patch
*** Update File: src/example.ts
@@
 export function answer() {
-  return 41;
+  return 42;
 }
*** End Patch
```

支持 Add File、Delete File、Update File、Move to、`@@` 上下文锚点和 End of File。编辑前先读取目标文件，保留足以定位修改的上下文。各段按源文件顺序排列。只有新增行的段落会追加到文件尾部；在其他位置插入时应包含上下文。

路径按原样解释，相对路径以会话工作目录为基准，也支持绝对路径和 `../`。文件访问使用 Pi 进程的系统权限。

## 文件处理

解析和文本更新算法依据 2026-10-16 查阅的 OpenAI Codex [`4eb4a65407d98cebc4c83bf13be440b9fbc78a7c`](https://github.com/openai/codex/tree/4eb4a65407d98cebc4c83bf13be440b9fbc78a7c/codex-rs/apply-patch)。本包包含其单环境 Lark grammar。远程环境调度由宿主负责。

匹配依次尝试精确文字、忽略行尾空白、忽略首尾空白，以及 Codex 明确列出的 Unicode 标点替换。未改动的上下文保留实际文字和各行原有的 LF、CRLF 或 CR 换行符。新增行使用文件中首次出现的换行格式，保留 UTF-8 BOM。更新后的末行带换行符，与 Codex 一致。

所有解析、读取和匹配在首次写入前完成。写入使用 Pi 的文件队列，并精确比较读取时的文件内容。Add 和 Move 要求目标不存在；修改已有文件应使用 Update。文件须为有效 UTF-8 文本。移动时先写目标，再删除源文件。

通过已有符号链接更新文件时，保留链接并修改其目标。删除或移动符号链接时须显式指定目标路径。通过符号链接目录创建文件时须使用规范路径，因为 Pi 对尚不存在的路径按路径文字排队。同一补丁中的两个硬链接别名，以及同时指定某个文件和它下面的子路径，均在写入前拒绝。

操作系统错误或提交过程中的取消可能留下部分改动。错误结果列出已完成、失败或状态不确定，以及尚未执行的操作。重试前应读取这些路径。多文件写入不构成事务；Pi 队列只协调同一进程中的工具。

成功结果提供简短文件摘要，展开后可查看差异。界面从保存的结果渲染，不在编辑后重新读取文件。

## 生命周期和提示词

扩展工厂始终注册同一个 direct、default-active 工具。Pi 根据模型能力选择输入接口。Fork、resume 和 reload 会重新运行工厂；compact 保留当前运行时。显式工具选择由宿主控制，`/tree` 也可能恢复历史工具选择。

工具描述集中说明格式、一个示例和错误处理方法；两条简短指南说明编辑和重试要求。指令随工具的激活状态进入上下文，减少重复说明和模型切换造成的提示词变化。

故障链和源码位置见[调查记录](docs/investigation.md)。

## 开发与许可证

在 monorepo 根目录执行：

```sh
npm run check --workspace @zhenhuang/pi-apply-patch
npm pack --workspace @zhenhuang/pi-apply-patch --dry-run --ignore-scripts
```

使用 Apache-2.0 许可证。Codex 来源和改动见 [NOTICE](NOTICE)，完整许可证见 [LICENSE](LICENSE)。
