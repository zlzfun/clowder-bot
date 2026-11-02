# 本地 Agent 接入边界

Bot 的接入对象是本机 Agent 运行时。设置不再维护模型商店、供应商目录、API Key/OAuth 或「供应商＋模型」绑定。原 XBot 对应接口返回 410；Clowder AI 自身的账号与模型实现保留原样。

- `/xbot-api/agents` 投影原生 `/api/cats/native-runtimes` 发现结果，并关联 Bot 绑定与本产品登记会话的运行记录。`refresh=1` 转交原生刷新参数；不会自动登录、安装或发起模型请求。
- `installed` 表示发现可执行工具；`configured` 表示原生检测已有登录/配置证据，不保证网络或额度可用。`unknown` 保持未知。
- `activity` 统计 Clowder 管理的 Bot 会话调用与队列项。状态读取失败时显示 unknown；不扫描或接管终端/桌面中的任意既有会话。
- `PUT /xbot-api/bots/:name/agent` 只接受 `runtimeId`。显式选择后，原生 Cat 使用 native_tool，清除成员级账号、模型、CLI 参数、effort 和 serviceTier 覆盖，沿用本地 Agent 默认配置。保留身份、职责和聊天历史；存在本产品在途任务时拒绝切换。
- 新建 Bot 的模型字段为空，使用上游原生默认继承语义，不把探测到的型号复制成固定模型绑定。
- 本轮接入选择支持 Codex、Claude Code、Kimi 的直接原生载体。其他被上游检测到的 Agent 仍显示，但在对应载体尚未适配时不可选。
- 已有 managed_account 原生绑定只读呈现为托管接入；不伪装为本地 Agent，不自动转换，不删除已有账号。
- 模型名称和推理档位仅作为原生配置的只读信息。用户在对应本地 Agent 中管理登录及默认配置。

工作目录为本项目隔离的 `data/native/workspace`。执行、会话恢复、工具能力和权限仍由原生 Clowder AI 与 Agent 管理。本层没有第二套模型执行器，也没有新增容器隔离。
