# 上游维护、差异与回退

## 当前纪律（2026-11-05）

本项目基于 Clowder AI；已有底层机制直接复用，Bot 只通过原生支持的接口、事件和配置进行适配与呈现。记忆、上下文、路由、任务、交接、调度、权限等机制需要改变时，必须先由 Clowder AI 实现，再通过固定版本升级获得。具体约束以根目录 [AGENTS.md](../AGENTS.md) 为准，[CLAUDE.md](../CLAUDE.md) 引用同一规则。

允许通过更上层重新适配：把多个已有原生操作组合成一个用户动作、采用合法默认值、转换请求或聚合原生记录，而不要求界面逐项照搬原生概念。判断一项需求需要上游修改之前，应先核查这一条路径；组合仍须保留各操作的权限、生命周期和失败语义，不新增独立执行引擎或权威数据源。

产品默认按聊天软件组织：用户选猫猫或群聊、说需求、发资料、收成果，无须理解模型、上下文、会话链或工作区。必要接入尽量简短，技术配置与诊断按需展开；简化呈现仍需保留真实状态、失败反馈和必要授权。详细规则见 AGENTS.md 的 Chat-first usability。

外置补丁同样会改变运行时，不能作为绕过上述纪律的方式。下文补丁台账和历次验收保留为历史事实；其中本地补丁提供的能力不等于未修改上游已有的能力，也不授权新增或扩大补丁。已有差异需要逐项审计、记录上游替代路径，并通过保留数据的验证迁移退出；本次规则更新不直接拆除现有功能。

## 固定来源与构建

`upstream.lock.json` 是提交、Node、pnpm 与补丁列表的唯一版本约束。Git 子模块保留完整原始文件和许可，不能直接修改。`runtime:prepare` 检查 SHA 与工作区洁净度，再生成锁文件指定的 `.runtime/` 独立 Git HEAD，逐个 `git apply --check`，按上游 frozen lockfile 构建 API 依赖闭包。Bot 不 fork 核心 npm 包，也不通过复制精选函数实现第二套内核。

启动器同时持有数据目录锁与构建目录锁，阻止同一构建被其他配置并发使用或重建；准备脚本会加载 `.env` 中的自定义数据路径。构建来源摘要包含锁文件和全部补丁字节；编译成功后才写完成标记。`runtime:start` 拒绝不完整或过期构建。`verify:upstream` 检查子模块、生成目录的 HEAD、补丁逐字节结果及未记录的源码改动。不要在生成目录修业务代码。

## 差异台账

| 编号 | 改动位置 | 原因/影响 | 退出条件 |
| --- | --- | --- | --- |
| P001 | `patches/0001-thread-participant-policy.patch` | 原生 preferredCats 只是路由偏好。Bot 群聊需要显式执行成员。给 invokeSingleCat 入口加默认关闭的检查；Bot 开启后名单缺失/读取失败/非成员均拒绝，provider/session 尚未启动。新增 helper，加一处原生入口检查，共 2 文件。 | 上游提供覆盖直接、排队、A2A 的正式成员准入扩展点后，迁到该接口并删除补丁。 |
| P002 | `patches/0002-background-delegation-policy.patch` | 原生 L0 编译后追加部署级后台委派约束，覆盖缓存命中和文件输出；默认关闭，Bot 开启。主会话接待、长任务由原生后台子代理执行，不创建新协调 Agent。共 2 文件。 | 上游正式支持部署级主会话指令扩展后迁移。 |
| P003 | `patches/0003-background-output-checkpoint.patch` | Claude SDK 每轮 result 发出类型化输出检查点，route-serial 刷新尾部草稿，不发 done、不终止有子任务的 query。带 parent_tool_use_id 的子执行事件只保留原始审计，不污染主会话文本/状态。沿用原生投影和存储，共 3 文件。 | 上游支持多轮长驻 invocation 的答复检查点和子执行输出隔离后删除。 |
| P004 | `patches/0004-task-background-control.patch` | 原生 Task 与 SDK attempt 绑定、精确停止/恢复、原生交接与子树边界、宿主 MCP 凭据传递、群聊输出检查点；另调整候选上游启动顺序，先恢复回调认证再启动可选插件。Bot 开启 Task 控制开关。 | 上游正式具备 Task 到 provider 子执行的生命周期接口及等价停止/交接证明后，逐项删除补丁；启动顺序修复可独立先退出。 |
| A001 | `server/native/`、`server/xbot/` | Bot 名称/单聊/群聊/显示回执映射原生概念。无自研上下文、队列或 A2A。 | 将来官方插件可提供同等 HTTP/事件扩展时，替换宿主连接。 |
| P006 | `patches/0006-bot-schedules.patch` | 由 `CAT_CAFE_BOT_SCHEDULES=1` 启用：schedule 列表补充 reminder 归属、正文、版本与调度器就绪状态；owner 创建接受 UUID 并在原生定义表及审计事务去重；Bot 一次任务结束/错过后保留 disabled 定义和线程账本，拒绝恢复过期计划；通过原生原子 private input 投递完整任务正文；核心调度器启动后再等待可选插件激活。未新增调度器或存储。 | 上游提供同等字段、幂等、历史保留、正文投递及启动就绪保证后删除。 |
| A002 | `server/product-store.ts` | 只保存 UI 元数据和原生引用；单进程原子写。 | 官方插件提供产品配置持久化时替换此存储。 |
| D001 | `scripts/start-runtime.mjs` | 独立配置/数据/workspace/Redis/API/指标端口、专属 cookie/userId；用上游 bootstrap 生成 MCP。避免与用户现有 Clowder 实例串线。 | 官方嵌入部署或插件生命周期接管时移除本启动器。 |
| U001 | `client/public/app.js`、`runtime.*` | UI 显示原生排队状态、订阅事件、选择原生执行工具；独立面板承接原生特有概念。 | 随 Bot 产品迭代，不向核心反向渗透。 |

