# 文件与聊天任务

执行、消息、任务状态、负责人、队列和交接授权继续由 Clowder AI 管理。Bot 保存会话引用和文件清单，不维护第二套任务调度器。2026-11-05 起收起项目产品流程，默认目录、文件权限和兼容策略见 [默认文件目录与原生协作](default-files.md)。

## 默认目录与历史对话

新单聊自动使用 `workspace/cats/<native-cat-id>/`，新群聊自动使用 `workspace/groups/<UUID>/`。默认不展示路径与目录切换；附件、交付物直接在聊天和文件页使用。

旧项目的目录、Thread、消息、任务及文件保留原位，当前会话不变。猫猫详情的历史对话列出已知会话；切换只改变当前原生 Thread 引用，不移动数据。执行或排队期间拒绝切换。新建对话使用该猫默认目录，并保留旧会话入口。猫猫子目录是组织方式，不是每猫独立沙箱；宿主文件保护边界单独实施。

## 文件

单个文件最多 20 MiB，每条消息最多 8 个。文件存入 UUID 目录，同名不覆盖；清单记录 SHA256、大小、原生 Thread ID、名称和时间。发送和下载重新校验内容，文件已修改返回 409。

消息使用原生 `workspace_file` 类型 `contextAttachments`，带 `sha256:` 版本；Agent 通过原生工具读取。图片同样是文件引用，不宣称已经转成视觉模型输入。聊天附件来自原生内容块投影。

“存为交付物”将工作区真实文件保存为独立快照；源文件变化不改写交付版本。默认是用户收录；只有来源原生消息明确引用该文件时才能登记 `sourceMessageId`。文件存在不代表任务完成。

工作区浏览不展开符号链接或隐藏目录。文本预览最多 128 KiB；通过文件头识别的 PNG/JPEG/GIF/WebP 可显示图片。其他文件可下载，HTML、SVG、脚本不作为站点代码执行。文件下载有 attachment 与 sandbox 响应头。

## 任务

`ownerCatId` 是原生负责人，`status` 是任务进度，`backgroundExecution` 是独立执行事实。创建任务不代表 Agent 已启动。显式改派使用原生 `expectedOwnerRevision`，执行中的任务可拒绝改派。

“请求交接”只向当前负责人提交任务 ID、版本和目标成员。实际交接继续走 Task-backed handoff；重新读取 Task 才能显示新负责人。停止、撤销、恢复沿用原生任务级控制和 `expectedAttemptId`，不会退化为停止整个会话。恢复仅解除禁止，不会自动重新执行。

P006 在原生普通 Task 成功更换负责人时，随同一次原子写入保存 `assignmentHistory`：原/新负责人、版本、时间、来源消息引用、操作类型。Memory 与 Redis 使用同一决策；失败、重放、旧版本、ABA 冲突不追加成功记录。启动器设置 `CAT_CAFE_BOT_TASK_HISTORY=1`；任务列表返回 `assignmentHistoryVersion:1`。旧任务不补造过去记录，历史范围为普通任务的认领、人工分配与正式交接。

## API

`<chat>` 为 `/xbot-api/bots/:name` 或 `/xbot-api/groups/:id`。

| 接口 | 行为 |
| --- | --- |
| `GET /xbot-api/projects` | 只读保留的旧元数据；POST 已退役，返回 410 |
| `GET <chat>/workspace` | 原生 Thread、工作目录、项目、成员目录 |
| `GET /xbot-api/bots/:name/conversations` | 该猫已知的历史会话，不复制消息 |
| `PUT /xbot-api/bots/:name/conversation` | `{threadId,expectedThreadId}` 打开已知会话 |
| `PUT /xbot-api/bots/:name/workspace` | 已退役，返回 410 |
| `POST /xbot-api/groups` | 自动分配目录；不再接受项目关联 |
| `GET <chat>/workspace-tree?path=&area=workspace\|shared` | 目录列表，最多 200 项 |
| `GET <chat>/files` | 当前会话附件及交付物清单 |
| `POST <chat>/files?name=&expectedThreadId=` | octet-stream 文件上传 |
| `POST <chat>/deliverables` | `{path,area,expectedThreadId,sourceMessageId?}` 快照 |
| `GET /xbot-api/files/:id/download\|preview\|image` | 下载、受限文本/图片预览 |
| `POST <chat>/messages` | 支持 `attachments:[id]` 和 `expectedThreadId` |
| `GET/POST <chat>/tasks` | 原生列表、创建；创建带 `expectedThreadId` |
| `PATCH <chat>/tasks/:id` | 负责人/进度更新，带 `expectedOwnerRevision` |
| `POST <chat>/tasks/:id/handoff` | `{targetCatId,expectedOwnerRevision,note?,idempotencyKey}` 请求 |
| `POST <chat>/tasks/:id/control` | `{action,expectedOwnerRevision,expectedAttemptId}` 控制 |

## 参考与验证

参考 OpenBot `acccbce543a59e8806ed3b60a74b11123b0ce5d2` 的交互组织，未复制其代码或素材：[工作区与 Shared](https://github.com/nightly-labs/openbot/blob/acccbce543a59e8806ed3b60a74b11123b0ce5d2/src/backend/workspace-paths.ts)、[文件卡片](https://github.com/nightly-labs/openbot/blob/acccbce543a59e8806ed3b60a74b11123b0ce5d2/packages/ui/src/features/conversation/AttachmentCards.tsx)、[任务恢复与改派](https://github.com/nightly-labs/openbot/blob/acccbce543a59e8806ed3b60a74b11123b0ce5d2/packages/ui/src/features/channels/ChannelStoppedTasks.tsx)。

- `npm test`：Bot 契约和前端回归，新增 `tests/workspaces.test.ts`。
- `npm run test:workspace-history`：原生聚合、Redis codec；设置 `BOT_TASK_TEST_REDIS_URL` 增加真实 Redis 并发/重新读取验证。
- `npm run test:task-background`：原生任务停止、交接和恢复回归。
- `BOT_WORKSPACE_ACCEPTANCE=1 PORT=3232 node scripts/check-workspaces-http.mjs`：独立候选的默认目录、文件与任务历史验收，保留数据和证据。
- `BOT_WORKSPACE_AGENT_TEST=1 node scripts/check-workspace-agent.mjs`：上述候选的一次真实 Agent 读取附件并写出报告。
- `BOT_WORKSPACE_HANDOFF_TEST=1 node scripts/check-workspace-handoff.mjs`：上述候选中请求真实猫猫交接，验证原生负责人、`handoff` 历史类型和来源消息同时确认。

原生要求 Node 24，当前构建位于 `.runtime/clowder-ai-default-files`。用独立数据目录和端口验收，保持现有实例的数据不变。

此前 2026-11-04 的项目版本独立实例验收覆盖：个人/项目会话往返恢复、页面创建项目与项目群聊、真实 Agent 读取聊天附件并写出文件、从目录保存交付物与预览、页面创建任务及指派、页面请求猫猫交接后自动更新负责人和历史。桌面检查了文件和任务区域，390px、320px 视口检查了任务布局。运行数据和原生回执保留在本地 `.runtime/workspaces-acceptance/` 及 `.runtime/workspace*-evidence.json`，不进入仓库。
