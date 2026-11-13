# 聊天体验 1、3、5：适配契约

首批实现，2026-11-05。Clowder AI 机制、子模块、补丁及固定版本保持不变。复用附件分支 `1893f70c` 的 Bot 文件适配和前端，不引入 P006／P007 或修改启动策略。验证范围见[实施记录](chat-files-collaboration-memory.md#首批实施)。

## 文件

沿用 `GET <scope>/files`、消息 `attachments`、`GET /xbot-api/files/:id/download|preview|image`。`<scope>` 为 `/xbot-api/bots/:name` 或 `/xbot-api/groups/:id`。

- 原有快照字段与上传协议不变。原生消息中的 file 内容块、rich file 块会投影到 `attachments`，正文为空时仍保留消息；不改写原生消息。
- 新原生文件视图：`{id,threadId,name,kind:'attachment'|'deliverable',mime,size:number|null,createdAt,sourceMessageId,nativeSource:true,availability:'available'|'unavailable',unavailableReason?}`。ID 不保证 UUID，前端按旧规则 encode 后构造 `/xbot-api/files/:id/...`，不使用来源 URL。
- `size:null` 表示未提供大小，不能写成 0 B。`availability:unavailable` 时显示原因并禁用预览／下载；不请求不可用图片。原生文件没有 Bot 快照的固定摘要承诺，不称为已保存快照。
- 首批原生字节读取只支持原生发布的 `/uploads/` 文件。每次下载重新核对来源消息及具体文件块、所属会话；其他来源保留卡片，明确暂不能下载。预览继续只显示受限文本／图片，不执行 HTML、SVG 或脚本。
- 文件列表另含 `nativeReadStatus:'ready'|'unavailable'`、`nativeError?`。原生成果目录读取失败时保留已有快照，并显示可重试的局部失败，不伪装完整空列表。

## 协作与已读

`GET <scope>/activity` 返回：

```ts
{
  threadId: string;
  readStatus: 'ready' | 'partial' | 'unavailable';
  items: Array<{
    id: string; kind: 'approval'|'failure'|'running'|'queued'|'task';
    label: string; threadId: string; catId?: string; catName?: string;
    messageId?: string; taskId?: string; proposalId?: string;
  }>;
  counts: {approval:number;failure:number;running:number;queued:number;task:number};
  unread: number | null; // null 为消息读取失败；数字是当前返回页的下限
  unreadHasMore: boolean;
  latestMessageId: string | null; // 最新可见的非草稿猫回复；不是已读证明
  // 这个会话里最新说出的一句，供会话列表显示与按时间排序；没有或读不到时为 null
  last: {messageId:string; time:string; from:'owner'|'cat'; catId?:string; catName?:string; text:string; files:number} | null;
  errors: Array<{source:string;message:string}>;
}
```

- items 是原生事实投影，按待确认、失败、运行、排队、未完成任务排序。没有证据不造状态；`readStatus` 非 ready 时不能推断空闲／全部完成。
- `last` 取当前返回页里最新的一条：用户消息（应用代发的开场邀请除外，回执未到时按该会话里的邀请原文识别）或可见的猫回复（与未读同一口径：草稿、处理中、已停止、被显式发言取代的执行记录都不算；显示文字为空且没有文件的也不算，例如带署名的 `SILENT` 或只有署名的一行）。`text` 是去掉署名、压成一行、最多 140 字的显示文字；只交付文件的回复 `text` 为空、`files` 为文件数，由前端措辞。它只是同一次原生消息读取的另一种投影，不另存。
- 审批只投影原生 `resolution:open` 且有当前会话的真实卡片坐标；`messageId` 用于定位。一个 Task 的 doing／blocked 与 invocation running 分开，不凭 Task 推断执行。
- 现有 `GET /xbot-api/bots/status`（另支持 `/xbot-api/status`）的 bot 项保留旧字段，增加 `thread_id`、`activity`；同时返回 `groups:[{id,thread_id,activity}]`。有当前待审批时 state 为 awaiting；读取不全且没有已证实执行时为 unknown；其他保持 running／queued／idle。仅新消息影响 unread，审批数量独立保留。
- `POST <scope>/read {expectedThreadId,messageId}` 确认用户实际看到的回复，返回 `{threadId,readMessageId}`；会话变化返回 409，不能确认不属于该会话的消息。GET 不会标已读，后台轮询、隐藏页面、浏览旧消息不能确认最新回复。前端只在页面可见、当前会话、实际看到对应消息时提交，并防旧请求串会话。
- 源码中的 legacy bot.lastReadMessageId 保留，不迁移成可信已读事实；新读位置按 thread 保存。只存展示游标，不持久化第二份任务或消息内容。
- 首批为应用内状态与未读，无系统推送。任务控制继续使用既有能力，不添加／依赖新运行时补丁。

## 卡片、清单与选项

猫用引擎的 `create-rich-block` 工具发出的内容存在原生消息的 `extra.rich.blocks` 里（结构见固定上游 `packages/shared/src/types/rich.ts`）。此前适配层只投影其中的文件，其他种类在聊天里直接消失；只有卡片、没有文字的回复连一行都不剩。

单聊与群聊的消息行现在带 `blocks`（有可画的块时）和 `blocks_hidden`（有画不了的块时的个数）：

```ts
type ChatBlock =
  | {id; kind:'card'; title; body?; tone?:'info'|'success'|'warning'|'danger'; fields?:{label,value}[];
     approval?:{id; kind:'preference'|'profile'|'person'|'schedule'|'question'|'other'; title; body?; state?:'approved'|'rejected'|'closed'}}
  | {id; kind:'checklist'; title?; items:{id,text,checked}[]}
  | {id; kind:'choices'; mode:'single'|'multiple'|'confirm'; title?; description?; options:{id,label,emoji?,description?,custom?}[];
     max?; template?; answered:boolean; selected:string[]}
  | {id; kind:'diff'; file; diff};
```

- `card.approval.state` 只认同一个提议、同一个来源（`producerId`）的回执；回执写明了卡片所在消息时，还要是这条消息。对不上的回执不改变任何卡片。
- `card.approval` 自带这件事的日常说法：`kind`、`title`（不带主语，如「想设一个定时」，前面接说话的猫名）和 `body`（如「每周五写周报 · 每周五 17:00（Asia/Singapore）」）。它从原生卡片本身读出（来源 `producerId`、标题冒号后的名字、`Trigger` 字段里的 JSON），所以请求答完、不再出现在下一节的列表里之后，卡片仍然说得出当时问的是什么。带这种卡片的消息，原生自己的正文（「请求批准创建定时任务「…」」「提议捕捉品味信号：…」）是写给原生网页的：会话列表的预览 `activity.last.text` 和搜索摘要改用「`title`：`body`」这一行。
- `card.approval.id` 是原生提议的 ID：这张卡是一条「等你确认的事」，与下一节 `approvals[].id` 对应，前端在这里画确认卡而不是原生卡片的原文。用户回答之后，原生会往会话里发一条回执（来自 approval hub 的 connector 消息，原话是「审批结果：品味提案 proposal_… 已批准。」）：回执和卡片在同一页时，`card.approval.state` 是 `approved`／`rejected`／`closed`；这时卡片自己写着结果（「已记住这个偏好 · …」），回执这一行不再出现在返回的消息里（2026-11-13 起：同一件事不说两遍）。卡片不在这一页（在更早的一页），或卡片在折叠的执行过程里时，回执是结果唯一的说法，这一行照旧返回，文字是聊天里的说法（「已记住这个偏好。」「定时没有改动。」等，带 `notice: true`）。两种情况原生记录都不变。没有 `state` 的卡片是否还在等待，以下一节的列表为准。
- `choices` 对应原生的 interactive 块。作答沿用原生网页的做法：把选择写成一句普通的聊天消息发出去（措辞规则见上游 `InteractiveBlock.tsx` 的 `buildSelectionMessage`：有 `template` 时把 `{selection}` 换成所选项，否则「我选了：…」，confirm 是「确认／取消」），再用 `POST <scope>/messages/:messageId/blocks/:blockId/answer {selectedIds, expectedThreadId}` 记到原生块上（转发 `PATCH /api/messages/:id/block-state`，`disabled: true`）。两步各自成败：消息已发出但记录失败时，选项仍可再点，不把它显示成已作答。
  - 措辞的细节（与上游一致）：所选项写成「emoji 标签」（有 emoji 时），多个用「, 」连接；选了自定义输入并填了字时是「所选项：填的字」或只有填的字，有标题时后面加「（标题）」；confirm 是「确认」或「取消」，有标题时加「 — 标题」。
  - `confirm` 的 `options` 固定是两个，顺序为确认、取消，取法与原生网页相同：有 `__confirm__` 用它，否则第一个选项是确认；另一个选项是取消，没有声明时是 `{id:'__cancel__', label:'取消'}`。
  - 记录前检查选择是否合法，因为原生的 block-state 接口照单全收并且一写就永久关闭这个块：单选和 confirm 恰好一项，多选一到 `max` 项，不能重复，必须是这个块里的选项（400）；已经作答过的块返回 409。
  - 带直接动作的选项（上游 F155：`option.action`，点击后调用引导、反馈等原生接口而不是发消息）没有适配，这样的块不作为普通选项给出，计入 `blocks_hidden`。
- `diff` 只给文件名和差异正文。音频、图集、HTML 小组件暂时不画，只计入 `blocks_hidden`，前端要说明「还有 N 项暂时无法显示」，不能当作没有。文件块仍走原有的文件投影。
- 只有块、没有文字的回复现在也是一行，计入未读和 `last`（`last.text` 取第一块的标题）。

## 等你确认的事

猫提出需要用户点头的事（记住一个偏好、设一个定时……）时，原生会在会话里发一条带确认卡片的消息，并把它登记在 Approval Hub。此前聊天里只有「等你确认」一行，「去确认」要打开运行面板。适配层现在把它读成聊天里能直接回答的卡片；请求本身、它的生命周期和生效过程仍然全在原生。

`GET /xbot-api/<bots|groups>/:chat/approvals` → `{threadId, approvals[]}`，只含原生 `resolution: open` 且卡片锚定在这个会话里的请求，按创建时间排列：

```ts
{
  id: string;            // 原生 proposalId
  kind: 'preference'|'profile'|'person'|'schedule'|'question'|'other';
  title: string;         // 「快手想记住你的一个偏好」
  body: string;          // 要记住的内容 / 「喝水提醒 · 每天 09:00（Asia/Shanghai）」
  quote?: string;        // 引出这件事的那句原话（原生提供时）
  catId?: string; catName?: string;
  messageId: string;     // 承载原生卡片的那条消息，前端在它的位置画这张卡
  createdAt?: number; expiresAt?: number;
  state: 'open';
  approve: {label: string} | null;   // null：不能在聊天里同意
  reject: {label: string} | null;
  note?: string;         // 不能在这里处理时说明去哪里
}
```

- 措辞按原生登记的来源生成：F221 偏好、F231 资料、F276 人物、F139 定时（触发时间由原生 trigger 读成「每天 09:00」「每周一、周三 18:30」「每 2 小时」；认不出的 cron 原样给出），其余用通用说法。原生摘要里的英文前缀（`Taste […]:`、`Create schedule:`）不出现在正文里。
- 能否在这里同意取决于原生：`inlineApprovable` 且 `decisionMode: 'approve-reject'`，并且 Hub manifest 给出的 `decisionEndpointBase` 属于 Bot 允许到达的那组提议决定接口。资料更新（F231）原生要求先核对差异，这里只能「不用」；提问类（F306）仍在运行面板回答。
- `POST …/approvals/:id {decision: 'approve'|'reject', expectedThreadId}` 先重新读取 Hub，确认这件事仍然开着、属于这个会话，再把用户的回答发给 manifest 指定的原生接口。返回 `{id, decision, settled}`：`settled` 是事后重读 Hub 的结果，`true` 表示原生已不再把它列为待确认，`false` 表示已受理但原生还在处理，`null` 表示没能确认。不属于这个会话或已经处理过的 404，不能在这里同意的 409。
- 原生没能落实时返回原状态码和「这一步没有成功，还没有生效」，原生给出的原因保留在 `native` 里；这件事继续显示为等待确认。读取不会触发任何决定，没有自动同意。

偏好提议（F221）能否落实取决于部署：原生把偏好存在「构建所在 Git 仓库里检出了 `main` 的工作树」中。2026-11-11 起 `runtime:prepare` 按这个要求建构建目录（见 [维护说明](upstream-maintenance.md)「偏好仓库」），在隔离运行时上实测同意后 `settled: true`、`/xbot-api/memory/taste` 读到该条。还没按新布局重建的实例上，同意会失败并返回 `Vignette write failed`，聊天里如实显示「没有成功」；公开（非敏感）偏好需要 `origin`，没有配置时同样如实失败。

## 只读长期记忆

`GET /xbot-api/memory/profile|taste`：

```ts
{
  kind: 'profile'|'taste'; readStatus: 'ready'|'partial'|'unavailable';
  entries: Array<{
    id:string; title:string; content:string; revision:string;
    status:'active'|'retired'|'unknown'; pendingCount:number; updatedAt?:string|number;
  }>;
}
```

`GET /xbot-api/memory/:kind/:id/source?revision=…` 转接原生来源读取，将 Profile 的来源数组和 Taste 的单一来源坐标统一投影为 `{status:'ready'|'not_recorded'|'unavailable',sources:[{label,occurredAt,canOpen,threadId?,messageId?}]}`。原生没有提供时间时 `occurredAt:null`。版本冲突保持 409，须重读列表后再查看；权限错误保持 401／403；不可读不能显示成“还没有记忆”。

- owner 身份、Origin、CSRF 由现有 NativeClient 沿用原生会话；只增加 GET，禁用其他方法，不开放 actions。
- Profile 按原生条目／整份文档展示；Taste 显示已保存的内容。`pendingCount` 只表示另有待确认修改／候选，不把候选当已保存内容。
- 在单聊原有记忆页按需展开「关于你」「你的偏好」；不注入对话、不在群聊显示。会话便笺仍只读展示并明确范围，既有后端便笺路由不改，本轮不增加写入入口。
- 本轮无长期记忆编辑、确认、停用、遗忘按钮，也没有另建存储或检索。