P001 是执行策略，不是文件系统、记忆库的多租户 ACL。这里只支持本机单用户产品。上游所有高级执行面并未被 Bot 代理公开；未来新增通道必须验证仍经过该准入入口。

## 更新流程

1. 停止 Bot 和本启动器（Ctrl+C）。API 先释放 lease，Redis 再持久化退出。备份 `data/`、`.env` 和当前锁文件；不要删除 SQLite、AOF、transcripts。
2. 在子模块 fetch 上游，选择明确提交并 detached checkout；同时修改 `upstream.lock.json` 的 commit。不要直接跟踪浮动 main，不跳过上游数据迁移说明。
3. 审阅上游 HTTP/Socket.IO、账号、消息生命周期、队列和存储 schema 变化。逐项核查历史补丁是否已有原生替代；冲突需要先明确上游替代或迁移路径，不通过新增、扩大本地运行时补丁或模糊覆盖继续改变上游行为。纯适配层修改必须保持原生语义。
4. `npm run runtime:prepare && npm run verify:upstream`。只有生成代码会被替换；数据路径保持不变。
5. `npm test && npm run verify:frontend && npm run build`，启动专属运行时后 `npm run test:native && npm run smoke`。确有模型环境时加 `BOT_MODEL_SMOKE=1 npm run test:native`。
6. 复跑受影响的上游测试；更新本台账、测试记录并提交子模块 gitlink、锁文件、补丁和适配层变更。

原生回归示例（从 `.runtime/clowder-ai/packages/api` 执行，使用原生隔离 test HOME）：

```bash
node ./scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=2 \
  --test-timeout=60000 test/queue-message-admission.test.js test/queue-ledger.test.js \
  test/session-mutex.test.js test/memory-store.test.js test/build-thread-memory.test.js \
  test/invocation-tracker.test.js
```

本轮这组 **140 项通过**。真实原生契约 2 项与 Codex 短回复通过；其中真实队列已证明非成员被拒绝且没有创建其 Provider 会话。成员入口补丁测试 2 项通过，Bot 适配层测试 12 项通过。浏览器完成创建、排队、真实回复和运行面板验收，保留“界面验收”会话。适配层测试还覆盖断连报错、稳定消息引用、引用回复、单成员取消、来源校验与头像行为。测试替身仅位于 `tests/`，生产代码没有替身。

## 后台委派验证（2026-11-01）

