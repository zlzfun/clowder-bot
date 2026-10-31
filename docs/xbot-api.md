# 原版 XBot 前端兼容层

`server/xbot/core.ts` 与 `server/xbot/settings.ts` 适配原版 XBot JavaScript 所需的数据形状。原版静态文件只把 `/api/` 前缀改成 `/xbot-api/`；已有 clowder-bot `/api/` 接口仍然保留。

兼容层连接同一个 `Store` 和 `Orchestrator`，不是第二套聊天数据。Bot 在原版界面通过名称定位，内部仍使用稳定 ID；更名不会改变原有消息、记忆和会话归属。头像选择、分组、人设卡、模型绑定、已读位置和当前会话等元数据写入同一个版本化状态文件的 `xbot` 字段。

## 核心路径

| 路径 | 行为 |
| --- | --- |
| `/session` | 单机免登录会话，明确 `app:false`、`remote:false`。 |
| `/bots`、`/bots/:name` | 新建、查询、编辑和删除 Bot；原版 profile 字段与人设卡。 |
| `/bots/:name/avatar` | 默认使用 3D 猫猫预设，`templateId` 与 `cat:品种` seed 保持身份稳定；上传图片有大小、MIME 和签名检查，支持恢复对应猫猫头像。 |
| `/bots/:name/template`、`/bots/import`、`/bots/:name/fork` | 无历史/记忆的模板导出导入、复刻；带非空定时任务的模板明确拒绝，避免静默漏导入。 |
| `/groups` | 无 `members` 时创建侧栏分组；有 `members` 时创建真实群聊。 |
| `/bots/:name/messages` | 原版 POST SSE：`part`、`tool`、完成后的 `result(send_message_to_user)`、`done`；失败通过 `error` 返回。 |
| `/groups/:id/messages` | 按原版协议返回 JSON `sent`，实际群聊在后台运行，原版轮询读取结果。 |
| `/bots/:name/transcript` | 真实持久消息映射成原版交付回执格式。原版渲染器要求 `send_message_to_user` call + receipt 才显示新 assistant 消息。这里的 call 表示应用实际交付该消息，并非虚构模型工具执行。 |
| `/bots/:name/context` | 返回实际模型调用前捕获的输入快照和估算预算；没有运行过时返回空 `requests`，不伪造快照。 |
| `/bots/:name/memory` | 共享/本猫/当前会话记忆读取与增删。 |
| `/bots/:name/binding` | 单 Bot 的 provider/model 选择，覆盖旧 API 全局模式；不同猫可混用演示和真实 provider，压缩同样选择该 Bot 的实际 provider。 |
| `/bots/:name/stop`、`/bots/:name/agents/:run/cancel` | 取消当前实际运行，原版任务页使用后者。 |
| `/bots/:name/new`、`/bots/:name/compact` | 新开会话保留旧历史，或整理当前上下文。 |

原版 UI 不呈现全部附加接口；没有为此改写原版视觉和交互。`/notes` 当前为空，因为该独立版本没有额外后台通知来源。模型自身的工具执行沿用 provider 的 CLI 设置。账号、跨设备、插件和定时任务等未实现能力返回明确的 unsupported 信息或失败状态，不能视为已接通。

兼容层仅允许回环访问，先做 Origin/跨站检查再解析请求体。JSON 写请求与头像 multipart 分别验证；支持原版不携带 body 的 POST。API key 由供应商模块独立保存在权限 `0600` 的本地秘密文件，状态快照和列表不含密钥。

`tests/xbot-core.test.ts` 覆盖原版 boot/profile 格式、SSE 与交付回执、群聊传球、分组、画像与人设、头像上传和带图模板导入、每猫 provider 与压缩、记忆隔离、重启持久化和跨站拒绝。`tests/xbot-settings.test.ts` 覆盖供应商设置、人设卡及不支持能力的显式失败。
