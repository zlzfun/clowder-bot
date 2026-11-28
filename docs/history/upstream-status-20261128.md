# 上游现状核对（2026-11-28）

对 [特性与上游的关系](../features.md) 里「上游」一栏的逐条依据。核对对象是固定的上游提交 `fe632f8febdaaf189b0b3aaa078c6d36032da492`（`next` 分支），方法是读子模块 `upstream/clowder-ai` 的源码和它自己的特性文档，**没有运行引擎验证**；所以这里的「已有」指源码里读到了对应的路由或实现，不保证在本部署上的行为。由两个只读的子代理分两组完成，引文和行号由它们自己复核过，主文档作者没有逐条再核。

怎么读：

- 路径都相对 `upstream/clowder-ai/`；第 20–38 条里 `api/` 指 `packages/api/src/`，`shared/` 指 `packages/shared/src/`，`mcp/` 指 `packages/mcp-server/src/`，`F###` 指 `docs/features/F###-*.md`。
- 状态用语：`已有`（固定版本的源码里有）、`在做`（特性文档标进行中，写明我们要的那部分做没做）、`有规划`（只有规格或想法）、`未见`（搜过文档和源码没找到）。
- 上游特性文档的 Status 与源码有几处不一致（F069、F055 写 spec 而代码已在；F088、F132、F134 写 done 而连接器代码已不在本仓），每条都以源码为准。
- 标「推断」的不是源码或文档的直接陈述。每条末尾的「把握」是核对者自己的判断。
- 这是带日期的记录：固定提交换了以后不再更新，重新核对时另写一份。

## 汇总

### 第 1–19 条

| 编号 | 需求 | 上游现状 | 特性编号 | 把握 |
|---|---|---|---|---|
| 1 | 表情回应（普通对话） | 未见；Collective Channel 的回应在做（只记人，不在本仓 API） | F290、F109、F157 | 高 / 中 |
| 2 | 敏感能力默认关闭 / 允许名单 | 允许名单与默认关闭未见；禁用名单与新成员继承「全禁」已有 | F249、F041 | 高 |
| 3 | 撤销运行中一轮的工具 | 未见；共享传输下的插件 MCP 逐次复查已有 | F333 | 中 |
| 4 | 猫身份传给 MCP 子进程 | 自家 MCP 已有；外部与插件 MCP 未见 | — | 中 |
| 5 | 桌面操作审批接入 Approval Hub | 未见；通用授权已下线，Guardian 放行明确不做 | F246、F306、F126 | 高 |
| 6 | 多猫共用电脑的协调 | 在做（A–C ✅），所需各项未见，排队仅有规划 | F126 | 高 |
| 7 | Pack 多包 / 原子安装 | 多包有规划（仅一行注释）；原子安装未见 | F129 | 高 / 中 |
| 8 | 私有 Taste 的存放位置 | 未见 | F221、F332 | 高 |
| 9 | 部署级开关；定时工具可见；技能安装 | 开关未见；`always-visible` 机制已有未启用；通用技能同步已有 | F286、F228、F301、F038 | 中 |
| 10 | 插件 MCP / 技能在非 `runtime` 部署生效 | MCP 已有（有条件，调用时投影）；技能未见 | F202、F333 | 中 |
| 11 | 插件操作状态缺陷；生命周期事件 | 缺陷未见修复；`plugin_operation_changed` 已有（部分） | F202、F265 | 中 |
| 12 | 外部 MCP 安装五项 | 类型校验已有；其余四项未见 | F146、F249 | 高 |
| 13 | 远程 MCP 的 OAuth 登录 | 未见；Codex 的 URL elicitation 已有 | F306 | 中 |
| 14 | 按成员启用技能 | 未见 | F041、F228 | 高 |
| 15 | 成员准入扩展点（P001） | 未见 | F077（不覆盖） | 高 |
| 16 | 部署级主会话指令扩展（P002） | 追加途径已有（`shared-rules.local.md`、Pack）；专用扩展点有规划 | F203、F129、F237 | 中 |
| 17 | 答复检查点；子执行隔离（P003） | 检查点未见；隔离 Codex 已有、Claude 未见 | F306、F318 | 中 |
| 18 | Task ↔ provider 子执行（P004） | 引擎层 `executionRef` 已有；provider 层未见 | F310（规格不公开）、F261 | 中 |
| 19 | 成员模板存取与按模板创建（P005） | 只读 GET 已有；存取与按模板创建未见 | F171 | 高 |

### 上游比 Bot 文档假设走得更远的几处

1. **第 10 条，插件 MCP**：非 `runtime` 部署下，上游在调用时把本机插件激活投影给成员，并非完全到不了猫。需要四个条件同时成立，插件技能仍不生效。
2. **第 16 条，系统提示词追加**：`shared-rules.local.md` 是受支持的追加点，原生 L0 与回退路径同时生效，F203 已 done。
3. **第 2 条，新成员继承**：现有猫全部被禁用的 MCP，新建的猫自动继承禁用。只在「全禁」时成立。
4. **第 17 条，子执行隔离**：Codex 一侧已完成并验收；跨 provider 的事件类型已存在，Claude 没有接。
5. **第 3 条，逐次复查**：共享传输下的插件 MCP 每个请求重查按猫策略。
6. **第 11 条，事件**：`plugin_operation_changed` 已存在。
7. **第 18 条，Task 绑定**：Task 已能绑定到引擎层的子执行（`executionRef`）。

### 上游朝相反方向走的一处

**第 5 条**：通用授权体系已下线并明确不接 Approval Hub，阻塞式提问工具已退役，Guardian 拒绝后的主人放行定为 `unsupported_by_policy`。等上游提供「按动作审批」的前提已不成立。

### 第 20–38 条

| 编号 | 需求（或其中一部分） | 上游现状 | 特性编号 | 把握 |
| --- | --- | --- | --- | --- |
| 20 | 定时列表的归属与正文字段 | 未见 | F139 | 高 |
| 20 | 按 UUID 幂等创建 | 未见 | F139 | 高 |
| 20 | 一次性任务结束后保留 | 未见 | F139 | 高 |
| 20 | 完整正文投递（私有输入通道） | 已有通道，`reminder` 未用 | F139 | 中 |
| 21 | 会话已读位置、未读数 | 已有（文档写 spec） | F069、F072 | 高 |
| 22 | `replyTo` 参与路由 | 未见 | — | 高 |
| 23 | 带版本条件改 `preferredCats` | 未见 | — | 高 |
| 23 | 重复幂等键不重写成员 | 未见 | — | 高 |
| 24 | 无嵌入模型的消息检索 | 已有（词法 + 自动降级） | F324（在做）、F102 | 中 |
| 25 | 插件作为接入形态 | 在做 | F202 | 中 |
| 25 | 宿主产品的 HTTP / 事件 / UI 扩展点 | 有规划 | F202 C2 | 中 |
| 25 | 嵌入式启动器、产品配置存储 | 未见 | — | 中 |
| 26 | 飞书、Telegram、钉钉、企微、微信、小艺 | 在做（实现在仓外插件包） | F202；F088/F132/F134/F137/F151 | 中 |
| 26 | Slack / Discord | 有规划（F088 排除项） | F088 | 高 |
| 27 | 手机端 PWA | 已有（上游前端） | F010 | 高 |
| 27 | Web Push 推送 | 已有 | F010 | 高 |
| 27 | 语音合成、语音消息、语音模式 | 已有 | F034、F066、F092 | 高 |
| 27 | 语音输入 | 已有（上游前端 + 本机 ASR） | F020 | 中 |
| 27 | Apple 原生语音 | 有规划 | F124 | 高 |
| 27 | 跨设备、多机 | 有规划 | F077、F334 | 高 |
| 28 | 富内容块种类（8 种） | 已有 | F022 起 | 高 |
| 29 | 审批待办清单 | 已有 | F246（在做） | 高 |
| 29 | 委托工作等主人清单 | 已有 | F310 | 高 |
| 29 | 合并清单（含被 @） | 在做，只读链已合入 | F317 | 中 |
| 29 | 界面外回答运行时提问 | 已有接口 | F306（在做） | 高 |
| 30 | 画像 `replace_content` / `hard_forget` | 在做，代码在 | F231 → F332 | 高 |
| 30 | 品味四个动作 | 在做，代码在 | F221 → F332 | 高 |
| 30 | 人物记忆动作与遗忘 | 在做，代码在 | F276 → F332 | 高 |
| 30 | 事件、实体的更正 / 停用 / 遗忘 | 在做，代码在 | F227、F260 → F332 | 高 |
| 30 | 各类提案的批准 / 拒绝 | 已有 | F246 | 高 |
| 31 | 事项记忆 Matter | 在做，代码在 | F332 | 高 |
| 31 | 会话缓存冷热（信号） | 已有（PR1） | F338 | 高 |
| 31 | 会话缓存延长保留 | 在做，未实现 | F338 | 高 |
| 31 | 账号与额度 | 在做，代码在，AC 未勾 | F320 | 中 |
| 31 | 主人昵称 `PATCH /api/config/co-creator` | 已有 | — | 高 |
| 32 | 改提醒参数 | 已有（仅周期任务、仅参数） | F139、F246 Phase I | 高 |
| 33 | Codex、Claude Code、DSH、Kimi、Pi、通用 ACP、A2A、OpenCode | 已有 | F161、F050、F105、F158、F318 | 高 |
| 33 | AGY Native | 在做 | F325 | 高 |
| 33 | Gemini CLI、Antigravity IDE | 已退役 | F210（frozen） | 高 |
| 33 | Cursor | 未见 | — | 高 |
| 34 | 队列接口读失败不标注 | 未见（有意 fail-open） | F194 | 高 |
| 34 | 删除猫时结束进行中的一轮 | 未见 | — | 高 |
| 35 | 错误 / 拒绝行带来源 | 未见 | — | 高 |
| 36 | 多用户、会话 ACL | 有规划 | F077 | 高 |
| 37 | `@all` = 全实例的猫 | 已有（上游定义） | F078 | 高 |
| 37 | 只点会话成员（`@thread` 等） | 已有 | F078 | 高 |
| 37 | 主持猫 | 未见 | — | 高 |
| 38 | 重启接续的开关 | 未见 | F048 | 高 |
| 38 | 睡眠接续的开关 | 未见（文档明确不加） | F337 | 高 |
| 38 | 掉球检查的开关 | 未见 | — | 高 |
| 38 | 记忆提交汇总的开关 | 未见 | F332 | 高 |

---

<a id="n-1"></a>
## 1. 表情回应（普通对话）

**上游现状**
- 普通 Thread 消息上的回应记录、读写接口、事件、进入猫的上下文、猫用的回应工具：`未见`。
- 相邻但不覆盖本需求的两处：
  - Collective 公共 Channel/Topic 消息的回应（F290）：`在做`，reaction 子项有实现证据；它只记「人」，表情固定五个。
  - 飞书侧给用户消息加 emoji 回执（F157）：`已有`，是外发到飞书的动作，不是 Thread 消息上的记录。

**依据**
- F290 `docs/features/F290-ai-native-collective.md:75`：「**Status**: in-progress / 2026-10-19」；`:583`「具名、持久、可收回的消息 reaction」；`:594`「W1 的 reaction 子项因此有实现证据」。
- 类型：`packages/shared/src/types/collective-reaction.ts:4`（`COLLECTIVE_REACTION_EMOJIS = ['👍', '❤️', '🎉', '👀', '🐾']`），`:12` 汇总字段是 `humanIds`，没有猫。
- 客户端调用 `packages/collective-client/src/use-collective-collaboration.ts:380` → `/api/collaboration/reactions/set`。在整个子模块里 `grep -rn "collaboration/reactions"` 只命中 collective-client 及其测试，`packages/api/src/routes` 下没有这条路由。「推断」：Collective Service 不在这个仓的 `packages/api` 里。
- 普通消息：`grep -rln -i reaction packages/api/src packages/shared/src packages/mcp-server/src` 的命中里没有 `MessageStore`、`messages.ts`、`message-actions.ts`，也没有任何 MCP 工具；`packages/api/src/routes/message-actions.ts` 只有删除、恢复、block-state 三条（`:31`、`:124`、`:186`）。
- F109 `docs/features/F109-message-actions-overhaul.md:12`：「**Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1」，全文不含 reaction。
- F157 `docs/features/F157-feishu-receipt-ack.md:11`：「**Status**: done | **Completed**: 2026-04-10」。
- 检索词：`reaction`、`表情回应`、`表情反应`、`点赞`、`react_to`、`emoji`、`COLLECTIVE_REACTION_EMOJIS`；另查了 `docs/ideas`、`docs/plans`、`docs/discussions`、`docs/decisions`、`feature-specs`，无命中。

**与需求的差距**：普通对话消息没有回应记录，也没有对应接口、事件、上下文注入和猫工具；F290 的实现是另一条产品线（Collective Channel），只记人、不在本仓的 API 里。