2026-11-01 后台委派验证：Bot 常规测试 32 通过、2 个按需集成项跳过；真实原生契约 2 项与成员准入 2 项通过；P002/P003 专项 3 项通过；SDK 后台生命周期、消息准入、L0 与串行输出相关上游回归 60 项通过。生产构建、smoke、前端完整性与 3 个外部补丁的源码完整性通过。独立本机 Claude Opus 5.5 审查无阻塞问题；实际时延、证据路径与未覆盖边界见 [后端说明](backend-reference.md#轻量后台-subagent-验证2026-11-01)。

## 回退与旧数据

代码回退需要一起恢复子模块 SHA、锁文件、补丁、Bot 适配层，再重新构建。数据已被新版迁移时，必须用同一备份恢复整个数据集；仅回滚代码不保证原生数据库兼容。不要把不同版本的 Redis、SQLite 和会话转录随意拼接。

旧版 `data/state.json`、provider-secrets.json 不自动导入，也不会被删除。本工作区未发现旧业务数据。以后有旧数据迁移需求，应单独转换成员/消息/记忆并验证可表达性，不能将旧 CLI session ID 或摘要伪造成原生运行状态。

## 当前已知限制

- Git 子模块首次拉取与原生依赖安装较大；需要可访问上游及包仓库。
- 原生当前为应用级 API，并非稳定的嵌入 SDK。固定提交与契约测试只能降低升级成本，不能保证零冲突更新。
- 原生默认可选插件初始化在此机器出现告警，具体见 [后端说明](backend-reference.md)。未用 Bot 补丁绕过上游包校验。
- 本机多 Agent 共享 workspace 与原生记忆环境；没有新增容器、租户隔离或通用投票/奖励系统。
- 未来插件化仅保留依赖方向与替换点，当前不宣称已实现。

## Agent 接入清理（2026-10-31）

按用户要求，前端改动由本机 Claude Code Opus 5.5 max 实施，审查修正使用同一会话的 xhigh，禁用 frontend-design；约束记录于根目录 AGENTS.md。后端删除 XBot provider/model 目录生成、Key 写入、模型绑定兼容逻辑，新增原生 Agent 发现与绑定投影。仅退役 Bot 产品的旧接入方式，保留上游账号、Provider 实现及既有数据。新建与重新绑定使用原生默认继承，安装/配置/执行状态分别展示，增加相应契约测试。

本轮验证：默认测试 31 项通过（其中前端专项 17 项）；另行启用的真实原生契约 2 项与成员准入补丁 2 项通过。构建、生产 smoke、上游完整性与前端完整性均通过。78 个 XBot 来源文件仍保留原始摘要，CSS/字体逐字节不变；页面新增资源已纳入完整性检查。浏览器验收了 Agent 检测、新建选择、绑定暂存/取消、搜索与生图只读说明及跳转，没有控制台错误。未修改已有 Bot 的接入或历史。


## 本轮升级评估与候选构建（2026-11-02）

固定提交由 `b2c9952f27d31480191ff6fd120789405c97238c` 更新为 `42017e0cea07e3e259e7fb183be70433f05e131c`，不跟随浮动分支。候选带有普通 Task 的原子认领、结构化原生交接与相应契约测试，因此直接复用这些能力；画像、A2A、球权和队列仍由原生实现。本轮不引入多 resource、统一 gate 或 Bot 自研调度/记忆引擎。

P001–P003 在候选提交上可直接应用；P004 只补原生 Task 与后台 SDK child 之间缺少的绑定与生命周期边界。升级验收额外发现可选插件启动阻塞 callback auth 恢复，已在外部补丁中调整顺序，没有取消插件包校验或绕过身份验证。

候选构建目录为 `.runtime/clowder-ai-task-control`。启动器改用每个构建目录的锁，同时保留数据目录锁并识别旧 `.runtime/native-runtime.lock`；同一数据集、同一构建仍不可并发使用或重建。这样可以在旧实例保持运行时，用另一构建、数据目录及端口验收。`BOT_UPSTREAM_LOCK_FILE` 允许显式指定受信任的本地版本锁；所有校验仍比较精确提交、补丁及生成源码摘要。

本轮预览使用 API 4332、Redis 6393、指标 9493、Bot 3211，数据为 `.runtime/task-control-data`，产品展示数据也位于该目录。原来的 4331/6392/3210 实例与 `data/native` 不自动切换或删除。正式切换时先正常停止旧实例、备份数据及锁文件，按上述升级流程重建/启动；不能以候选构建已通过测试代替现有数据迁移验证。

已完成的基础验证：上游 SDK 40 项、原生 Task/交接/存储 73 项通过；新增 Task 控制契约 17 项全部通过，包含专属 Redis 的序列化和重启回读。首次真实 SDK 验收确认 A 精确停止后心跳停止、B 继续运行、主会话回答独立问题、B 完成后主动回报（证据 `.runtime/task-sdk-acceptance/1d9a10e2`）。完整 HTTP/MCP 验收与前端复审结果在本节后续记录，不把以上 SDK 级验证等同为全链路通过。


候选实例可用以下环境变量复现（使用 Node 24；分别在两个终端运行运行时和 Bot）：

```bash
BOT_RUNTIME_DATA_DIR=.runtime/task-control-data npm run runtime:prepare
npm run build -- --outDir ../.runtime/task-control-web
BOT_RUNTIME_DATA_DIR=.runtime/task-control-data BOT_NATIVE_PORT=4332 \
  BOT_REDIS_PORT=6393 BOT_METRICS_PORT=9493 PORT=3211 npm run runtime:start
# 第二个终端；产品展示数据和静态产物也隔离
BOT_RUNTIME_DATA_DIR=.runtime/task-control-data BOT_NATIVE_PORT=4332 PORT=3211 \
  BOT_PRODUCT_DATA_FILE=.runtime/task-control-data/bot-presentation.json \
  BOT_STATIC_DIR=.runtime/task-control-web npm start
```

生产默认值不变。候选目录也是真实持久数据，不可当作随时可以清理的构建缓存；验收完成后如需停止，正常结束其启动器即可。已验证旧 `data/native` 锁、候选数据锁和候选构建锁都会在写入前拒绝重建，旧生产 PID 仍保持运行。

完整 HTTP/MCP 旅程已通过，证据 `.runtime/task-http-acceptance/2aef4429`：通过 Bot 聊天入口创建两个无负责人 Task、原子认领为 ownerRevision=1、启动两个独立后台 child、HTTP 精确停止 A、B 心跳继续、主会话通过原生 post_message 回答问题，B 跑满 85 秒后主动回报并更新业务状态 done。早期 `.runtime/task-http-acceptance/54df8ccb` 失败记录保留：暴露了启动恢复顺序问题，未伪装成成功。三级委派通过真实原生 create-task/post-message/Queue 契约测试；未将它宣称为三个真实模型连续执行的压力测试。

前端由本机 Claude Code `claude-opus-5-5` max 实施、同会话 xhigh 修订，33 项 Task 界面测试通过。浏览器读取真实验收会话，正确区分 A 已停止和 B 业务/后台已完成，无 console 错误；生产资源 smoke、上游及前端来源完整性通过。前端沿用既有 café tokens/CSS/字体，完整性检查未放宽。

最终候选的外部补丁与构建摘要一致，上游子模块仍干净。补充验证结果：新增 Task 控制契约 27 项（含真实 Redis）全部通过；真实 MCP stdio 进度/取消/重连 3 项通过；上游 SDK 回归 41 项、Task/交接/存储/回调回归 90 项通过。Bot 常规测试 76 项通过、2 项按需集成测试默认跳过。此前停止证明测试在沙箱中无法读取自己创建的进程信息，允许本机进程检查后原样通过；未修改上游测试或放宽断言。

第二轮本机 Claude Code 独立审查无 P1，提出四个 P2：同负责人交接恢复、非 SDK 共享宿主停止隔离、unknown 读取重复广播、MCP 超时/取消传播。上述项已修复，并追加用户停止与内部交接停止竞争、父任务恢复不覆盖子任务独立撤销的回归。最后一轮独立复审的首次调用被自动审批拒绝（缺少源码发送至审查模型服务的明确授权），该次调用未执行。用户随后明确授权，本机 Claude Code `claude-opus-5-5` / xhigh 已完成只读定向复审，确认四项 P2 均已解决，在本轮同线程 Task 树与本机可信 Claude SDK 子执行范围内没有剩余 P1/P2。该轮通过 8 次读取/搜索检查源码与补丁，没有重新运行测试；测试依据为上述最终候选验收。复审原始记录为 `.runtime/task-control-review-final-result.json`。

最后修订后的全链路再次通过：`.runtime/task-http-acceptance/654b3ca5/evidence.json`，Bot「Task验收-654b3ca5」。两个 Task 均从无负责人原子认领（ownerRevision=1）；A 停止后心跳保持 6 条且未产生完成文件，B 持续运行 85 条心跳并真实完成；主 Agent 在 B 运行期间回复 QUESTION_OK 42，随后主动报告 B_DONE，原生 B 的业务状态与后台状态均为完成。最终候选再次通过 2 项真实原生接口契约、2 项成员准入、3 项后台输出检查点、1 项原生策略验证。原生产 3210 和候选 3211 的健康检查均为 HTTP 200；没有切换原生产实例。

第三轮复审留下的两项 P3（以下为当时记录，已在后续真实多 Agent 验收轮修复）：

- 交接后的后代状态保留：`completeHandoff` 复用 resume，可能把原先因业务原因受阻的后代从 `blocked` 改为 `todo`。后续应使内部交接恢复保留原业务状态，并增加相应回归。
- 交接失败后的内部停止标记：若已经请求停止、随后交接因来源撤回或成员/分配变化被拒，内部 handoff 标记仍保留。目前需要用户在确认执行停止后通过界面「允许继续」解除。后续可增加按精确交接来源清理的补偿流程；必须保留用户独立 stop/cancel，且不能在停止证明缺失时自动重启。

## 真实多 Agent 验收轮（2026-11-02）

已修复交接恢复覆盖业务 blocked、交接拒绝后内部停止标记残留。新增精确交接来源与清理意图字段，仍存原生 Task；清理等待整棵树的终态证明，保留用户停止和其他交接，不自动重启。独立定向复审确认两项 P3 解决，无新增 P1/P2（`.runtime/multi-agent-review-result.json`）。另补齐交接消息 strict schema 的可选 subexecutionId，保证精确后台绑定能经 Redis 消息回读；32 项 Task 契约含专属 Redis、90 项上游相关回归均通过。

首轮真实协作发现 get_thread_cats 原先仅提供名字分类，已有角色/特长配置没有送达选人方。因此在原生接口上增加仅 Bot 开关启用、仅线程名册范围的 memberProfiles 只读投影；没有新增画像库、评分器或调度器。字段来源与开关/名册/活跃状态边界测试通过，独立复审无 P1/P2（`.runtime/multi-agent-profile-review-result.json`）。最终重建与中性名字复验结果追加在下方。

首轮真实验收 `5ebd66f0` 的三级结果回传与并发认领通过，但画像选人只使用了名字，不能算画像能力验收。该轮执行中交接失败：用户创建的 Task 从 A 转给 B 后，队列启动 B 时用当前 owner B 复验原 issuer A，报 `task_issuer_has_no_standing`。旧 child 已精确停止，负责人已提交，B 没有启动；失败记录完整保留，没有重新发送普通消息绕过原生交接。

P004 修复上述原生重放边界：仅当精确 lastApplied 消息与已提交的 user/thread/owner/revision 一致，才按该消息的 expected 分配验证原发起者。原始消息、交接消息、线程成员、delegate 证据及 dispatchAuthority 仍实时校验，Redis WATCH 补充旧交接消息 key。补充用户创建任务的重放/启动、撤回、成员移除、owner ABA 与真实 Redis 重载回归。实际候选 37 项 Task 契约全部通过，26 项原生交接相关回归通过；本地 Claude Code Opus 5.5 / xhigh 独立复审无 P1/P2 或直接回归（`.runtime/multi-agent-replay-review-result.json`）。

第二轮 `32870dc6` 通过中性名字下的原生画像选人、三级结果回传、真实并发认领以及运行中交接。三级停止阶段进一步暴露：正式 handoff 来源的 invocation 创建自有独立 Task 成功，但后续 update 被单 Task 来源校验拒绝。模型曾创建同名任务重试；这些失败和重试记录均保留，已通过原生控制逐项取消合成任务，未删除数据、未杀共享宿主来伪造停止。

P004 仅在 Bot 开关下允许该 invocation 刚创建、仍精确绑定当前 invocation/source/cat/thread、owner 与 createdBy 一致、revision=0 且未经交接的自有 Task 使用普通更新路径。已有、未绑定、其他会话创建、已转交或 ABA 后的任务仍被拒；写入时继续验证原 handoff 消息。38 项 Task 契约（含专属 Redis）、26 项原生相关回归通过，独立复审无 P1/P2（`.runtime/multi-agent-sibling-review-result.json`）。边界：如果独立 Task 尚未启动后台执行就主动让出并释放当前绑定，原 handoff invocation 不再具有此例外，后续应由新的正常消息触发认领；没有新增永久创建者授权。

第三轮 `ecfc14ac` 确认 C 的两个后台任务能在同一 invocation 启动，但用户追问超时：队列中更早的 A2A `next_work` 进度消息占住 target 顺序，阻止后面的 `continue_current` 进入已经支持追加的 SDK 主会话。这是队列未送达，不是模型计算慢；失败回执、队列来源和原始执行记录保留。验收没有删除追问断言。收尾时通过根 Task 精确停止 A/B/C，U 独立完成，最终队列与活动调用均为空。

P004 在原生 QueueProcessor 中仅为 Bot 开关启用当前主会话追加例外：显式、未 fallback 的 `continue_current` 可越过等待下一轮的工作进入现有精确 append 事务；普通新轮次的 FIFO 不变，更早的当前会话追问/追加恢复、未知目标屏障、suppression、parent/tenant/capability 与 Queue CAS 校验仍保留。A2A `next_work` 不自动改成追加。154 项原生队列/追加边界回归通过，包含开关关闭、顺序保持、旧 parent 拒绝与 dispatcher 准备期。

队列独立复审发现 fallback 后的较早追问仍须保持顺序屏障，已修复并增加回归；最终候选 155 项队列测试通过，复核确认该 P2 解决（`.runtime/multi-agent-queue-final-review-result.json`）。随后 `95298ce7` 的四个真实子执行均启动，但模型在任务标签后加了说明，验收脚本的精确标题定位没有匹配；该轮没有算通过。定位器改为唯一前缀匹配，发现重复标签直接失败，任务权限与关系仍按原生 ID 验证；旧执行通过根 Task 收尾，新运行使用全新群聊和计时文件，未复用旧产物。

### 最终真实验收结果（分阶段复验）

汇总证据为 `.runtime/multi-agent-acceptance/acceptance-summary.json`，逐项保留实际运行的构建摘要，没有将分阶段结果表述成同一轮全套运行。

| 场景 | 真实结果 | 证据运行 |
| --- | --- | --- |
| 画像选人、三级委派与回传 | 中性名字下根据原生 memberProfiles 选中分析成员；A→B→C 创建原生 Task 树，两次后台执行完成销售核验，总额 300，C→B→A 均有成功 MCP 完成回报 | `32870dc6/profile-tree` |
| 并发认领 | 两位真实成员执行重叠、均发起 revision=0 条件认领；一位成功至 revision=1，另一位收到原生 409，只有一个后台执行产出 | `32870dc6/claim-race` |
| 运行中交接 | 同一个 Task 从 A 转给 B，revision 只加一次；A 心跳停在 16 条，B 接续 70 条并回报完成，C 独立任务从 56 条继续到 202 条后才被明确停止 | `32870dc6/handoff` |
| 三级停止、同宿主隔离、主会话响应 | C 的树内任务与独立 U 同属一个主 invocation；有更早 A2A next_work 排队时，用户追问约 7.6 秒得到回答且未来工作仍排队；根取消后 A/B/C 心跳固定在 156/93/39，U 继续跑满 100 秒，业务状态 done、后台 completed，并成功主动回报 | `27fb5a05/tree-stop` |

两个采用的成功证据集均通过 fixture 摘要校验及原始 SDK 归档核验；没有缺失归档，子执行起点与真实原生 Task 绑定一致，完成报告核对实际 MCP 调用成功回执。失败/脚本定位失败的记录保留，相关验收执行均已收尾；没有删除 Redis、SQLite、历史对话或账号资料。

最终候选实际产物：38 项 Task 契约含专属 Redis、155 项队列/追加边界测试通过；相关 26 项原生交接回归、76 项 Bot 常规测试通过（2 项按需集成默认跳过）。类型检查、上游完整性及前端来源完整性通过。本轮没有新增前端改动；仍保留主 Agent + subagent 与原生 Task/Queue 权威，新增行为均为外部补丁。

范围仍是同线程、三位真实 Claude Opus 5.5 Agent 及可信本机 SDK 子执行；异构 Agent、跨线程后台子树、无人值守任务扫描和画像路由质量统计没有在本轮验证。候选 3211/4332 健康，未进行生产切换。最后只读检查发现旧 3210/4331 未监听，旧 PID 56112 的锁仍保留；未清锁、删除数据或擅自将候选接到旧数据目录，停止原因未由本轮证据确认。
