# XBot 兼容层范围

UI 保留 Bot 名称和文件夹概念，实际成员、执行和历史以 Clowder AI ID 为准。

| XBot 行为 | 原生映射 |
| --- | --- |
| Bot 创建/职责/重命名/删除 | `/api/cats`；删除成员保留原生历史 |
| 本地 Agent 接入 | `/agents` 原生发现；`/bots/:name/agent` 绑定执行者并恢复原生默认继承 |
| 单聊/新会话 | 原生 Thread，preferredCats 为该成员；新建保留旧会话 |
| 群聊 | 原生 Thread，preferredCats 为显式成员；消息路由保持原生 |
| 发消息/回复引用 | `/api/messages`，原生 ID 与幂等键 |
| 历史/导出 | 原生消息；主界面最近 200 条，导出完整分页 |
| 状态/停止 | 原生 queue、activeInvocations、withdraw、cancel；单成员取消不取消兄弟任务 |
| 笔记 | 原生 `/api/memory` 会话 KV；旧 shared/bot scope 明确拒绝 |
| 上下文压缩 | 原生 compact-native；工具不支持时保留原生错误 |
| 定时任务 | 每猫 `/bots/:name/routines` 映射原生 reminder 模板及 schedule/tasks；创建、启停、删除、触发记录见 [接口说明](schedules-api.md) |
| 头像/文件夹/置顶 | Bot presentation store |

运行面板补充原生队列、会话链、原生消息分页、记忆 catalog/search、Agent 与审批。F306 question/approval/elicitation 使用原生 revision、cardRef、operationId；其他支持内联操作的审批按原生 manifest 转发。需要完整原生会话卡片的交互不会自动批准。

`transcript` 为兼容 XBot 渲染器生成的投影，包含原生消息对象和 `native_message_id`。显示用 `send_message_to_user` 行带 `presentation_receipt: true`，不可计入模型工具调用/成本。真实工具轨迹来自 `toolEvents`。Bot 不自行估算或编造 Token。

单聊与群聊消息包含 `presentation_kind: "message" | "activity"`、`native_cat_id` 和 `speaker`（真实发送成员的 ID、名称和头像元数据；成员不可用时为 null）。只有当前返回页存在同一成员、同一原生 turn 的显式 callback 发言，才将对应 stream 累计记录投影为 `activity`；它不再生成聊天发送回执。前端将其显示为默认折叠的执行过程，正式发言保持原生顺序与各自时间戳。关联依赖精确执行身份，不用文本、时间接近程度或跨成员共享的外层 invocation ID 推断。错误、取消和缺少关联证据的回复继续作为普通消息；跨分页的关联暂不推断。该投影不修改或删除原生历史。

未迁移的跨设备、云账号、语音、应用、完整 skills/plugins 配置返回 supported=false 或明确 4xx/501。定时任务首版提供单猫创建、查看、启停和删除，尚不提供编辑已有计划、手动立即触发和高级调度治理。资料导入里的旧 XBot routines 格式仍拒绝，以免绕过原生计划校验。未读数量目前尚未从原生 read cursor 完整映射，不应将列表零值用于业务统计。

旧 `/models`、`/providers`、`/providers/*`、`/setup/key`、`/bots/:name/binding` 已退役为 410。Bot 新建和更新不再接受模型配置；更换 Agent 走专用绑定接口，避免普通资料更新意外改变接入。原生管理 API 中的账号能力不随 XBot 旧逻辑删除。
