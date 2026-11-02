# 服务契约

本轮移除旧自研引擎的 `/api/conversations`、`/api/settings` 等接口，它们返回 **410**。不要将旧 JSON 数据和旧 API 当作原生兼容层。

- `/api/health`：只有真实 Clowder AI 健康检查成功才返回 `ok: true`，原生断连返回 503。
- `/api/state`：原生成员与 Bot 的显示元数据；不是消息/记忆快照。
- `/xbot-api/*`：面向现有聊天 UI 的适配，详见 [XBot API](xbot-api.md)。
- `/native-api/api/*`：显式白名单的本机 owner 接口，用于成员、会话、队列、账号、记忆与审批。不是任意 URL 代理，不透传 callback/agent 身份接口。

Bot 只监听回环地址。Host 与 Origin 校验在 API 和静态资源之前执行；携带请求体的写入要求 JSON，头像上传除外。原生客户端通过 `/api/session` 获取并校验专属 userId、Cookie 与 CSRF token，每次操作前重新校验会话。不会伪造 `X-Cat-Cafe-User`。

原生事件由 Socket.IO 转成 `/xbot-api/runtime/threads/:id/events` 的 SSE。按原生 seq/epoch 去重，遇到断档、重连要求重新读历史；浏览器轮询作为状态恢复补充。关闭页面只释放订阅，不取消已入队任务。

请求失败不自动重发写入。消息发送可以携带稳定 `idempotencyKey`；接到 queued 回执表示原生持久化准入完成，不代表模型已经回复。

普通聊天发送统一携带 `messageDisposition: "continue_current"`。由原生准入绑定准确的活跃 invocation 并追加输入；没有可追加的活跃执行时由原生排队。适配层不根据过期 busy 状态重发、不提交强制 steer、不自动 cancel。后台子任务的派发与定向消息由主 Agent 使用原生能力完成，Bot 不保存另一份任务状态。
