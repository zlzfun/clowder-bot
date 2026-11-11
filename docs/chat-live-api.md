# 回复的实时呈现：接口约定

更新日期：2026-11-11。范围：单聊与群聊里「猫正在回复」的呈现。只做展示投影，不改引擎。

## 依据

固定上游 `42017e0` 在会话房间 `thread:<id>` 上逐条广播一轮执行的 `agent_message`：开始标记、思考、工具调用、正文增量、结束。Bot 的 `NativeClient` 一直把这些事件原样转给浏览器（`GET /xbot-api/runtime/threads/:id/events` 的 `native` 事件），此前前端只把它们当作「重新读取会话」的信号，所以回复按原生草稿的落盘节奏（约 2 秒）整段出现。

2026-11-11 在隔离运行时（`.runtime/dev/`，独立构建、数据与端口）用 Claude Code 实测两轮：一条 131 字的回复分 64 个 `text` 事件到达；带工具的一轮依次是 `invocation_created`、`thinking`、`tool_use Write`、`tool_use Read`、36 个 `text`、`done`。每个 `text` 事件的 `extra.outputLayout.contentRevision.length` 都等于到这一片为止的累计长度（UTF-16 单位），两轮全部核对一致。

## `live` 事件

同一条 SSE 上，每个原生事件仍先原样发出 `native`；能画进聊天的那几类，紧接着多发一条 `live`。字段只有画面需要的几项，用量、会话、追踪等不带。

| `kind` | 来源 | 字段 | 含义 |
| --- | --- | --- | --- |
| `start` | `system_info` 内层 `invocation_created` | `messageId`（取 `lifecycleResponseMessageId`）、`catId` | 这只猫开始写这条回复，此时还没有字 |
| `thinking` | `system_info` 内层 `thinking` | `messageId`、`catId` | 在想；思考内容不下发 |
| `step` | `tool_use` | `messageId`、`catId`、`tool`（原生工具名）、`target?` | 正在做一步。`target` 只从已知含义的字段取：读写文件的工具取文件名，抓取网页取主机名，搜索取查询词，Grep/Glob 取匹配式，Task/Agent 取任务标题（都压成一行、最多 40 字）。命令行从不下发，包括 Bash 自带的说明；其他工具不取任何字段；模型写的查询词或标题里带绝对路径时整项不下发 |
| `text` | `text` 且 `origin: 'stream'` | `messageId`、`catId`、`text`（这一片）、`end?`（这一片之后整条回复的原生长度）、`replace?` | 正文增量。`textMode: 'replace'` 时带 `replace: true`，表示整条换成这一片 |
| `done` | `done`，或未标为 `transient` 的 `error` | `messageId`、`catId` | 这只猫的这条回复不再继续写了。它**不表示成功**：原生在停止和失败之后同样发 `done`（上游 `PerCatTerminalDispositionCollector`：单凭 `done` 不能证明成功）。结局（完成、已停止、没完成）以随后读取的会话为准。标为 `transient` 的错误不算结束 |

- `messageId` 就是会话里那条回复的 `native_message_id`，`catId` 对应 `native_cat_id`。群聊里多只猫同时写时各有各的 `messageId`。
- `end` 只在原生长度属于这条回复（线程与猫一致、是不小于本片长度的整数）时才有；没有就不猜。
- 显式发言（`origin: 'callback'`）、连接器消息和其他事件没有 `live`，照旧靠读取会话更新。
- 这里不保存也不补发：中途打开页面、或漏了一段的客户端，以会话里的原生草稿为准（`in_progress` 的那一行），等 `end` 对得上再接着画。

### 对齐规则（客户端）

设某条回复当前已有文字 `buffer`，收到 `{text, end}`：

- `replace` → `buffer = text`。
- `end - text.length === buffer.length` → 追加。
- `end <= buffer.length` → 已经有了（草稿读得更新），丢弃。
- 其余（中间缺了一段）→ 不拼，等下一次读取会话的草稿；之后的增量按同一规则继续。
- 没有 `end` → 只有从 `start` 起一片不落地看到这条回复时才追加。

## 会话行

`GET /xbot-api/bots/:name/transcript` 与 `GET /xbot-api/groups/:id` 的消息行：

- 还在进行的回复（原生草稿，或响应生命周期为 `processing`/`queued`）带 `in_progress: true`。正文是已经写出的部分，可以是空串；空串时前端画「正在输入」，不再用「正在等待或处理…」这句占位文字。
- 没有字、没有文件、也不在进行中的回复仍然不成行。`已停止`、`这次没完成，请查看详情` 两种结局文字不变。
- 回复紧跟在它所回答的那条用户消息之后时，`reply_to` 为 0，不再重复引用上一句；中间隔了别的用户消息（例如工作中途追加的话）才带引用。用户自己引用某条消息不受影响。原生 `replyTo` 不变。
- 回复末尾的猫爪署名：宿主署名范围验证通过并裁掉后，如果猫自己在它前面还写了一行 `[名字/模型🐾]`，也一并不显示（真实记录里出现过「[砚砚/GPT-6🐾]」后面再跟宿主的「[砚砚/🐾]」）。原生内容不变。

流式过程中的文字来自原生增量，署名还在里面。前端在显示时按同一口径处理：末尾独占一行的 `[…🐾]` 不显示，最后一行以 `[` 开头且尚未闭合时先不显示这一行；整段只是 `SILENT`（或它的前缀）时不显示。

## 停止

聊天里的「停止」调用已有的 `POST /xbot-api/bots/:name/stop` 与 `POST /xbot-api/groups/:id/stop`：撤回这个会话里还没开始的排队项，并取消正在进行的调用，都是原生接口。已经完成的动作不会撤销。

## 验证

`tests/live.test.ts`：投影的每种事件、不下发命令与绝对路径、结束事件不声称成功、SSE 上 `native` 与 `live` 的顺序、进行中的行（单聊与群聊）、引用规则（含分页边界）、双重署名。真实运行时的核对见上文「依据」。

2026-11-11 请本机 Codex 对这组后端改动做了只读交叉检视，采纳的修正：`done` 不再带成功标记；`step.target` 改为按工具取已知字段；会话「最新一句」与未读按显示文字判断可见（带署名的 `SILENT` 不算）；回执未到的开场邀请不算用户说的话；分页边界不猜引用；截断不切开代理对；只填名字建猫改走未打补丁的上游接口（见 [接口范围](xbot-api.md)「开箱即用」）。
