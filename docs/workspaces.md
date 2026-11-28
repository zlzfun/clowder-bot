# 聊天文件适配

本工作区复用附件分支 `1893f70c` 的 Bot 层文件、默认目录和历史对话能力。执行、权限、消息、任务与负责人仍由 Clowder AI 管理。没有导入该分支的 P006／P007 或运行时启动改动；与隔壁完整分支的差异见[默认文件与兼容范围](default-files.md)。

- 新单聊、群聊自动取得默认文件目录；已有目录、会话引用、文件及消息保留。历史切换仍校验已知会话、当前线程及执行状态。支持通过 `PATCH /xbot-api/bots/:chat/conversations/:id` 重命名已知历史对话（转发原生 `PATCH /api/threads/:id` 并读回校验）和 `DELETE /xbot-api/bots/:chat/conversations/:id` 删除非当前、空闲且无启用定时任务的对话（转发原生软删除 `DELETE /api/threads/:id` 并清理 Bot 层引用；`conversations()` 同步过滤 `deletedAt`）。
- 附件每条最多 8 个、单个最多 20 MiB。上传按 UUID 存放，记录 SHA256，发送通过原生 `workspace_file` 引用。下载复核文件与会话，文本／图片受限预览。未发送的附件可通过 `DELETE /xbot-api/(bots|groups)/:chat/files/:id` 清理；已在对话消息中引用、正在发送中、刚发生发送结果未确认（5 分钟保护期）、属于另一段对话或类型为交付物的记录拒绝删除（409）。
- 工作目录浏览 `workspace-tree` 为文件条目返回 `previewable`（`'text' | 'image' | null`），并通过 `GET /xbot-api/(bots|groups)/:chat/workspace-file/{preview,image}?path=...&area=...&expectedThreadId=...` 绑定当前对话线程提供受限只读预览（仅前 128 KB `text/plain` JSON 或 PNG/JPEG/GIF/WebP 魔数校验图片，附 `Content-Security-Policy: default-src 'none'; sandbox` 与 `nosniff`，不执行 HTML/SVG/脚本）。
- 手动“存为交付物”保留独立快照语义。目录与来源校验不变，不以文件存在证明任务完成。
- 新增原生文件块投影与成果目录读取；来源消息、文件块和字节读取均重新校验。原生发布文件与 Bot 固定摘要快照分别展示，不抓取任意外链或正文路径。
- 原生任务可以查看；完整负责人历史只有运行时实际提供时才展示。已有后台控制适配继续按原契约执行，不因这次功能新增补丁。

接口与失败语义见[聊天体验适配契约](chat-experience-api.md)，前端行为见[文件与聊天前端规范](workspace-ui.md)。