**把握**：高（普通 Thread 部分）。中（「Collective Service 不在本仓」是由路由缺失推出的）。

---

<a id="n-2"></a>
## 2. 敏感能力默认关闭 / 按猫的允许名单

**上游现状**
- 允许名单、或「新装的 MCP 对所有猫默认关闭」：`未见`。
- 按猫的禁用名单（`blockedCats`）及按猫开关接口：`已有`。
- 新成员继承「对全部现有猫都禁用」的 MCP：`已有`（Bot 文档里「给每只新猫预先禁用」这一步，在这一种情形下上游已经做了）。

**依据**
- F249 `docs/features/F249-multi-project-mcp-sync-management.md:12`：「**Status**: in-progress (implementation-backed ACs synced 2026-07-08…」；`:168`「MCP 默认对所有猫可见。只记录"谁不能用"：」；`:177`「**新增成员级联**」；`:881`「- [x] `blockedCats` 按项目按猫控制 MCP」。
- F041 `docs/features/F041-capability-dashboard.md:11`：「**Status**: done | **Owner**: Ragdoll」。
- 类型：`packages/shared/src/types/capability.ts:137`（`blockedCats?: string[]`，注释写明 absent / 空数组 = 所有猫可用）。
- 判定：`packages/api/src/config/capabilities/capability-orchestrator.ts:1622-1632`（`isMcpEnabledForCat`）。
- 按猫开关：`packages/api/src/routes/capabilities.ts:441`（`PATCH /api/capabilities`），`:666-676` 写 `blockedCats`。
- 新成员继承：`capability-orchestrator.ts:719-739`（`inheritFullyBlockedMcpCapabilitiesForNewCatInConfig`，条件是现有猫全部在 `blockedCats` 里），调用点 `packages/api/src/routes/cats.ts:941`、`:1374`，`packages/api/src/config/cat-catalog-store.ts:482`、`:582`。
- 安装时默认开启：`packages/api/src/config/capabilities/capability-install.ts:32`（`enabled: true`，不写 `blockedCats`）；`McpInstallRequest`（`packages/shared/src/types/capability.ts:534-555`）没有「禁用」或「允许名单」字段。
- 检索词：`allowedCats`、`allowCats`、`allowlist`、`defaultEnabled`、`白名单模型`、`默认禁用`、`敏感能力`、`敏感 MCP`、`高风险 MCP`、`opt-in`。

**与需求的差距**：没有「默认关、点名才开」的模型；安装即对所有猫开启，要关只能事后逐只写入禁用名单。新成员继承只在「现有猫全部被禁」时生效，一旦放行了一只猫，后来的新猫就是开启的。另：F249 文档 `:188` 的「[保存]」一行写「globalEnabled: false，不级联」，而安装代码写的是 `enabled: true`，文档与代码在这一点上不一致。

**把握**：高。

---

<a id="n-3"></a>
## 3. 撤销一轮执行已经拿到的工具

**上游现状**
- 通用的「从运行中的一轮里撤掉某个工具」：`未见`。MCP 配置在回合准入时取定，之后只有准入期的一次性校验。
- 部分情形已有逐次复查：走共享 HTTP 传输的**插件 MCP**，每个请求都会重读该猫的访问策略，被禁用后下一次调用得到 403（F333，`在做`）。外部 stdio MCP 不在此列。

**依据**
- 准入期校验：`packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts:1649-1658`（「MCP configuration changed during execution admission; retry…」），只在准入时抛出。
- 逐次复查：`packages/api/src/routes/plugin-shared-mcp.ts:69-82`（`assertCurrent`），`packages/api/src/routes/plugin-shared-mcp-access.ts:20-70`，注释 `:40`「must still be read afresh on every check」。
- F333 `docs/features/F333-shared-mcp-process-lifecycle.md:18`：「**Status**: in-progress | **Owner**: 小星星·Maine Coon…」；`:187` AC-A4 已勾，含「排队后撤销和迟到请求的反例不能扩大权限」；`:193` AC-B1（第三方）未勾，含「插件 activation/grant/revoke 在迁移后仍生效」。
- `packages/api/src/config/capabilities/capability-revoke.ts:10`（`revokeCapability`）只返回一个 `enabled: false` 的条目，全仓没有调用方（`grep -rn revokeCapability` 仅命中定义）。
- 检索词：`revoke`、`mid-turn`、`运行中.*撤销`、`撤销.*工具`、`tool revocation`、`hot-revoke`、`热撤销`。

**与需求的差距**：对 Bot 用到的外部 stdio MCP，没有回合内撤销的办法，仍只能取消整轮。逐次复查只覆盖共享传输下的插件 MCP。

**把握**：中。未逐行确认 `assertCurrent` 在每次工具调用都执行，只确认它在每个请求的建连路径上。

---

<a id="n-4"></a>
## 4. 把猫的身份传给 MCP 子进程

**上游现状**
- 上游自家的 `cat-cafe-*` MCP：`已有`，Claude Code 与 Codex 两条路径都显式传 `CAT_CAFE_CAT_ID`。
- 外部（第三方）stdio MCP：`未见`。两条路径都只给 MCP 自己配置的 `env`；Claude Code 一侧是 CLI 进程环境里带着它，子进程继承而来「推断」，Codex 一侧没有。
- 插件 MCP：两条路径都只绑定传输凭据（`CAT_CAFE_API_URL`、`CAT_CAFE_INVOCATION_ID`、`CAT_CAFE_CALLBACK_TOKEN` 等），不含 `CAT_CAFE_CAT_ID`。

**依据**
- 键表：`packages/mcp-server/src/mcp-launch-contract.ts:12-23`（`MCP_CALLBACK_ENV_KEYS` 含 `CAT_CAFE_CAT_ID`）。
- Claude 路径：自家 MCP `packages/api/src/domains/cats/services/agents/providers/provider-mcp-config.ts:51-67`、`:113-121`；外部 MCP `:139`（`pluginMcpEnvironment(s, input.callbackEnv)`）。CLI 进程环境含回调变量：`ClaudeAgentService.ts:287`。
- Codex 路径：`CodexAgentService.ts:962`（外部取 `s.env`，插件取 `bindPluginMcpEnvironment`）；`:1005-1011` 只在 `isCatCafe` 时写回调变量；包装脚本 `:804-848` 只合并配置里的 `env`。
- 插件绑定的键：`packages/api/src/config/capabilities/plugin-mcp-environment.ts:4-11`（`TRANSPORT_KEYS`，无 cat id）。
- 文档：`grep -rn CAT_CAFE_CAT_ID docs/features/*.md` 无命中。

**与需求的差距**：Codex 猫的外部 MCP 子进程拿不到 `CAT_CAFE_CAT_ID`，上游也没有把它列为传给外部 MCP 的约定；Claude Code 一侧能拿到是环境继承的副作用，不是契约。

**把握**：中。Codex CLI 不向 MCP 子进程透传自身环境这一点属于上游之外的行为，这里没有验证。

---

<a id="n-5"></a>
## 5. 桌面操作的审批接入 Approval Hub

**上游现状**：`未见`。没有按动作或按应用、由主人审批的桌面操作路径。相关的三处上游决定都朝相反方向走：
- 通用授权体系已经下线，不接 Approval Hub。
- 阻塞式的 MCP 提问工具 `cat_cafe_request_user_input` 已退役。
- Codex 原生 Computer Use 被 Guardian 拒绝后的「主人放行」明确不做（`unsupported_by_policy`）。
另有一处 `在做`、但不是人工审批：Codex 原生 `cua_repl` 在 provider 自动审查通过后由宿主按会话放行（AC-D4，已在 main 实现，生产启用待定）。

**依据**
- F246 `docs/features/F246-approval-hub.md:13`：「**Status**: in-progress（Phase A–H done；Phase I Wave 0–2 已落地；…」；census 表「✅ sunset disposition：当前无需求，不接 Hub」、「| Limb | pair_approve | ❌ Dropped（operator） |」；AC-I12「不接入 Authorization system」。
- F306 `docs/features/F306-codex-app-capability-parity.md:46`：「**Status**: in-progress | **Owner**: 小太阳·Maine Coon…」；`:117`「不创建 Clowder AI owner-allow 卡、不建立平行 grant」；AC-D4「implemented on main #4530 (`602d4275ac`)」未勾；AC-D7「**unsupported at current provider contract；no recovery code landed**」；AC-B2「当前没有 production writer 选择它」。
- Claude Code 猫默认跳过权限：`ClaudeAgentService.ts:81`（`PERMISSION_MODE = 'bypassPermissions'`），`claude-sdk-launch.ts:238`。
- 四肢 `gated` 只返回错误、不发起审批：`packages/api/src/domains/limb/LimbRegistry.ts:117-119`。
- 旧授权路由已不存在：`ls packages/api/src/routes | grep -i 'authoriz\|permission'` 只剩 `callback-negative-authorization-fence.ts`；`request_permission` 只在 ACP 相关文件出现。
- Approval Hub 现有适配器：`packages/api/src/domains/approval-hub/adapters/`（F128、F139、F193、F221、F225、F231、F260、F266、F276、F306、F321），没有电脑操作或四肢。
- 检索词：`computer-use`、`computer_use`、`cua_repl`、`电脑操作`、`桌面操作`、`bypassPermissions`、`canUseTool`。

**与需求的差距**：按动作或按应用的人工审批在上游不存在，且通用授权入口已被移除；F306 的放行只针对 Codex 自带的 Computer Use，靠机器审查，不产生给主人的卡片。

**把握**：高。

---

<a id="n-6"></a>
## 6. 几只猫共用一台电脑的协调（F126 四肢控制面）

**上游现状**：F126 `在做`，Phase A–C 标 ✅，Phase D（Apple 设备）未做。Bot 需要的各部分都不在已完成之列：
- 跨多次调用、持有到回合结束的租约：`未见`。现有租约是单次调用内取放。
- 忙时排队：`有规划`，只在 Phase B 的设计文字里，无验收条目、无代码；现状是直接返回失败。
- 比 capability 更细的租约对象（如某个应用）：`未见`。键是 `nodeId + capability`。
- 按猫的策略：类 `已有`，但 `setPolicy` 没有生产调用方、没有路由，实际恒用能力自带的 `authLevel`。
- `gated` 接 Approval Hub：`未见`，直接返回错误；F246 census 写明 Limb 一项已放弃。
- 设备结果带图片、或把设备挂成 MCP server：`未见`。结果只有 `data` 与 `artifactUri`；远程节点走普通 HTTP `POST /invoke`。

**依据**
- `docs/features/F126-limb-control-plane.md:11`：「**Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1」；`:112`「可配置：严格模式（拒绝）/ 宽松模式（排队等待）」；`:206`「### Phase B（调度层 — Lease/Scheduler + Access Policy + Action Log）✅」；`:124`「独立于 F126 推进」（指全局按猫工具策略）。
- 单次租约：`packages/api/src/domains/limb/LimbRegistry.ts:122-129` 取，`:162-165` 放，注释「Auto-release lease after single invoke」。
- 忙时拒绝：`LimbRegistry.ts:126`（「is currently leased by another cat」）。
- 租约键与默认 TTL：`LimbLeaseManager.ts:28`、`:16`（`defaultTtlMs: 60_000`）。`renew`、`releaseAllByCat`、`expireAll` 在 `packages/api/src` 里没有生产调用方。
- 策略未接线：`LimbAccessPolicy.ts:18`（`setPolicy`）只有定义；`packages/api/src/index.ts:5077` 新建一个空策略。
- 结果类型：`packages/shared/src/types/limb.ts:61-66`。MCP 工具把结果作为文本回调返回：`packages/mcp-server/src/tools/limb-tools.ts`（`handleLimbInvokeTool`）。
- 远程节点：`packages/api/src/domains/limb/RemoteLimbNode.ts:60-66`。
- 路由：`packages/api/src/routes/limb-node-routes.ts:45`、`:93`、`:108`；`callback-limb-routes.ts:107`、`:131`、`:150`。

**与需求的差距**：上游的租约防的是同一瞬间的并发调用，不是一轮对话期间的独占；排队、细粒度对象、按猫策略的设置入口、审批接线、图片结果都还没有。

**把握**：高。

---

<a id="n-7"></a>
## 7. Pack（F129）：多包合并或指定生效的包；原子安装

**上游现状**
- 多包合并或指定生效的包：`有规划`，仅见于一行代码注释；F129 文档的 Phase B 文字和验收条目都没有列这一项。现状是取目录序第一个。
- 原子安装：`未见`。先删后拷。
- F129 整体 `在做`：Phase A ✅；Phase B 勾了 B1、B2、B4、B7，B3、B5、B6 未勾；Phase C 未做。

**依据**
- `docs/features/F129-pack-system-multi-agent-mod.md:11`：「**Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1」。
- `packages/api/src/domains/packs/getActivePackBlocks.ts:5`：「Multi-pack merge is Phase B.」；`:24`（`manifests[0]`）。
- `packages/api/src/domains/packs/PackStore.ts:32-33`（`rm` 后 `cp`），`:47-58`（`list` 用 `readdir` 的顺序）。
- 路由：`packages/api/src/routes/packs.ts:38`、`:57`、`:62`、`:73`，没有「启用」「排序」「选择」类接口。
- 检索词：`multi-pack`、`多包`、`多 Pack`、`merge`、`合并`、`atomic`、`原子`、`activate`、`激活`、`active pack`。

**与需求的差距**：两项都未实现；多包合并连验收条目都没有，只有注释里的一句意向。

**把握**：高（代码现状）。中（把一行注释算作「有规划」）。

---

<a id="n-8"></a>
## 8. 私有偏好（Taste, F221）的存放位置

**上游现状**：`未见`。私有 Taste 仍写在「检出 `refs/heads/main` 的那个 git worktree」下的 `private/taste/`，没有数据目录方案，也没有环境变量或配置可以指定位置。

**依据**
- `docs/features/F221-taste-lane.md:17`：「**Status**: closed (consolidated into F332; 未完成结果继续承接，非全部交付)」；`:294` KD-9「通用 workspace root 不是 canonical-main locator」；`:236`「Approved sensitive proposal -> `private/taste/{slug}.md` 写入成功」。
- `packages/api/src/domains/taste/services/TasteRepository.ts:53-58` 注释「environment roots are intentionally not consulted」；`:74-78` 找不到时抛「cannot find a checked-out refs/heads/main worktree」。
- 写入位置：`packages/api/src/domains/taste/services/writeVignette.ts:50`。
- 构造：`packages/api/src/index.ts:1254`（`new FileTasteRepository(findMonorepoRoot(process.cwd()))`）。
- F332 `docs/features/F332-experience-informed-memory.md:30`「**Status**: in-progress（第1步画像次数、文案和更正读取路径…」，全文不含 Taste 存放位置的调整。
- 检索词：`private/taste`、`refs/heads/main`、`数据目录`、`data dir`、`non-git`、`非 git`、`TASTE`（环境变量表）。

**与需求的差距**：需求完全未被覆盖；上游把「必须是 main 工作树」写成了有意的设计决定。

**把握**：高。

---

<a id="n-9"></a>
## 9. 部署级的 CLI 技能与工具开关；定时工具默认可见；适合聊天部署的技能安装方式

**上游现状**
- 部署级开关（关掉 Agent 自带的技能或工具）：`未见`。`cliConfigArgs` 只在成员级；`--disable-slash-commands` 只用于插件受限成员。
- 定时工具默认可见：机制 `已有` 但没有用在任何工具上。`always-visible` 这一档会投影成 `anthropic/alwaysLoad`，而全部工具都登记为 `host-default`；承载它的 F286 已冻结。默认提示词的工具索引里也没有列定时工具。
- 技能安装：通用的同步与挂载 `已有`（F228 Phase A+B、F301）；专门面向聊天部署的安装方式 `未见`。上游技能 `schedule-tasks` 在源里存在。

**依据**
- 成员级参数：`packages/api/src/domains/cats/services/types.ts:1103`（`cliConfigArgs`），`packages/api/src/index.ts:7354`、`:7430`。部署级参数的检索（`EXTRA_CLI_ARGS`、`GLOBAL_CLI_ARGS`、`defaultCliConfigArgs`、`deploymentCliArgs`）无命中。
- `--disable-slash-commands`：`ClaudeAgentService.ts:545`、`claude-sdk-launch.ts:259`，均在 `member` 分支。
- 投影：`packages/mcp-server/src/server-toolsets.ts:195-197`。工厂写死 `host-default`：`packages/mcp-server/src/tool-governance-migration.ts:176-180`、`tool-governance.ts:138-142`。基线 `packages/mcp-server/governance/mcp-surface-baseline.json` 里 `"host-default"` 185 处、`"always-visible"` 0 处。
- F286 `docs/features/F286-mcp-surface-lifecycle-governance.md:24`：「**Status**: frozen（Phase A–C complete；Phase D 停在 Signals 试点之前…」；`:136`「现行代码里 `discoverable` 和 `host-default` 注册行为相同」。
- 提示词索引：`assets/prompt-templates/l5-mcp-tools-index.md` 末行「未暴露的工具先 `tool_search`」，全文无 `schedule`。
- 定时工具：`packages/mcp-server/src/tools/schedule-tools.ts:297`、`:313`、`:330`、`:348`。技能：`cat-cafe-skills/schedule-tasks/`，清单 `cat-cafe-skills/manifest.yaml:890`。
- 技能同步：`packages/api/src/routes/skills-write.ts:60`（`POST /api/skills/sync`）、`:177`（`/api/skills/sync-skill`）。
- F228 `docs/features/F228-multi-project-skill-mount-management.md:12`：「**Status**: Phase A + B done (2026-06-17) | Phase C planning」。F301 `:16`「**Status**: done | **Completed**: 2026-08-21」。F038 `:11`「**Status**: parked (方向 A 已落地，方向 B 待 skill 数量增长后再做)」。
- F041 已知限制 `docs/features/F041-capability-dashboard.md:273`「CLI 仍会自动加载（如果 symlink 存在）」。

**与需求的差距**：三项里只有通用技能同步是现成的；部署级开关和「定时工具默认可见」都没有，后者的底座在但已冻结且未启用。

**把握**：中。「聊天部署的技能安装方式」这一项需求边界不清，这里只报告了现有的安装途径。

---

<a id="n-10"></a>
## 10. 插件带的 MCP 与技能在非 `runtime` 部署下对成员生效

**上游现状**
- 插件 MCP：`已有`（有条件）。非发布型部署不写 `capabilities.json`，但在每次调用时把本机已验证的插件激活投影进该次调用的 MCP 配置。这比「插件 MCP 到不了猫」的假设更进一步。
- 插件技能：`未见`。`persistCapabilities` 为 false 时只落地文件，不挂载、不登记。

**依据**
- 判定：`packages/api/src/config/capabilities/startup-cli-config.ts:48-62`（部署 id 非 `runtime` 且非空 → `false`）。
- 传入：`packages/api/src/domains/plugin/runtime-composition.ts:648`。
- MCP 仍产出启动描述：`packages/api/src/domains/plugin/declared/declared-mcp-resources.ts:53-66`（先 `launches.push`，再在 `:66` 跳过持久化）。
- 调用时投影：`packages/api/src/domains/plugin/carrier/runtime-carrier.ts:307-312`，注释「isolated Hosts never publish into shared configuration」；`packages/api/src/config/capabilities/plugin-mcp-exposure.ts:39-92`；接入点 `invoke-single-cat.ts:1565-1568`、`:1606-1608`，以及 `capability-orchestrator.ts` 的 `resolveServersForCat`（经 `invocationPluginMcpConfig`）。
- 投影的条件（均出自上述源码）：调用带 `ownerAuthProvenance === 'strict'`；Thread 的项目路径（为 `default` 时取工作目录）与宿主的能力根是同一目录；不是受限成员；`capabilities.json` 里没有同名条目。
- 技能：`packages/api/src/domains/plugin/declared/declared-static-resources.ts:127`（`if (host.persistCapabilities === false) return;`，在 `addSkill` 之前）；类型注释 `:24`「Read-only deployments keep local resources/launches」。
- 该文件最近一次提交：`15a11a53 2026-11-14 fix: 隔离失效插件 MCP，恢复 ACP 会话初始化 (#1990)`。
- F202 `docs/features/F202-plugin-framework.md:63`：「**Status**: in-progress (Train B direction accepted in」。F333 状态见第 3 条。两份文档都没有专门描述这条投影；`docs/architecture/ownership/cells/mcp-surface-governance.md:49` 列出了该文件。

**与需求的差距**：插件技能在非 `runtime` 部署下仍不生效。插件 MCP 能到达成员，但依赖上面四个条件，且不出现在 `capabilities.json` 里，因此没有按猫禁用的落点。

**把握**：中。结论来自读源码，没有在 Bot 的部署形态下验证四个条件是否都成立。

---

<a id="n-11"></a>
## 11. 插件操作状态缺陷与插件生命周期事件

**上游现状**
- `operationState` 缺陷：`未见` 修复。引擎在有已存状态时仍把 `operationState` 放进动作参数。
- 重置接口：`已有`。
- 插件状态事件：`已有`（部分）。有一个 `plugin_operation_changed` 事件，在插件管理操作开始和结束时各发一次，只带 `pluginId`；没有找到运行态或健康度变化的事件，也没有包声明的操作状态变化的事件。

**依据**
- 传参：`packages/api/src/domains/plugin/operations/plugin-operation-routes.ts:376-388`。
- 重置：同文件 `:617-626`（`POST /api/plugins/:pluginId/operations/:operation/reset`）；动作 `:548-549`。
- 事件：`packages/api/src/index.ts:5868-5869`；触发点 `packages/api/src/domains/plugin/manager/plugin-manager-service.ts:290-300`；前端订阅 `packages/web/src/hooks/useSocket.ts:651`。
- 插件包本体不在子模块里：`grep -rln wechat-visible-reader` 只命中 web 的 fixture 与 tips 种子，`find . -iname '*wechat*'` 只有文档和引导流程。因此「插件拒收未知字段」这一半无法在这里核对。
- F265 `docs/features/F265-wechat-visible-reader.md:15`：「**Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex-sol) | **Priority**: P1」。F265 与 F202 两份文档里检索 `operationState`、`operation state`、`operations/.*reset` 无命中。
- 检索词（事件）：`plugin_operation_changed`、`plugin_state`、`plugin_lifecycle`、`plugin_inventory`、`operationChanged`。

**与需求的差距**：缺陷在引擎一侧原样存在，上游文档未提及；事件只覆盖管理操作的起止，不足以让宿主产品跟踪插件的运行状态。

**把握**：中。缺陷的另一半在未收录的插件包里。

---

<a id="n-12"></a>
## 12. 外部 MCP 安装：校验、拒绝静默覆盖、原子的「不存在才创建」；请求头不分大小写合并；探活错误脱敏

**上游现状**（F146 文档 `已有`/done，但所需的几项多数没有）
- 校验：`已有`（部分）。只做类型校验，拒绝脱敏占位符；不校验 id 格式、`env` 值类型、`transport` 取值；缺 command/url 只算风险提示。
- 拒绝静默覆盖：`未见`。同名外部 MCP 直接合并写入；预览接口只给一句风险；只有受管 MCP 会 403。
- 原子的「不存在才创建」：`未见`。写入在进程内锁里，但请求没有 create-only 选项。
- 请求头不分大小写合并：`未见`。`Object.assign` 按原样键名合并。
- 探活错误脱敏：`未见`。原样返回异常消息。

**依据**
- `docs/features/F146-mcp-marketplace-control-plane.md:13`：「**Status**: done | **Completed**: 2026-04-19」；`:110`「写入能力必须串行化（锁）或带版本号 CAS」。
- 校验：`packages/api/src/config/capabilities/capability-install.ts:6-27`；风险文案 `:49-54`（「already exists — install will overwrite」）。
- 安装：`packages/api/src/routes/capabilities-mcp-write.ts:200`；同名外部合并 `:292-301`；受管 403 `:294-298`；锁 `:240`。
- 合并：同文件 `:88-96`（`mergeSecretRecord`，`:94` 为 `Object.assign`）。对照：Codex 取 Authorization 头时做了不分大小写查找（`CodexAgentService.ts:934`），仅此一处。
- 探活：`packages/api/src/routes/mcp-drift.ts:228`（`POST /api/mcp/:id/tools`），`:297-311` 原样回传；`packages/api/src/routes/mcp-probe.ts:184`、`:228`、`:279`（`error: (err as Error).message`）。
- 响应里的配置脱敏是有的（`sanitizeCapabilityForResponse`，`capabilities-mcp-write.ts:349`），但不覆盖探活错误文本。

**与需求的差距**：五项里只有基础类型校验和并发串行化是现成的，其余四项都没有。

**把握**：高。

---

<a id="n-13"></a>
## 13. 远程 MCP 的浏览器登录（OAuth）

**上游现状**
- 能力管理面上的远程 MCP OAuth 登录：`未见`。远程 MCP 只有 URL 加静态请求头。
- 相邻：Codex app-server 的 URL 型 elicitation 通道（F306 Phase B）`已有`，MCP server 可经它让用户打开一个网址；这是 Codex 原生交互，不是通用的 OAuth 登录流程。

**依据**
- 远程 MCP 描述：`packages/shared/src/types/capability.ts:534-541`（`url`、`headers`）；Codex 侧把 `Authorization: Bearer` 映射为环境变量 `CodexAgentService.ts:934-951`。
- `grep -rn -i oauth` 在 `packages/api/src/routes/mcp*.ts`、`packages/api/src/config/capabilities`、`packages/api/src/mcp` 无命中。
- URL elicitation：`packages/shared/src/types/runtime-interaction.ts:170-179`；路由 `packages/api/src/routes/runtime-interaction-routes.ts:37`、`:56`、`:83`。
- F306 AC-B1 已勾：「至少 Codex approval、request-user-input 与 elicitation 三类 fixtures」；Phase D `:305`「安装、授权、secret、resource lifecycle 仍走家里的单一产品入口」。
- 检索词：`oauth`、`mcpServer/oauth`、`oauthLogin`、`McpOAuth`、`mcp_oauth`。

**与需求的差距**：没有为远程 MCP 发起、回调并保存令牌的登录流程。

**把握**：中。没有逐个检查各 provider CLI 自带的 MCP OAuth 是否被上游透传。

---

<a id="n-14"></a>
## 14. 按成员启用技能

**上游现状**：`未见`。技能的开关只有「全局」和「项目」两个范围，挂载粒度是 provider 的挂载点，不是猫。

**依据**
- `packages/api/src/routes/capabilities.ts:498-505`，错误文案「Skills accept "global" or "project".」；`:516-518` 拒绝技能使用 `cat` 范围。
- 挂载点：`packages/shared/src/types/capability.ts:113` 注释（`'claude'`、`'codex'`）。
- F041 `docs/features/F041-capability-dashboard.md:28` 的痛点写过「Skills 增长后需要按猫控制加载范围，避免 token 浪费」，`:269`「Skills 运行时强制执行受限于 CLI（2026-02-27）」，后续方案两条都未见实现。
- F228 状态见第 9 条，范围写明是多项目 / 按 provider。
- 检索词：`per-cat skill`、`按猫.*skill`、`猫级.*skill`、`按成员.*技能`、`成员级.*skill`。

**与需求的差距**：没有按成员的技能开关；同一 provider 的猫共用一套挂载。

**把握**：高。

---

<a id="n-15"></a>
## 15. 正式的成员准入扩展点（补丁 P001）

**上游现状**：`未见`。`routes/thread-participant-admission.ts` 做的是相反的事：把已经路由到的猫**登记**为 Thread 参与者并通知侧栏，不拦任何猫。上游没有「只有这些猫可以在这个 Thread 里执行」的强制点。

**依据**
- `packages/api/src/routes/thread-participant-admission.ts:17-21` 注释「Persist the final admitted targets as canonical thread participants」；`:36` 调 `addParticipants`。调用方：`messages.ts:73`、`queue.ts:84`、`proposal-seed-admission.ts:9`。
- Thread 路由偏好是软约束：`packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts:81-82`「Avoid routing to these cats unless explicitly @mentioned.」
- F077 `docs/features/F077-multi-user-secure-collab.md:12`：「**Status**: spec | **Owner**: Ragdoll」；`:31` Thread ACL 是「`ownerUserId` + `access: private|shared` + `memberUserIds[]`」，对象是人，不是猫。
- 检索词：`assertThreadParticipant`、`restrictToParticipants`、`participantsOnly`、`allowedCats`、`lockedParticipants`、`rosterLock`、`closedRoster`、`membersOnly`、`strictParticipants`、`participantLock`，在 `packages/api/src`、`packages/shared/src` 均无相关命中。

**与需求的差距**：直接调用、排队、A2A 三条路径上都没有名单强制；F077 即使做完也不覆盖这一点。

**把握**：高。

---

<a id="n-16"></a>
## 16. 部署级主会话指令扩展（补丁 P002）

**上游现状**
- 向系统提示词追加部署自己的文字：`已有`，有两条受支持的途径。
  - `cat-cafe-skills/refs/shared-rules.local.md`：追加到编译后的治理段，原生 L0 与回退路径同时生效（F203，done）。同目录的 `shared-rules.local-override.md` 是整段替换。
  - Pack 的 `defaults.yaml` / `guardrails.yaml`：每条 ≤500 字符、各 ≤50 条，编译进提示词（F129 Phase A ✅）。
- 三个段的本地覆盖文件（S6 `workflow-triggers.local.yaml`、S13 `mcp-tools.local.md`、C1 `c1-mcp-callback.local.md`）及写接口：`已有`（F237 Phase 1）。
- 专门的「自定义钩子 / 部署指令块」扩展点：`有规划`，只在 F237 的 Future Work 里列了一行。

**依据**
- F203 `docs/features/F203-native-system-prompt-l0.md:13`：「**Status**: done（operator 签字降级 2026-06-19，AC-I8 deferred）」；`:229` AC-G3 已勾「`.local.md` / `.local-override.md` 挂到编译层 ✅」；`:158`「native + fallback 同时生效」。
- 源码：`packages/api/src/domains/cats/services/context/governance-l0.ts:280-289`、`:345-348`（追加标题「### 本地治理覆盖（shared-rules.local.md）」）；整段替换 `:238-247`；约定 `packages/api/src/utils/local-override.ts:4-8`；进入 L0 输入 `packages/api/src/domains/cats/services/agents/providers/l0-input-capture.ts:65`；纳入变更指纹 `l0-dependency-signature.ts:7-11`。这类文件被忽略提交：`.gitignore:43-48`。
- Pack：`packages/shared/src/schemas/pack.ts:60`、`:78`（`boundedString(500)`），`:67`、`:85`（`max(50)`）；F129 AC-A8「workflows/guardrails 不能有任意 instruction 文本」。
- F237 `docs/features/F237-prompt-injection-visibility.md:13`：「**Status**: Phase 1 done (clowder-ai#859 via cat-cafe#2505 `b859eb38`) · …」；Future Work「**Custom User Hooks** — operator-registered hooks with security sandboxing」。写接口 `packages/api/src/routes/prompt-injection.ts:264`、`:327`、`:365`。
- 钩子目录是内置的：`packages/api/src/domains/prompt-hooks/PipelinePromptBuilder.ts:59-63`（固定扫 `assets/prompt-hooks/`）。

**与需求的差距**：追加文字的途径是有的，但都不是为「给主会话加一块部署指令」设计的：`shared-rules.local.md` 放在引擎目录里、对所有猫所有会话生效、落在治理段内；Pack 有长度和条数上限，且只取第一个包（见第 7 条）。没有只作用于主会话、位置独立的扩展点。

**把握**：中。没有实际编译 L0 查看输出；Pack 段在原生提示词与消息前缀之间的投递方式也没有逐一核对。

---

<a id="n-17"></a>
## 17. 长驻 invocation 的答复检查点与子执行输出隔离（补丁 P003）

**上游现状**
- 每轮答复检查点（后台子任务还在跑时，先把短答复写进聊天记录）：`未见`。猫的流式消息在 provider 流结束后一次写入；Claude SDK 载体会把流一直开到原生 idle，即后台工作及其回报轮都排空之后。
- 子执行输出不进主文本：Codex `已有`（F306 AC-D6，已勾）；Claude `未见`，流解析里没有按 `parent_tool_use_id` 过滤。

**依据**
- 一次写入：`packages/api/src/domains/cats/services/agents/routing/route-serial.ts:3281`（`storedMsg = await deps.messageStore.append(streamMessageInput)`，在 done 之后）；流中途只有按 invocation 存的草稿（同文件 `:3336` 等处在落库后删除）。
- 开到 idle：`packages/api/src/domains/cats/services/agents/providers/ClaudeSdkAgentService.ts:343-348`，注释「A result alone can precede queued reports.」；`claude-sdk-turn-input-state.ts:144-152`。
- Claude 无过滤：`grep -c parent packages/api/src/domains/cats/services/agents/providers/claude-ndjson-parser.ts` 为 0；`ClaudeSdkAgentService.ts:56` 的 `parent_tool_use_id` 只用于输入消费的对账。`task_started`、`task_notification`、`SubagentStart` 在 `packages/api/src` 无解析代码。
- Codex 隔离：`CodexSubexecutionTracker.ts`、`CodexSubexecutionIdentity.ts`；类型 `packages/shared/src/types/provider-semantic-event.ts:20`（`'subexecution'`）。F306 `:90`「child 内容不得再进入 root text」；AC-D6「**implemented + Alpha-accepted**」。
- F318 `docs/features/F318-claude-agent-sdk-native-carrier.md:17`：「**Status**: done（operator 确认 A2A 整合后的当前接入完成；…」；能力表 `:166`、`:178` 把后台任务帧与 subagent 标为 `adapted`，但源码里没有对应解析。
- 检索词：`parent_tool_use_id`、`parentToolUseId`、`sidechain`、`isSidechain`、`subagent`、`subexecution`、`checkpoint`、`turnBoundary`、`flushSegment`、`persistSegment`。

**与需求的差距**：Claude Code 猫的两项都没有；`ProviderSubexecutionSemanticEvent` 是跨 provider 的类型，但只有 Codex 在产出。

**把握**：中。检查点一项只核了串行路由（`route-serial.ts`），并行路由未逐行看。

---

<a id="n-18"></a>
## 18. Task 到 provider 子执行的生命周期接口（补丁 P004）

**上游现状**
- Task 绑定到引擎自己的子执行（一次 invocation）：`已有`（`executionRef`）。
- Task 绑定到 provider 的子执行（SDK task id）：`未见`。
- 对 provider 子执行的精确 stop / cancel / resume：`未见`。现有的取消是对等待项和整轮执行。
- 相关事实位：`providerTeardown: 'unconfirmed'`、Task 的只读 `recovery` 投影：`已有`。
- F310 的规格文档不在公开仓里，子模块中只有一份治理证据投影，无法据文档判断规划。

**依据**
- `packages/shared/src/types/task.ts:191-198`（`TaskExecutionRef`：`invocationId`、`parentInvocationId`、`catId`、`threadId`、`sourceMessageId`），注释「An exact reference to the existing child execution owner」；`:235`；`:200-213`（`recovery`，注释写明不落库）。
- 变更规则：`packages/api/src/domains/cats/services/stores/ports/OrdinaryTaskMutation.ts:73`、`:155-164`、`:197-198`。
- `packages/api/src/domains/cats/services/types.ts:316-317`：「Host completion cannot attest that this provider stopped」。
- 路由：`packages/api/src/routes/tasks.ts:299`（`/api/tasks/:id/cancel-wait`）、`:359`、`:374`；交接相关文件 `callback-task-handoff.ts`、`task-handoff-dispatch-authority.ts` 存在，处理的是猫之间的 Task 交接。
- `docs/features/F310-growing-real-delegation.md:6`：`doc_kind: mcp-evidence`；正文「private operating context remain in the source repository」。
- F261 `docs/features/F261-agy-durable-execution-recovery.md:16`：「**Status**: frozen (superseded-by F325; not completed)」。
- 检索词：`sdkTaskId`、`providerTaskId`、`providerSubexecution`、`subexecutionId`、`nativeTaskId`、`providerRunId`、`stopSubexecution`、`cancelSubexecution`、`TaskStop`、`stop_task`、`resumeSubexecution`。

**与需求的差距**：上游的 Task 只认引擎层的执行，不认识 provider 内部的子任务，也没有针对它的停止或续跑接口。

**把握**：中。F310 规格不可见；「handoff boundaries」这一小项只确认了相关文件存在，没有深入其语义。

---

<a id="n-19"></a>
## 19. 成员模板的存取与按模板创建（补丁 P005）

**上游现状**
- 读取模板：`已有`，只读，来源是 `cat-template.json` 的 `roleTemplates`。
- 模板的增删改存储：`未见`。
- 服务端按模板创建成员：`未见`。`POST /api/cats` 不接受模板参数。

**依据**
- `packages/api/src/routes/cats.ts:1009-1010`，注释「获取角色模板（纯灵魂层，不含 client/model 绑定）」；`:1074`（`POST /api/cats`）；`grep -n "templateId\|fromTemplate" packages/api/src/routes/cats.ts` 无命中。
- `/api/cat-templates` 只有这一条 GET（`grep -rn "cat-templates" packages/api/src` 仅命中上面两行）。
- F171 `docs/features/F171-first-partner-onboarding.md:13`：「**Status**: done | **Owner**: Maine Coon/gpt52 | **Priority**: P1…」；`:84` AC-B1 说的是在一个流程里「完成模板选择、账号配置、连通性验证、创建第一只猫」，由前端组装。
- `packages/api/src/routes/config-onboarding.ts` 只存取引导回执，与模板无关。
- 检索词：`roleTemplates`、`cat-templates`、`自定义模板`、`保存为模板`、`save as template`（`docs/features`、`docs/ideas`、`docs/plans`、`docs/decisions`），无规划类命中。

**与需求的差距**：没有模板的写入存储，也没有按模板创建的服务端入口。

**把握**：高。


---

<a id="n-20"></a>
## 20. 定时的字段与幂等

**上游现状**（分四部分）

| 部分 | 现状 |
| --- | --- |
| 列表里的归属与正文字段 | 未见（只有 `deliveryThreadId` 与调用方自己传的 `display`） |
| 按 UUID 幂等创建 | 未见（仅 F310 一种专用模板按确定 id 合并） |
| 一次性任务结束后保留 | 未见（执行后、错过窗口后都删除定义） |
| 完整正文投递 | 已有投递通道（`privateContent`），`reminder` 模板未使用；把握中 |

**依据**
- F139 `F139-unified-schedule-abstraction.md`，Status 行：「`> **Status**: done | **Owner**: Ragdoll | **Priority**: P1`（后略）」。文档 Phase 1a–4 的 AC 全部打勾（AC-C4 划掉回退）。
- 列表：`GET /api/schedule/tasks`（`api/routes/schedule.ts:66`）。返回形状 `ScheduleTaskSummary`（`api/infrastructure/scheduler/types.ts:282-305`）：`id / profile / trigger / enabled / effectiveEnabled / actor / context / lastRun / runStats / display / subjectPreview / source / dynamicTaskId / deliveryThreadId / registered`。没有 `templateId`、`params`（含 `message`、`targetCatId`）、`createdBy`、版本或指纹字段。
- `display` 不是正文：模板自己算的 `display.description: message`（`api/infrastructure/scheduler/templates/reminder.ts:162-165`）在落库注册时被覆盖——`spec.display = def.display`（`api/routes/schedule-owner-commit.ts:38`），而 `def.display` 取自请求体 `body.display`，缺省为模板的固定文案（`api/routes/schedule-task-create-route.ts:153-159`）。
- `createdBy` 只在存储里（`api/infrastructure/scheduler/DynamicTaskStore.ts:55`），未进列表。
- 创建：`POST /api/schedule/tasks`（`api/routes/schedule-task-create-route.ts:54`）。id 由服务端生成：`dyn-${Date.now()}-${Math.random()…}`（同文件 `:150-152`）；请求体没有幂等键字段。唯一的合并分支只认 `ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID`（`:191-207`，返回 `coalesced: true`），其余同 id 回 409。检索 `idempot|clientRequestId|Idempotency` 于 `api/routes/schedule*.ts`：无。
- 创建权限已变：主人会话直接生效；猫发起的创建变成审批提案，回 202 `proposed: true`（`:208-234`）。F139 文档「The task is not created or deleted before the owner approves it」。
- 一次性任务：`retireOnceTask` 执行后 `this.dynamicTaskStore.remove(taskId)`（`api/infrastructure/scheduler/TaskRunnerV2.ts:735-751`）；错过窗口同样 `store.remove(def.id)`，注释「Ordinary once tasks retain their existing missed-window deletion semantics.」（`:829-830`）。定义删除后 `GET /api/schedule/tasks/:id/runs` 回 404（`api/routes/schedule.ts:134-139`）。
- 投递：`reminder` 用 `ctx.deliver({ content, targetCatId, …, extra: { scheduler: { hiddenTrigger: true } } })`（`reminder.ts:96-123`），`content` 含完整 `message`，没有传 `privateContent`。投递层本身支持「可见一行 + 目标猫私有输入」：`DeliverOpts.privateContent`（`types.ts:120`，`delivery.ts:86-112`）。

**与需求的差距**
列表字段、UUID 幂等、一次性任务保留这三项上游都没有；正文投递的私有输入通道上游已有，但内置 `reminder` 模板不走它，带 `hiddenTrigger` 的触发消息是否原样进入模型输入我没有追到底。

**把握**：高（前三部分）；中（第四部分：没有追 `hiddenTrigger` 消息在提示词组装里的去向）。

---

<a id="n-21"></a>
## 21. 会话已读位置

**上游现状**：已有（源码），文档仍写 spec。

**依据**
- F069 `F069-thread-read-state.md`，Status 行：「`> **Status**: spec | **Owner**: 三猫`」；AC 全部未勾。`docs/ROADMAP.md:26` 也列为 spec。
- 源码已实现文档里设计的全部接口：
  - `PATCH /api/threads/:id/read`，体 `{ upToMessageId }`（`api/routes/threads.ts:2022-2027`，注释「F069: PATCH /api/threads/:id/read」）。
  - `POST /api/threads/:id/read/latest`（`:2098-2101`，注释「F069-R5 … ack to latest real message server-side」）。
  - `POST /api/threads/read/mark-all`（`:2006-2007`，F072；F072 Status「done」）。
  - `GET /api/threads` 回填 `unreadCount`、`hasUserMention`（`:1197-1211`）。
- 存储：`IThreadReadStateStore`（`api/domains/cats/services/stores/ports/ThreadReadStateStore.ts`），`ack` 单调前进，带 CAS 修复接口；实现 `RedisThreadReadStateStore`。工厂注释「无 → undefined (read state requires Redis)」（`…/factories/ReadStateStoreFactory.ts:1-14`）；无 Redis 时路由回 501。接线：`api/index.ts:1439`、`:5370`。

**与需求的差距**
没有：按用户、按会话的已读游标和未读数后端真相源已经在固定版本里（需要 Redis）。

**把握**：高（路由与存储都读到）；文档状态与源码不符，以源码为准。

---

<a id="n-22"></a>
## 22. `replyTo` 参与路由

**上游现状**：未见。

**依据**
- `POST /api/messages` 接受 `replyTo`（`api/routes/messages.schema.ts:135`），只做校验和落库（`api/routes/messages.ts:520-548`、`:670`），不进入目标解析。
- 目标解析只看：显式字段 `confirmedTargetCats ?? mentions`（`messages.ts:355`、`:375`、`:554-557`）、正文 @ 解析、会话兜底策略。路由理由枚举里没有「回复对象」：`current_message_mentions / previous_user_mentions / recent_replier / preferred_cat / default_cat / preferred_parallel / concierge_preferred / available_participant`（`shared/routing-preview.ts:6-15`）。
- `POST /api/routing/preview` 的请求体只有 `scope / threadId / content`（或 `preferredCats`），`.strict()`，不收 `replyTo`（`api/routes/routing-preview.ts:10-24`）。
- 相邻但不同的东西：F254 AC-D9 用 `replyTo` 抑制 A2A 交接的重复唤醒；云端桥用 `replyTo` 绑定回信。都不是「引用即点名」。
- 检索词（`docs/features`、`docs/decisions`、`docs/ideas`、`docs/plans`、`docs/discussions`、`feature-specs`、`feature-discussions`）：`replyTo.*路由`、`引用.*路由`、`reply.*routing`、`quote.*routing`、`回复.*唤醒`、`replyTo.*route`——没有覆盖该需求的规划。

**与需求的差距**
用户消息的 `replyTo` 不影响发给谁；上游给的是显式目标字段（`mentions`、`confirmedTargetCats`）和只读预览。

**把握**：高。

---

<a id="n-23"></a>
## 23. 带版本条件的群成员修改；重复幂等键不重写成员

**上游现状**：两部分都未见。

**依据**
- `PATCH /api/threads/:id`（`api/routes/threads.ts:1268`）：`updateThreadSchema` 无版本、无期望值字段；`preferredCats` 直接写入 `threadStore.updatePreferredCats(id, …)`（`:1345`）。存储实现是无条件覆盖（`…/redis/RedisThreadStore.ts:845-850`）。
- `POST /api/threads`（`:904`）：带 `idempotencyKey`（`:681`，UUID）时走 `threadStore.ensureOwnedThread`（`:969-977`），随后无条件执行 `updatePreferredCats(thread.id, preferredCats)`（`:992-994`），并固定回 201（`:1024`）。所以用同一个键重放会把成员重写一遍。
- 成员（猫）配置有修订号 CAS（`expectedRevision`，`api/routes/cats.ts:124`），但那是猫的配置，不是会话成员。
- 检索词：`preferredCats` 与 `cas|乐观|版本|expected|并发|concurren|if-match|幂等|idempot` 同现于上述文档目录——无结果。

**与需求的差距**
两项都没有，也没有找到规划。

**把握**：高。

---

<a id="n-24"></a>
## 24. 不依赖嵌入模型的消息检索

**上游现状**：已有（源码层）；所属特性 F324 未收口。

**依据**
- 入口 `GET /api/evidence/search?resultUnit=message`（`api/routes/evidence.ts:195-217`）。参数 `mode: lexical | semantic | hybrid`（`api/routes/message-search-handler.ts:27`），缺省 `hybrid`。
- 检索先做词法：`lexicalMessagePassages(...)`，`mode === 'lexical'` 直接返回（`api/domains/memory/message-passage-search.ts:73`）；嵌入不可用时降级为词法并在 `meta` 写明：`degradeReason = 'passage_embedding_unavailable'`、`effectiveMode = 'lexical'`（`:89-98`）；向量报错同样回落词法（`:115-128`）。
- 建索引不依赖嵌入：消息写入即标脏（`api/index.ts:1883-1893`），定时 flush；`flushDirtyThreadsOnce` 先 `indexPassages` 再做嵌入，注释「Lexical message recall must be available for the entire dirty batch…」「Vectors remain accelerators.」（`api/domains/memory/IndexBuilder.ts:1629-1634`）。
- 身份：`resolveDirectLocalAuthorizationUserId`，要求直连回环请求（`api/utils/request-identity.ts:75-88`）；否则 401。服务缺失回 503 `message_search_unavailable`。
- 文档：F324 `F324-memory-delivery-reliability.md` 状态快照「in-progress（A/B/C 原 Task 已 satisfied…」，并写「消息检索完整旅程、长尾/自然恢复及AC-D3仍未结」；合同见 `docs/architecture/f322-message-search-answer-contract.md`。F102 Status「done」、F256 Status「closed」。

**与需求的差距**
按源码，没有嵌入模型时消息检索走词法并标注降级，不应再是空结果。「推断」：返回空更可能是该会话的消息段落尚未入索引（只有写入后标脏的会话才会被 flush；历史会话需要一次重建）。这一点没有运行验证。

**把握**：中（读通了代码路径，没有实测；也没有核对旧固定版本当时为何为空）。

---

<a id="n-25"></a>
## 25. 官方的嵌入部署 / 产品以插件形态接入

**上游现状**（分三部分）

| 部分 | 现状 |
| --- | --- |
| 插件作为接入形态（消息、会话、成员、Task、私有存储、凭据） | 在做（F202，代码在） |
| 面向宿主产品的 HTTP / 事件 / UI 扩展点 | 有规划（F202 Train C2） |
| 受支持的嵌入式启动器、宿主产品配置存储、嵌入 SDK | 未见 |

**依据**
- F202 `F202-plugin-framework.md`，Status 行：「`> **Status**: in-progress (Train B direction accepted in`（后略）」。AC 末项未勾：「[ ] Complete soak, distribution prerequisites and maintainer acceptance before merge.」
- 插件能用的 Host 面：`api/domains/plugin/host-surface/`（`plugin-messaging-host.ts`、`plugin-thread-host.ts`、`plugin-members-host.ts`、`plugin-private-storage.ts`、`plugin-messaging-subscription-host.ts` 等）；管理接口 `GET /api/plugin-manager/plugins`、`POST /api/plugin-manager/plugins/install`（`api/routes/plugin-manager-read-routes.ts:36`、`api/routes/plugin-manager-routes.ts:337`）。`docs/architecture/plugin-architecture.zh-CN.md`：「插件使用普通消息、线程、成员、Task 和私有存储。」
- 明确没有事件总线与请求转发：同文「Signal schema 描述 manifest 声明元数据，不提供运行时事件总线。」「Host 不分配 browser-service 端口，也不转发插件内部请求。」
- UI 与公共 hook 属后续：F202「Train C2 — public hook/UI extensions and managed services」「Open a typed hook or UI slot only with its first real migrated consumer.」
- 部署档案 `shared/deployment-profiles.json` 只有一个档 `opensource`（品牌、端口、`promptPolicy`、`l0Projections`），由构建期投影（`shared/deployment-defaults.ts:205-219`）；这是上游自己的版本区分，不是给宿主产品的扩展点（「推断」，依据 `docs/architecture/ownership/cells/runtime-deployment.md:132`「F330 keeps edition defaults in…」）。
- F143 `F143-hostable-agent-runtime.md` Status「spec」，讲的是 Agent 运行时的宿主抽象，不是产品嵌入。F307 Status「in-progress / Phase D KEEP; default Runtime activation landed and live…」，是上游自己的工作台界面。
- 检索词：`white-label|whitelabel|白标|embedding sdk|embed sdk|嵌入式部署|headless|宿主产品|host product|downstream product|下游产品|二次开发|derivative`（文档目录）；`api-only|headless|不启动前端|仅启动 API`（`SETUP*.md`、`README.md`、`docs/setup/`）——没有面向下游产品的嵌入方案。

**与需求的差距**
上游提供的是「插件接入 Host」这一条路；宿主产品自己的 HTTP 与事件扩展点、界面嵌入要等 C2，受支持的启动器和产品配置存储没有找到。

**把握**：中（契约包 `@clowder-ai/plugin-contract` 与插件仓 `clowder-ai-plugins` 不在子模块里，Host→Plugin 的完整接口没法在本仓核对）。

---

<a id="n-26"></a>
## 26. 外部渠道

**上游现状**：渠道适配器已不在本仓，改为插件包；Host 侧在做（F202）。逐渠道：

| 渠道 | 现状 | 说明 |
| --- | --- | --- |
| 飞书 | 在做（实现在插件仓） | 原特性 F088 / F134 / F157 |
| Telegram | 在做（实现在插件仓） | F088 Phase K |
| 钉钉 | 在做（实现在插件仓） | F132 |
| 企微（bot、agent 两种） | 在做（实现在插件仓） | F132 |
| 微信个人号 | 在做（实现在插件仓） | F137；F202 记有真人验收 |
| 小艺 | 在做（实现在插件仓） | F151 |
| 微信公众号 `weixin-mp` | 在做（插件技能） | F202 AC 已勾一条 |
| Slack / Discord | 有规划（F088 明确排除） | — |
| 斜杠命令、授权跨渠道通知 | 文档 done；随适配器移出本仓 | F142、F028 |

**依据**
- 本仓没有任何渠道适配器：`api/infrastructure/connectors/` 只剩 `ConnectorThreadBindingStore.ts`、`RedisConnectorThreadBindingStore.ts`、`connector-binding-keys.ts`、`mention-parser.ts`、`media/`。`find packages -name "ConnectorRouter*" -o -name "OutboundDeliveryHook*"` 无结果；`'/api/connector…'` 路由只剩媒体路径 `/api/connector-media/`。旧固定版本 `b2c9952f`、`42017e0c` 的同一目录也是这样（只读 `git ls-tree` 核对）。
- F202：「C1 packages seven IM connectors, GitHub Operations, media tools…」；AC「[x] Current C1 provider implementations live in packages…」；「C1 migration boundary」一节：「Provider-specific IM adapters … belong to independent packages.」
- 七个连接器的名字见测试 `packages/api/test/f202-w24-candidate-consumption.test.js:58-66`：`telegram / feishu / dingtalk / wecom-agent / wecom-bot / weixin / xiaoyi`，包名前缀 `@clowder-ai/connector-`（`:26`），断言「the exact seven-package candidate must be exercised」。
- 安装来源在仓外：官方市场 `https://github.com/zts212653/clowder-ai-plugins.git`（`api/domains/plugin/manager/marketplace/git-marketplace-repository.ts:11`），目录文件在该仓 `catalog/catalog.json`（`api/domains/plugin/manager/machine-catalog-provider.ts:13`）。本仓内置目录只有 `chatgpt-dot`、`genoffice-docx`、`companion`（`api/domains/plugin/official-catalog.ts:79-116`）。
- 原特性文档 Status 行：F088「`> **Status**: in-progress | **Core Completed**: 2026-04-10`（后略）」；F132「`> **Status**: done | **Phase A-E Completed**: 2026-04-14`（后略）」；F134「`> **Status**: done | **Completed**: 2026-03-26`（后略）」；F142「`> **Status**: done | **Owner**: Ragdoll | **Priority**: P2`」；F157「`> **Status**: done | **Completed**: 2026-04-10`（后略）」；F028「`> **Status**: done | **Owner**: 三猫`」；F137、F151「done」。这些文档描述的是仓内实现，代码锚点（如 `docs/architecture/ownership/cells/transport.md` 列的 `ConnectorRouter.ts`、`OutboundDeliveryHook.ts`）在固定版本里已不存在。
- F088：「显式排除：群聊(Phase 7)、多用户(Phase 7)、Slack/Discord(Phase 8)…」。

**与需求的差距**
要用任何外部渠道，都得经 Plugin Manager 安装仓外的连接器包；这些包的内容、版本和是否已发布，在子模块里无法核对。

**把握**：中（本仓的事实把握高；各连接器包的实际状态看不到）。

---

<a id="n-27"></a>
## 27. 手机端、推送、语音、跨设备

**上游现状**（分部分）

| 部分 | 现状 |
| --- | --- |
| 手机端（PWA） | 已有（上游自己的 Web 前端） |
| 推送（Web Push） | 已有 |
| 语音合成、语音消息、语音模式 | 已有 |
| 语音输入 | 已有（上游前端 + 本机 ASR 服务） |
| 实时语音陪伴 | 在做（F317） |
| Apple 生态原生语音 | 有规划（F124 spec） |
| 跨设备 / 多设备接入 | 有规划（F077 AC11） |
| 猫在另一台机器上运行 | 有规划（F334 spec） |

**依据**
- 手机端：F010 `F010-mobile-cat.md`，Status 行「`> **Status**: done | **Owner**: 三猫`」；「决策：PWA 先行」；`packages/web/public/manifest.json` 存在。PWA 属于上游 Web 前端，不是 API 能力。
- 推送：`GET /api/push/vapid-public-key`、`GET /api/push/status`、`POST /api/push/generate-vapid`、`POST /api/push/subscribe`、`DELETE /api/push/subscribe`、`POST /api/push/test`（`api/routes/push.ts:74、84、118、147、191、218`）；服务 `api/domains/cats/services/push/PushNotificationService.ts`（Web Push，「向co-creator的所有设备推送通知」）；队列处理器按 `decision-notification-policy` 触发（`…/invocation/QueueProcessor.ts:65-66`）。归属 F010 路线里的「C 推送」。
- 语音：`GET /api/tts/voices`、`POST /api/tts/synthesize`、`POST /api/tts/stream`、`POST /api/tts/listen/stream`、`GET /api/tts/audio/:filename`（`api/routes/tts.ts:244、263、459、404、582`）；会话级 `voiceMode`（`PATCH /api/threads/:id`，`api/routes/threads.ts:853、1349`）；提示词段 `assets/prompt-templates/d15-voice-on.md`「默认用 audio rich block」。相关文档 Status：F034、F066、F092、F103、F111、F112 均「done」。
- 语音输入：F020 Status「done」，「麦克风录音 → 本地 Whisper ASR → 术语纠错 → 填入 textarea」；API 里没有 `/api/stt|asr|voice` 路由（grep 无），本仓只有 `api/infrastructure/connectors/media/WhisperSttProvider.ts`。「推断」：浏览器直接调本机 ASR 服务。
- 实时陪伴：`GET|POST /api/threads/:threadId/realtime-companion/{status,start,stop}`（`api/routes/native-realtime-companion-routes.ts:64、73、219`）；F317 Status「`> **Status**: in-progress`（后略）」。
- F124 Status 行「`> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1`」。
- 跨设备：F077（spec）AC11「多设备接入 — 同一用户从手机/平板/另一台电脑通过 Tailscale 访问 Hub」未勾。F334 Status「spec」，文档自述「This is a design specification, not an implemented multi-machine setup」。
- 检索词：`跨设备|多设备|cross-device|multi-device`（文档目录）；tsv 标题里的 `push|推送|voice|语音|tts|asr|mobile|手机|device|设备|remote|远程|tailscale|pwa|ios|apple`。

**与需求的差距**
推送和语音合成的接口都在；手机端与语音输入的现成实现在上游自己的前端里，不是可直接复用的 API；跨设备只有规格。

**把握**：高（路由与文档）；语音输入一项为中（没有追前端到 ASR 的调用）。

---

<a id="n-28"></a>
## 28. 富内容块的种类

**上游现状**：已有，共 8 种。

**依据**
- `shared/types/rich.ts:12-20`，`RichBlockKind` 全表：

| kind | 类型 | 行 | 出处注释 |
| --- | --- | --- | --- |
| `card` | `RichCardBlock` | 43-58 | 可带 `actions`、不透明 `meta` |
| `diff` | `RichDiffBlock` | 73 | — |
| `checklist` | `RichChecklistBlock` | 81 | — |
| `media_gallery` | `RichMediaGalleryBlock` | 87-91 | — |
| `audio` | `RichAudioBlock` | 96-109 | 「F34: Audio block for TTS playback or audio content.」 |
| `interactive` | `RichInteractiveBlock` | 139-155 | `select / multi-select / card-grid / confirm` |
| `file` | `RichFileBlock` | 158-169 | 「F088 Phase J: File attachment block」 |
| `html_widget` | `RichHtmlWidgetBlock` | 172-180 | 「rendered in sandboxed iframe (srcdoc)」 |

- 存放：`StoredMessage.extra.rich = { v: 1, blocks }`（`:196-199`）。
- `card` 靠 `meta.kind` 分出专用卡，源码里出现的有：`person_memory_proposal`（`rich.ts:59-67`）、`runtime_interaction`（`api/domains/runtime-interaction/RuntimeInteractionCardPublisher.ts:118-131`）、`memory_group`（`api/routes/callback-remember-routes.ts:86-90`）、`callback_auth_failure`、`generated_media_publication`、`work_reference`、`frustration_auto_issue`（grep `meta?.kind ===`）。定时审批、画像、品味等审批卡也走卡片块（`api/routes/*-card-block.ts`）。
- 猫侧参考 `cat-cafe-skills/refs/rich-blocks.md` 多列一个输入用的 `sources`（「随回答引用选好的原话，让主人点回出处」），它是 `create_rich_block` 的输入种类（`mcp/tools/source-reply.ts:40`），不在 `RichBlockKind` 里。同一文件写明 `file` 块「`video/*` 文件会内联播放」。

**与需求的差距**
没有：种类清单如上；哪些 Bot 还画不了由 Bot 侧对照。

**把握**：高。

---

<a id="n-29"></a>
## 29. 「等我」统一清单与对话里的提问

**上游现状**（分部分）

| 部分 | 现状 |
| --- | --- |
| (a) 审批类待办的跨会话清单 | 已有（F246 在做，Phase A–H done） |
| (a) 委托工作里等主人的项 | 已有（F310，公开文档无状态行） |
| (a) 合并清单（审批 + 等主人 + 被 @ + 修复） | 在做（F317；只读链已合入） |
| (b) 在上游界面之外回答运行时提问 | 已有 HTTP 接口（F306 在做，Phase B AC-B1 已勾） |
| (b) 猫用 MCP 工具向主人提问 | 已退役（回 410） |

**依据**
- `GET /api/approval-hub/pending`（`api/routes/approval-hub-routes.ts:127-151`）：对所有登记的生产者扇出，返回 `items / count / manifest / coverage`。历史：`GET /api/approval-hub/settled`、`/settled/page`（`:155、108`）。F246 Status 行「`> **Status**: in-progress（Phase A–H done；Phase I Wave 0–2 已落地`（后略）」。
- `GET /api/entrusted-work/needs-me`（`api/routes/entrusted-work-read-routes.ts:80-87`）→ `readNeedsMeForOwner`（`api/domains/growing/EntrustedWorkOwnerReadService.ts:190`）。生产者目录四个：`f246.approval / f306.runtime_interaction / f309.content_review / f290.collective_work_result`（`api/index.ts:6724-6732`）。F310 的公开文档只是 `doc_kind: mcp-evidence` 的准入证据，没有 Status 行。
- 合并清单：`GET /api/concierge/work/decisions?view=unified[&includeUserMentions=true]`（`api/routes/companion-decision-routes.ts:38-60`），类型 `UnifiedAttentionItemV1`，`kind: 'approval' | 'judgment' | 'repair' | 'user_mention'`（`shared/types/unified-attention.ts:205-207`）。访问限制：`requirePluginOwnerLocalAccess`（直连本机 + 主人会话，`api/routes/plugin-access-guards.ts:46-74`），且操作者必须是 Host 主人。猫侧只读对应 `GET /api/callbacks/companion/decisions`（`api/routes/companion-work-read.ts:110`）。F317 Status「`> **Status**: in-progress`（后略）」；文档：「完整只读链已由独立 #4829 合入 main」「先可查不等于完整U3交付」。
- 运行时提问：`GET /api/runtime-interactions/:interactionId`、`POST …/respond`、`POST …/reject`（`api/routes/runtime-interaction-routes.ts:37、56、83`）。身份用 `resolveStrictUserId`（会话 Cookie，或无 `Origin` 时的 `X-Cat-Cafe-User`，`api/utils/request-identity.ts:129-139`）；回答必须带 `cardRef { threadId, messageId, blockId }`（`:14-25`）。提问以卡片块发在对话里，`meta: { kind: 'runtime_interaction', interactionId, interactionKind }`（`RuntimeInteractionCardPublisher.ts:118-131`）。没有「列出全部待答提问」的独立路由，待答项经上面的清单露出（`F306NeedsMeProducerAdapter`）。
- F306 `F306-codex-app-capability-parity.md` Status 行「`> **Status**: in-progress | **Owner**: 小太阳·Maine Coon`（后略）」；「[x] AC-B1: 至少 Codex approval、request-user-input 与 elicitation 三类 fixtures…」。
- MCP 工具 `cat_cafe_request_user_input` 已退役：文档「不再发布问题、请求 callback、建立 waiter 或返回用户答案」，旧 `POST /api/callbacks/request-user-input` 「一律立即返回 HTTP 410」（路由在 `api/routes/callback-runtime-interaction-routes.ts:85`）。
- F278 Status「`> **Status**: done — canonical ledger/disposition loop retained`（后略）」，是「爪感差」责任收件箱，不是主人的待办清单。

**与需求的差距**
(a) 三个清单接口都在，但合并清单只对直连本机的主人会话开放，且所属特性未验收；(b) 回答接口在，需要从对话里的卡片取 `cardRef`，没有单独的待答列表。

**把握**：高（路由）；中（合并清单的覆盖范围与稳定性，特性在做）。

---

<a id="n-30"></a>
## 30. 记忆的写操作

**上游现状**：主人直接操作的写路由全部在源码里；所属特性未收口（F321 AC-A3 未勾，F332 在做）。逐项：

| 对象 | 操作 | 路由 | 现状 |
| --- | --- | --- | --- |
| 画像 Profile | `replace_content`、`hard_forget` | `POST /api/memory/profile/:memoryId/actions`（`api/routes/profile-memory-owner.ts:114-131`） | 在做，代码在 |
| 品味 Taste | `confirm_takeaway`、`correct`、`retire`、`hard_forget` | `POST /api/memory/taste/:memoryId/actions`（`api/routes/taste-browse.ts:88`） | 在做，代码在 |
| 人物 | `correct_claim`、`retire_claim`、`amend_event`、`hard_forget_person` 等 | `POST /api/memory/people/:personId/actions`（`api/routes/person-memory-owner-read.ts:233`） | 在做，代码在 |
| 人物（暂存项） | — | `POST /api/memory/people/deferred/:receiptId/actions`（`api/routes/person-memory-owner-deferred.ts:75`） | 在做，代码在 |
| 人物提案 | 彻底遗忘 | `GET|POST /api/person-memory-proposals/:proposalId/forget`（`api/routes/person-memory-proposal-forget-routes.ts:21-33`） | 在做，代码在 |
| 事件 | `correct`、`retire`、`hard_forget` | `POST /api/memory/events/:eventId/actions`（`api/routes/events.ts:298`） | 在做，代码在 |
| 实体 | `correct`、`retire`、`hard_forget` | `POST /api/memory/entities/:entityId/actions`（`api/routes/entity-memory-owner.ts:54-55`） | 在做，代码在 |
| 事件更正提案 | 批准 / 拒绝 | `POST /api/event-memory-corrections/:proposalId/{approve,reject}`（`api/routes/event-memory-correction-decision-routes.ts:33、41`） | 已有 |
| 画像更新提案 | 批准 / 拒绝 | `POST /api/profile-updates/:proposalId/{approve,reject}`（`api/routes/profile-update-decision-routes.ts:115、164`） | 已有 |
| 品味提案 | 预览 / 批准 / 拒绝 | `GET …/decision-preview`、`POST /api/taste-proposals/:id/{approve,reject}`（`api/routes/taste-proposal-decision-routes.ts:69、86、121`） | 已有 |
| 人物记忆提案 | 批准 / 撤销 / 暂不 / 拒绝 / 撤回 | `POST /api/person-memory-proposals/:proposalId/{approve,undo,not-now,reject,withdraw}`（`api/routes/person-memory-decision-routes.ts:126-263`） | 已有 |

**依据**
- 动作的类型定义：`shared/types/memory-owner-lifecycle.ts`——画像 `:36-46`，品味 `:96-116`，实体 `:129-141`，事件 `:164-174`；公共字段 `requestId`、`expectedRevision`（`:16-19`），`hard_forget` 要 `confirmed: true`（`:21-27`）。人物动作在 `api/routes/person-memory-owner-read.ts:60-93`。
- 调用条件（所有 `…/actions` 与 forget 路由）：`authorizeOwnerBrowserAction`（`api/routes/owner-memory-browser-auth.ts:19-29`）——必须是浏览器会话（`sessionUserId` + `sessionCsrfToken` + `sessionBindingId`）、`Origin`/`Referer` 属于允许的前端来源、带匹配的 `x-csrf-token`；请求里出现 `x-cat-cafe-user`、`authorization`、`x-invocation-id`、`x-callback-token`、`x-agent-key-secret` 任一头即拒绝（`:6-12`）。不满足回 403 `invalid_action`。
- 提案批准类路由用 `resolveStrictUserId`（画像、人物、实体）；品味和事件更正在需要时同样要求浏览器动作（`taste-proposal-decision-routes.ts:165-170`，`event-memory-correction-decision-routes.ts:140-144`）。
- 文档 Status 行：F221、F227、F231、F276、F321 都是「`closed (consolidated into F332; 未完成结果继续承接，非全部交付)`」；F163「done」；F332「`> **Status**: in-progress（第1步画像次数、文案和更正读取路径已完成独审`（后略）」。
- F321 AC-A3 未勾：「[ ] AC-A3: 在浏览页修改或遗忘一条，走原车道的更正/遗忘路径」；进展注记「品味、人物、事件在原车道编辑、停用、忘掉 … 已在 PR1 合后 Alpha 非作者验收」，还差「摘要、索引与检索中的旧内容随之失效」。AC-A5 未勾：人物的待审批纠正「尚未开工」。

**与需求的差距**
需求点到的每个写操作在固定版本里都有路由；它们只接受上游前端来源的浏览器会话（Cookie + CSRF），并且写完之后旧摘要、索引的失效还没有做完。

**把握**：高（路由与鉴权逐个读过）；中（「是否做完」——文档未勾，代码已在）。

---

<a id="n-31"></a>
## 31. 上游已有、Bot 未用的四项

**上游现状**

| 项 | 现状 |
| --- | --- |
| 事项记忆 Matter | 在做（F332），代码在 |
| 会话缓存冷热 F338 | 在做：冷热信号（PR1）已有；延长保留（PR2）未做 |
| 账号与额度 F320 | 在做，代码在；AC 全部未勾 |
| 主人昵称 | 已有 |

**依据**
- Matter：主人侧 `POST /api/memory/matters/source`、`GET /api/memory/matters`、`GET /api/memory/matters/:matterId`、`GET …/:matterId/write-receipt`、`POST /api/memory/matters/write`（`api/routes/memory-matter-routes.ts:118、136、146、156、170`）；猫侧 `GET /api/callbacks/memory-matters`、`GET …/:matterId`、`POST …/write`（`:56、69、84`）。读要会话身份（`resolveSessionUserId`，`:110-116`），写另要浏览器动作（`:171`）。合同 `docs/architecture/f332-matter-memory-contract.md`（标题「F332 2c matter memory contract」，MCP 准入 `accepted`）。F332 Status 在做。
- F338 `F338-session-cache-warmth.md`，Status 行「`> **Status**: in-progress | **Owner**: 小太阳·Maine Coon`（后略）」。AC-A1、A2、A3、A5 已勾，A4、A6、A7、A8 未勾；文档：「PR1 仅增加派活会话观测，尚未交付主人可开启的续约功能」。代码：`api/domains/cats/services/session/cache/`（`session-cache-warmth.ts`、`SessionCacheReadService.ts`、`session-cache-runtime.ts`）；读接口把 `cacheWarmth` 挂在会话记录上（`api/routes/session-chain.ts:193-221`），对应 `GET /api/threads/:threadId/sessions`（`:359`）与 `GET /api/sessions/:sessionId`（`:455`）。类型 `SessionCacheWarmth`（`shared/types/session-cache.ts:44`）。
- F320 `F320-multi-oauth-account-switching.md`，Status 行「`> **Status**: in-progress | **Owner**: Ragdoll (@opus55, claude-opus-5-5)`（后略）」；AC-A1…A10、B1…B5、C1 全部「[ ]」。代码：`GET|POST /api/accounts`、`PATCH|DELETE /api/accounts/:profileId`（`api/routes/accounts.ts:87、136、219、356`）；`POST /api/accounts/:profileId/{codex,claude,agy,kimi}/quota`；`GET /api/accounts/${tool}/members`、`POST /api/accounts/:profileId/${tool}/binding/${action}`（`api/routes/accounts-codex-binding.ts:35、48`）；`POST /api/accounts/:profileId/codex/login/${action}`（`api/routes/accounts-codex-login.ts:21`）。额度汇总 `GET /api/quota`、`GET /api/quota/summary`（`api/routes/quota.ts:1705、1718`）。
- 主人昵称：`PATCH /api/config/co-creator`（`api/routes/config.ts:352`），可改 `name / nickname / aliases / mentionPatterns / timeZone / avatar / color`（`:318-326`），身份取 `X-Cat-Cafe-User` 头；旧路径 `PATCH /api/config/owner` 标记弃用（`:354-356`）。没有找到专门的特性文档；相关提及在 F127、F136。

**与需求的差距**
四项都存在。F338 目前只有「看得到冷热」；F320 的接口在但验收一条未过。

**把握**：高（存在性）；中（F320、Matter 的完成度，以文档未勾为准）。

---

<a id="n-32"></a>
## 32. 改提醒的内容与参数

**上游现状**：已有。

**依据**
- `POST /api/schedule/tasks/:id/parameters`（`api/routes/schedule-task-parameter-routes.ts:20`）。请求体只收 `paramsPatch` 与 `sourceThreadId`（`:40-42`，「Only paramsPatch and sourceThreadId are accepted」）。
- 主人会话：直接生效，回 `{ success, proposed: false, taskId, changed }`（`:81-91`）；猫：生成审批提案，回 202（`:61-80`）。写入带指纹比对，定义变了回 409 `SCHEDULE_TASK_DRIFT`。
- 限制（`api/routes/schedule-parameter-update-support.ts:5-48`）：只能改周期任务——「Parameter updates require an existing recurring task」；只能改模板 `paramSchema` 里声明的键；不能改 id 与触发时间——「Parameter updates cannot change task identity or trigger」；`display` 保持原值（`spec.display = task.display`）。F255 托管任务回 409。
- 猫侧工具 `cat_cafe_update_scheduled_task_params`（`mcp/tools/schedule-parameter-tools.ts:69`）。
- F139 Status「done」；文档「Updating recurring task parameters」一节：「Approval preserves the ID and progress」。治理归 F246 Phase I（F246 Status 在做）。

**与需求的差距**
提醒的正文（`message`）和目标猫可以原地改；一次性提醒不能改，触发时间不能改，列表上的 `display` 文案不随之更新。

**把握**：高。

---

<a id="n-33"></a>
## 33. 更多本机 Agent 运行时

**上游现状**（分部分）

| 运行时 | 探测（`/api/cats/native-runtimes`） | 载体 | 现状 |
| --- | --- | --- | --- |
| Codex | `codex`（`app_server`） | `CodexAgentService`（`app_server` / `exec_json`） | 已有 |
| Claude Code | `claude`（`stream_json`） | `ClaudeAgentService`、`ClaudeSdkAgentService`（`carrier: sdk`） | 已有（F318 done） |
| DSH | `dsh`（DSH Desktop）、`acp:<catId>` | 通用 ACP | 已有 |
| AGY / Google | `agy-native`、`agy-acp` | `AgyNativeAgentService`；ACP | 在做（F325） |
| Gemini CLI | 不探测 | 已退役 | — |
| Antigravity IDE | 不探测 | 已退役（`AGY_IDE_EXECUTION_RETIRED`） | — |
| Kimi | `kimi` | `KimiAgentService` | 已有（F158 done） |
| Pi | `pi` | Pi ACP 桥 | 已有（无专门特性文档） |
| OpenCode | 不探测 | `OpenCodeAgentService` | 已有载体（F105 done） |
| 任意 ACP Agent | `acp:<catId>`（已登记的 ACP 配置） | `AcpAgentService` | 已有（F161 implemented） |
| A2A 远端 Agent | 不探测 | `A2AAgentService` | 已有（F050 done） |
| Cursor | 不探测 | 无 | 未见 |

**依据**
- 探测：`GET /api/cats/native-runtimes[?refresh=1]`（`api/routes/cats.ts:1002-1008`）→ `discoverNativeRuntimesWithReadiness`（`api/routes/native-runtimes.ts:151-160`）。内容拼自：内置 `codex`、`claude`（`:47-73`）；已登记 ACP 配置的猫 `acp:<catId>`，标签「AGY 官方 ACP」/「DSH」/显示名（`:74-116`）；`discoverDshRuntimes()`（`api/routes/native-dsh-discovery.ts:10-30`，标签「DSH Desktop」）；`agy-native`、`agy-acp`（`:121-143`）；`kimi` 与 `pi`（`api/routes/native-additional-runtimes.ts:7-41`）。注释：「Discovery is read-only. No auth files, full agent launches, prompts or login probes.」
- 载体分派：`api/index.ts:2305-2400`。`carrier === 'acp'` 走通用 ACP；否则按 `clientId`：`anthropic / openai / google / kimi / antigravity / opencode / catagent / a2a`。`ClientId` 全集见 `shared/types/cat.ts:16-26`（另有 `pi`、`acp`）。
- 退役文案：`antigravity` →「AGY IDE 执行入口已退役。」（`index.ts:2377-2383`）；`google` 未配 AGY Native →「旧 Gemini CLI / AGY 执行入口已退役。」（`…/agy-native/agy-native-carrier-selection.ts:7-16`）。
- 文档 Status 行：F161「`> **Status**: implemented (Phase A+B, intake from clowder-ai#899)`（后略）」；F050「done」；F105「done」；F158「done」；F318「done（operator 确认 A2A 整合后的当前接入完成…」；F325「in-progress」；F210「frozen (superseded-by F325; not completed)」；F143「spec」。
- DSH 没有专门的特性文档：`docs/features` 里只有 F299、F333 提到；运维说明 `docs/ops/dsh-custom-llm-acp.md`。
- 探测文件里没有 OpenCode、A2A、catagent：`grep -i "opencode|a2a|catagent"` 于 `api/routes/native-runtimes.ts`、`native-additional-runtimes.ts`、`native-pi-discovery.ts`、`native-dsh-discovery.ts` 无结果。
- 检索词：`cursor`（`api/routes/native*.ts` 与 `…/providers/`，只有无关命中）；tsv 标题 `dsh|deepseek|kimi|pi|opencode|acp|agy|antigravity|gemini|cursor|carrier`。

**与需求的差距**
探测接口不报告 OpenCode、A2A、catagent；Cursor 没有任何接入；Gemini CLI 与 Antigravity IDE 两个旧入口已退役。

**把握**：高。

---

<a id="n-34"></a>
## 34. 队列接口读取失败时仍回成功；删除猫不结束进行中的一轮

**上游现状**：两部分都未见修复或规划；前者是上游有意的设计。

**依据**
- 队列：`GET /api/threads/:threadId/queue`（`api/routes/queue.ts:1353-1403`）。执行进程快照读失败时返回空并继续：日志「CLI execution owner snapshot unavailable; active execution scan will fail open」（`:180-192`）。活动执行的解析用 `resolveActiveInvocations`，其注释：「GET /queue 的 fail-open 包装：helper 失败降级成 tracker-only，端点永不因 liveness 查询 500。」并自述后果：「降级把"读失败"伪装成"这些就是全部"」（`api/domains/cats/services/agents/invocation/live-invocation-projection.ts:310-347`）。响应体 `{ queue, queueRevision, activeInvocations }` 没有降级标记。侧栏走另一条严格路径 `resolveActiveInvocationsStrict`（同注释）。归属 F194，Status「`> **Status**: done | **Completed**: 2026-05-12`（后略）」。
- 删除猫：`DELETE /api/cats/:id`（`api/routes/cats.ts:1905-1965`）。步骤：校验 `expectedRevision` → 删运行时覆盖与成员 → `cleanupBlockedMcpForAllProjects` → `reconcileCatRegistry` → 发 `cat-config` 变更事件。处理函数里没有取消执行或清队列；`cat-config` 的订阅者 `api/config/cat-catalog-subscriber.ts`（66 行）也没有 `cancel|abort|invocation|unregister|dispose|retire`。
- 检索词（文档目录）：`删除.*成员.*进行中`、`删除猫.*取消`、`delete.*cat.*cancel`、`deleted cat.*invocation`、`in-flight.*delet`——无结果。源码：`cat_deleted|catDeleted|member_deleted|onCatRemoved|removedCatIds`——只有配置加载器里的局部变量。

**与需求的差距**
队列接口的「读失败也回 200、且不标注」是上游写明的取舍，没有改动计划；删除猫时结束其进行中的一轮，上游没有做也没有规划。

**把握**：高。

---

<a id="n-35"></a>
## 35. 引擎的拒绝 / 错误行不带来源

**上游现状**：未见。

**依据**
- 成员不可用、执行出错时，引擎落一条系统消息：`from: { kind: 'system', service: 'agent-error' }`、`userId: 'system'`、`content: \`Error: ${…}\``，字段只有 `mentions: []`、`origin: 'stream'`、`timestamp`、`threadId`，可选 `metadata.cliDiagnostics`。三处：`api/domains/cats/services/agents/routing/route-serial.ts:1039-1047`（成员不可用）、`:3791-3804`、`route-parallel.ts:2525-2532`。都没有 `replyTo`，没有 `extra.causal`，也没有 `catId`。
- 对照：猫自己的回复带因果引用——`extra.causal = { kind: 'invocation_reply', triggerMessageId }`（类型见 `…/stores/ports/MessageStore.ts:450`；写入处 `route-serial.ts:3191、3505、3666`），「出错但有工具记录」的那条以猫的身份落库，在有 `streamReplyTo`（A2A 或排队触发）时带 `replyTo`（`:3636-3650`）。只有系统错误行什么引用都没有。
- 可见通知的另一类 `system-info-warning` 只在云端桥回执里带 `replyTo: outboundReceipt.sourceMessageId`（`…/routing/persist-system-info-warnings.ts:171-181`）。
- 文档里没有找到给错误行补来源的计划（未单独检索；F194、F117 文档未提）。

**与需求的差距**
错误 / 拒绝行不指向触发它的那条用户消息，正文是原始错误文本。

**把握**：高（源码）；低（「没有规划」——文档只做了相邻特性的翻查）。

---

<a id="n-36"></a>
## 36. 多用户 / 会话 ACL

**上游现状**：有规划（F077 spec）；源码只有「按创建者」的可见性判定。

**依据**
- F077 `F077-multi-user-secure-collab.md`，Status 行「`> **Status**: spec | **Owner**: Ragdoll`」；文档头 `tips_exempt`：「…with no runtime implementation」；AC1–AC11 全部未勾。设计内容：GitHub OAuth、Redis 会话、`ownerUserId` + `access: private|shared` + `memberUserIds[]`。
- 源码现状：`resolveThreadAccess`（`api/domains/cats/services/session/thread-access-policy.ts:58-100`）只认 `thread.createdBy === userId`、系统默认会话、外部运行时锚点、用户索引里可见的系统会话；`Thread` 上没有 `memberUserIds` / `access` 字段（grep `memberUserIds|sharedWith` 于 `ThreadStore.ts`：无）。
- 会话认证是内存里的浏览器会话 Cookie（`api/infrastructure/session-auth.ts`，`SessionStore` 为 `Map`）；没有 `/api/auth/*`、OAuth 回调路由（grep 无）。
- 相关但不同：F290「AI-native collective」讲多个独立 Café 之间协同，Status「`> **Status**: in-progress / 2026-10-19：`（后略）」，不是同一个 Hub 内的多用户。

**与需求的差距**
同一实例内的多用户登录、成员制会话 ACL 都还只是规格。

**把握**：高。

---

<a id="n-37"></a>
## 37. 群聊的主持与 `@all` 的语义

**上游现状**（分部分）

| 部分 | 现状 |
| --- | --- |
| `@all` / `@全体` = 全部可路由的猫 | 已有（就是这个语义） |
| 只点本会话成员的群组提及 | 已有：`@thread` / `@本帖` / `@全体参与者` |
| 按品种点名 | 已有：`@全体{品种名}` / `@all-{breedId}` |
| 「主持猫」概念 | 未见 |
| 猫发消息的结构化目标 `targetCats` | 已有（F055 文档仍写 spec） |

**依据**
- F078 `F078-smart-routing-group-mentions.md`，Status 行「`> **Status**: done | **Owner**: Ragdoll`」；「**@all / @全体** -- Route to all available cats.」；`@thread / @本帖 / @全体参与者`：「Route to all current thread participants.」；AC-A3、A7 已勾。
- 源码 `api/domains/cats/services/agents/routing/AgentRouter.ts`：`@全体`、`@all` 解析为 `this.filterRoutableCats(Object.keys(this.services))`（`:1172-1192`）；会话范围的三个词解析为 `this.threadStore.getParticipants(threadId)`（`:1148-1162`），没有参与者时回落到兜底猫。参与者集合是 Redis 里的 participants 集合（`…/redis/RedisThreadStore.ts:651-654`），由显式点名等途径加入，和 `preferredCats` 不是同一个字段。
- 主持：没有会话级主持字段。`leadCat` 只在新手训练营状态里（`…/stores/ports/ThreadStore.ts:441`）。会话路由策略 `ThreadRoutingPolicyV1 = { v: 1, scopes? }`（`:89-92`），对应提示词段 `assets/prompt-templates/d13-routing-policy.md`；`l3-routing-rules.md` 是猫的传球规则，不涉及主持。检索词（源码与文档）：`主持猫|主持人|moderator|facilitator|host cat|群主|thread lead|leadCat|hostCat`——文档只在 F044、F107 有无关命中。
- F055 `F055-a2a-mcp-structured-routing.md`，Status 行「`> **Status**: spec | **Owner**: Ragdoll (Opus 4.6)`」，AC-1…AC-7 未勾；但 `post_message` 回调已收 `targetCats`（`api/routes/callbacks.ts:1053`，校验文案见 `:488-489`），MCP 工具同（`mcp/tools/callback-tools.ts:413、894`）。

**与需求的差距**
`@all` 的范围是整个实例的猫，这是上游定义；只点会话成员的写法上游另有三个词，但它按「参与者」而不是 `preferredCats` 展开。主持概念没有。

**把握**：高。

---

<a id="n-38"></a>
## 38. 引擎自发消息的开关

**上游现状**：四类消息都没有开关；其中一类上游明确写了不做。

| 消息 | 来源 | 开关 |
| --- | --- | --- |
| 重启后自动接续 | F048 Phase C（done） | 未见 |
| 合盖睡眠后自动接续 | F337（在做） | 未见，文档明确不加 |
| 掉球检查 | `owner-ask-check` | 未见 |
| 记忆提交汇总卡 | F332，`cat_cafe_remember` | 未见 |

**依据**
- F048 `F048-restart-recovery.md`，Status 行「`> **Status**: done | **Completed**: 2026-11-13`（后略）」；AC-C1…C7 全勾。实现 `api/domains/cats/services/agents/invocation/restart-continuation/RestartContinuation.ts`（连接器名 `restart-recovery`，标签「重启接续」「睡眠接续」），启动时无条件调用（`api/index.ts:8075-8082`）。不叫回的情形写在代码与 AC-C3、C4 里（主动停止、进程仍活、守望猫、已有排队项、连续两次被打断），都不是配置项。文档「明确不做」一段没有提到开关。
- F337 `F337-stop-reason-awareness.md`，Status 行「`> **Status**: in-progress | **Owner**: Ragdoll (@opus55)`（后略）」；AC-A1…A4 已勾，A5 未勾。Non-goals：「不加审批、确认弹窗或二次确认；不加设置开关或环境变量。」
- 掉球检查：`api/domains/cats/services/agents/routing/owner-ask-correction.ts:89-118`（标签「掉球检查」，连接器 `owner-ask-check`）；触发处 `route-serial.ts:3300-3304`；投递函数无条件接线 `ownerAskCorrectionDeliver: schedulerDeliver`（`api/index.ts:3015`）。跳过条件只有两个，写死在代码里：本轮本身是纠正轮；主人十分钟内在该会话说过话（`OWNER_PRESENT_WINDOW_MS`，`:23`）。`docs/features` 里检索 `owner-ask-check|掉球检查`：无。
- 记忆提交汇总：`api/routes/callback-remember-routes.ts:62-90`，只要有可见项就追加一条消息「这次提交的 N 项记忆」并带 `memory_group` 卡；只排除 `REMEMBER_QUIET_TARGETS` 里的目标。
- 环境变量登记表 `api/config/env-registry-data/*.ts` 共 247 个名字，按 `RECOVER|RESTART|CONTINUE|RESUME|BALL|SLEEP|WAKE|CURATION|NUDGE|PROACTIVE|AUTO|DREAM|BRIEF|COMMIT|SUMMARY|A2A|HEARTBEAT|GREET|WELCOME` 过滤，只得到 `MAX_A2A_DEPTH`、`CAT_CAFE_F255_AWAKENED_LEASE_MS`、`F233_BALL_CUSTODY_PROBE_INTERVAL_MS`、`SUMMARY_TTL_SECONDS`，都不是这些消息的开关。
- 上游确有、但管别的事的开关：记忆整理 `GET|PUT /api/config/memory-curation`，体 `{ enabled }`（`api/routes/memory-curation.ts:39-50`）；定时总闸 `PATCH /api/schedule/control`（`api/routes/schedule-governance.ts:49`）。

**与需求的差距**
这四类消息在固定版本里都不能由部署方或用户关闭；睡眠接续一项上游已写明不提供开关。

**把握**：高。

