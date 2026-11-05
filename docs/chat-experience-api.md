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
  errors: Array<{source:string;message:string}>;
}
```

- items 是原生事实投影，按待确认、失败、运行、排队、未完成任务排序。没有证据不造状态；`readStatus` 非 ready 时不能推断空闲／全部完成。
- 审批只投影原生 `resolution:open` 且有当前会话的真实卡片坐标；`messageId` 用于定位。一个 Task 的 doing／blocked 与 invocation running 分开，不凭 Task 推断执行。
- 现有 `GET /xbot-api/bots/status`（另支持 `/xbot-api/status`）的 bot 项保留旧字段，增加 `thread_id`、`activity`；同时返回 `groups:[{id,thread_id,activity}]`。有当前待审批时 state 为 awaiting；读取不全且没有已证实执行时为 unknown；其他保持 running／queued／idle。仅新消息影响 unread，审批数量独立保留。
- `POST <scope>/read {expectedThreadId,messageId}` 确认用户实际看到的回复，返回 `{threadId,readMessageId}`；会话变化返回 409，不能确认不属于该会话的消息。GET 不会标已读，后台轮询、隐藏页面、浏览旧消息不能确认最新回复。前端只在页面可见、当前会话、实际看到对应消息时提交，并防旧请求串会话。
- 源码中的 legacy bot.lastReadMessageId 保留，不迁移成可信已读事实；新读位置按 thread 保存。只存展示游标，不持久化第二份任务或消息内容。
- 首批为应用内状态与未读，无系统推送。任务控制继续使用既有能力，不添加／依赖新运行时补丁。

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
