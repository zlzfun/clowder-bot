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

已知限制（2026-11-11 在隔离运行时实测）：同意一条偏好提议（F221）时，原生写入失败并返回 `Vignette write failed`，原因是原生 `FileTasteRepository` 要求运行目录所在的 Git 仓库检出了 `refs/heads/main`，而按 `runtime:prepare` 生成的部署是 detached HEAD（[此前只恢复了只读浏览](chat-files-collaboration-memory.md)）。这属于部署前置条件，不是适配层能绕过的；在它解决之前，聊天里会如实显示「没有成功」，偏好不会被记住。

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
