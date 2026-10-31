# 后端参考与实现边界

参考仓库：[zts212653/clowder-ai](https://github.com/zts212653/clowder-ai)。本次实际检出的版本为 **`b2c9952f27d31480191ff6fd120789405c97238c`**。下列引用固定在该版本，避免后续上游修改使设计依据漂移。上游 MIT 许可完整保留在 [licenses/clowder-ai-MIT.txt](licenses/clowder-ai-MIT.txt)。

## 具体复用映射

| 上游文件 / 机制 | clowder-bot 实现 | 复用与差异 |
| --- | --- | --- |
| [cat-template.json](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/cat-template.json) `roleTemplates` | `server/templates.ts` | 直接保留 8 个模板的名称、昵称、角色描述、性格与协作长处。头像为独立绘制 SVG；provider 是本项目可用适配器，模型不绑定易变版本。 |
| [a2a-mentions.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts) F046/F27 | `server/core/routing.ts` | 移植行首路由、最长匹配、token 边界、自调用排除、每条最多 2 个目标、完整回复后调度的核心规则。替换上游全局 registry 为当前会话成员集合；支持同模板多个实例的别名去歧义；代码围栏和引用中的提及不触发协作。 |
| [MultiMentionOrchestrator.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/agents/routing/MultiMentionOrchestrator.ts) / [multi-mention-state-machine.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/agents/routing/multi-mention-state-machine.ts) | `server/orchestrator.ts` | 独立轻量编排器保留运行状态、成员验证、跨猫交接与完成/失败/停止生命周期。当前按队列串行执行，使后续成员能看到前一只猫完整结果；单会话只有一个活动运行，最大回复数和重复有向边共同抑制循环。 |
| [ContextAssembler.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/context/ContextAssembler.ts) | `server/core/context.ts` | 参考跨猫可见历史、说话者标签、排除错误/未完成消息、从最近消息向前应用预算、头尾摘录 40%/60% 等核心做法。为当前用户输入保留空间；画像与历史摘要分别限制，配置降低预算后重新限制旧摘要。 |
| [buildThreadMemory.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/session/buildThreadMemory.ts) F065 | `compactConversation()` | 参考滚动摘要合并、较新内容优先、预算硬上限。每条摘录附原消息 ID，独立保存已压缩消息边界，原消息不删除。演示模式为明确标注的确定性摘录。 |
| [HandoffDigestGenerator.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/session/HandoffDigestGenerator.ts) | `Orchestrator.compress()` | 参考有超时的模型摘要与失败降级。真实模式使用当前猫的 provider，要求保留目标、决定、约束、待办、证据和来源；30 秒超时后保留本地摘录。摘要生成内容不会作为传球或记忆写入指令执行。 |
| [SessionChainStore.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts) | `Store.sessions` | 持久保存 provider 原生 session ID、猫与会话归属、创建/封存原因；压缩、修改画像、设置或成员后封存。当前 CLI 每轮采用重组上下文启动新调用，不使用原生 resume；并未移植完整的上游 session restore / transcript replay 系统。 |
| [MemoryStore.ts](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/stores/ports/MemoryStore.ts) | `Store.remember()` / `scopedMemories()` / `recallMemories()` | 参考作用域存储、来源归属、去重、删除与会话级联清理。本项目分共享/单猫/会话三个 scope；先过滤 scope，再按文本/标签相关性和时间排序，取最多 12 条并限制注入 token。仅独立行的显式 `<memory>` 协议写入 agent 记忆，代码与引用示例不写入。 |

## 本地运行与数据

- Express 仅监听 `127.0.0.1`，JSON API 与 SSE 共用进程，拒绝跨站 Origin / `Sec-Fetch-Site`，不开放任意命令执行 HTTP 接口。
- `CLOWDER_DATA_DIR/state.json` 为版本化本地数据。每次状态转换先写临时文件再原子重命名；不是多进程数据库，请只运行一个服务实例操作同一目录。
- 已完成消息与状态转换持久化，流式 delta 在当前进程内实时广播；异常崩溃时最后一条尚未落盘的回复片段可能丢失，但之前完成的历史保留。重启会把运行中回复标为已停止，避免永久等待。
- 数据损坏会明确启动失败，原文件不覆盖。API key 仅从环境变量读取，配置只保存变量名，不回传密钥。
- 用户保存记忆或 agent 显式写入均有来源和时间；同 scope 相同内容去重。记忆总量上限 5,000 条，超限明确拒绝，不静默删除。

## 明确未移植的部分

这是一套以聊天为核心的独立应用，不是上游整个 monorepo 的复制。未纳入语音、MCP 插件平台、猫猫球、IM 连接器、审批中心、调度任务、向量记忆数据库、人物关系记忆治理和完整 CLI session 恢复。头像是猫的品种表达，不复用上游品牌图像。

token 数采用对中文/Latin 混合文本的保守估算，用来限制输入上下文；不是服务商精确计费 token。记忆检索目前为轻量词项匹配，不声称向量语义检索。模型摘要为有损压缩，原文仍可在聊天中查看。

## 已验证

`tests/backend.test.ts` 覆盖提及路由与别名、代码/引用隔离、记忆 scope、上下文预算降低、原文保留、首位成员顺序、真实 provider 接口的模拟编排、传球循环上限、取消、失败、重启恢复、摘要取消、摘要协议隔离，以及 HTTP/SSE 基本集成。Provider 协议测试在 `tests/providers.test.ts`。本机未依赖真实 Claude / Codex / Gemini CLI 登录环境执行端到端测试。
