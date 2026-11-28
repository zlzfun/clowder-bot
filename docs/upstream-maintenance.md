# 上游维护、差异与回退

这里是现行的做法和台账：固定版本怎么构建、数据放在哪、每一处与上游不同的地方为什么存在和什么时候退出、怎样换固定提交。带日期的升级与验收记录在 [上游维护记录](history/upstream-records.md)；每个特性与上游是什么关系在 [特性与上游的关系](features.md)。

## 当前纪律（2026-11-05）

本项目基于 Clowder AI；已有底层机制直接复用，Bot 只通过原生支持的接口、事件和配置进行适配与呈现。记忆、上下文、路由、任务、交接、调度、权限等机制需要改变时，必须先由 Clowder AI 实现，再通过固定版本升级获得。具体约束以根目录 [AGENTS.md](../AGENTS.md) 为准，[CLAUDE.md](../CLAUDE.md) 引用同一规则。

允许通过更上层重新适配：把多个已有原生操作组合成一个用户动作、采用合法默认值、转换请求或聚合原生记录，而不要求界面逐项照搬原生概念。判断一项需求需要上游修改之前，应先核查这一条路径；组合仍须保留各操作的权限、生命周期和失败语义，不新增独立执行引擎或权威数据源。

产品默认按聊天软件组织：用户选猫猫或群聊、说需求、发资料、收成果，无须理解模型、上下文、会话链或工作区。必要接入尽量简短，技术配置与诊断按需展开；简化呈现仍需保留真实状态、失败反馈和必要授权。详细规则见 AGENTS.md 的 Chat-first usability。

外置补丁同样会改变运行时，不能作为绕过上述纪律的方式。下文的补丁台账和 [上游维护记录](history/upstream-records.md) 里的历次验收保留为历史事实；其中本地补丁提供的能力不等于未修改上游已有的能力，也不授权新增或扩大补丁。已有差异需要逐项审计、记录上游替代路径，并通过保留数据的验证迁移退出；本次规则更新不直接拆除现有功能。

## 固定来源与构建

`upstream.lock.json` 是提交、Node、pnpm 与补丁列表的唯一版本约束。上游的 `main` 是稳定分支，只在维护者验收后从集成分支 `next` 晋升；2026-11-26 起固定的是 `next` 上的一个确定提交（`fe632f8f`），原因和依据见 [上游维护记录](history/upstream-records.md#next-fe632f8f)「升级到 next fe632f8f」。构建目录以提交命名（`.runtime/clowder-ai-<提交前 8 位>`），换固定提交时旧构建原样留在旁边，回退不用重新构建。Git 子模块保留完整原始文件和许可，不能直接修改。`runtime:prepare` 检查 SHA 与工作区洁净度，再生成锁文件指定的 `.runtime/` 独立 Git HEAD，逐个 `git apply --check`，按上游 frozen lockfile 构建 API 依赖闭包。Bot 不 fork 核心 npm 包，也不通过复制精选函数实现第二套内核。

启动器同时持有数据目录锁与构建目录锁，阻止同一构建被其他配置并发使用或重建。运行时正在使用的那个构建不能重建；为同一份数据准备**另一个**构建目录（下一个固定提交）则可以在它运行时进行（2026-11-26 起），所以换引擎不需要为构建而停机；准备脚本会加载 `.env` 中的自定义数据路径。构建来源摘要包含锁文件和全部补丁字节；编译成功后才写完成标记。`runtime:start` 拒绝不完整或过期构建。`verify:upstream` 检查子模块、生成目录的 HEAD、补丁逐字节结果及未记录的源码改动。不要在生成目录修业务代码。

## 数据位置

猫在数据目录下的 `native/workspace/cats/<猫>` 里工作。Claude Code 会加载工作目录各级上层的 `CLAUDE.md`，Codex 会读所在 Git 仓库的 `AGENTS.md`，所以数据一旦放在某个代码仓库里，每只猫每一轮都会读到那个仓库写给开发者的说明（2026-11-11 在隔离运行时的会话记录里核实过：本仓库的 `CLAUDE.md` 和 Claude 记忆索引都在猫的上下文里）。

规则在 `shared/data-location.mjs`，启动脚本和 Bot 服务共用：

- `BOT_DATA_DIR` 指定数据根目录；其下是 `native/`（原生数据）和 `bot/presentation.json`（Bot 展示数据）。`BOT_RUNTIME_DATA_DIR`、`BOT_PRODUCT_DATA_FILE` 仍可分别覆盖。
- 都没设置时：这个检出里已经有 `data/native` 或 `data/bot` 的，继续用 `./data`，不会因为默认值变了而把已有数据晾在一边；全新的检出用 `~/.clowder-bot`。
- `runtime:start` 发现数据目录位于某个 Git 检出之内时会打印提示。
- 已有实例用 `npm run data:move` 搬到仓库外（默认 `~/.clowder-bot`，`--to` 另选位置，`--backup <目录>` 先留一份）。不加 `--apply` 只预览；原生运行时还占着数据、目标已存在或目标仍在某个代码仓库里时拒绝执行。搬走后 `./data` 是指向新位置的链接；没有显式设置数据目录的启动方式会把它当作新位置本身。用 `BOT_RUNTIME_DATA_DIR`／`BOT_PRODUCT_DATA_FILE` 写死过路径的服务要手动改到新位置。
- 搬动期间不让别的进程碰数据：Bot 还在它的端口上应答时拒绝执行；执行时在数据目录里占住运行时的锁（`runtime.lock`，随目录一起移动，结束后释放，不进备份），这期间运行时启动不了。万一搬完后原位置又被别的进程写出了新的 `data/`，脚本把它原样挪到 `data.written-during-move-<时间>`（不删除）再建链接，并以非零状态退出提醒核对。
- 「是否在某个代码仓库里」按目录的真实位置判断（先解析符号链接）：从仓库外经链接指进仓库的位置算在仓库里，从仓库里经链接指到外面的算在外面。

2026-11-11 在隔离运行时上做过一遍（数据从 `.runtime/dev/data` 移到 `~/.clowder-bot-dev`，原位置留链接）：

- 搬之前建的对话照常可用：历史、文件列表、上传、工作目录浏览、真实收发都正常。它保存的仍是旧路径，沿用原来的 CLI 会话，所以仍然带着仓库的说明；要让一只猫的上下文变干净，给它开一个新对话。
- 搬之后新建的猫工作在 `~/.clowder-bot-dev/native/workspace/cats/<猫>`：会话记录里没有本仓库的 `CLAUDE.md`、没有记忆索引，个人钩子也没有输出；同样一句话的首轮输入从约 3.9 万 token 降到约 2.9 万。
- 构建目录里指向数据目录的两个链接（`data`、`.cat-cafe`）经旧路径上的链接仍然解析到新位置，`runtime:start` 的校验通过，不需要重新构建。

## 偏好仓库

原生把用户的偏好（Taste）存在 Git 里：`FileTasteRepository` 从 API 进程所在的构建目录出发，用 `git worktree list` 找「同一个仓库里检出了 `refs/heads/main` 的工作树」，在那里读写 `private/taste/`（敏感偏好，不进 Git）和 `docs/taste/vignettes/`（公开偏好，另需向 `origin/main` 推送）。它不读任何环境变量或配置（固定上游 `domains/taste/services/TasteRepository.ts`）。

此前每次构建都是独立 `git init` 出来的 detached HEAD，没有分支，所以猫提出「记住这个偏好」后，同意时原生返回 `Vignette write failed`，什么也存不下。把构建目录自己切到 `main` 能读不能久存：下一次重建会连同已保存的偏好一起删掉；用符号链接指到数据目录则被读取端的真实路径校验拒绝。

现在的布局（只改启动与构建脚本，不改引擎）：

- 数据目录下有一个长期的 Git 仓库 `<native 数据目录>/taste-home`，检出 `main`（一个空提交起步），对象库通过 alternates 借用子模块的，和以前构建目录的做法一样。
- `runtime:prepare` 把每次构建建成它的链接工作树（`git worktree add --detach <构建目录> <固定提交>`，再打补丁、安装、编译），与上游自己「主检出在 main、运行时是链接工作树」的布局一致。重建只替换构建目录并重新登记工作树；仓库、`main` 工作树和原生写进去的偏好文件都在数据目录里，不受影响。
- 构建不是这个仓库的工作树时（旧构建），`runtime:prepare` 会重建一次；`runtime:start` 遇到还没接上的构建只提示，不拒绝启动。替换旧构建之前，它在 `private/taste/`、`docs/taste/` 下而固定上游源码里没有的文件会先搬进偏好仓库（不覆盖已有的），并逐个打印。
- 上游靠自己的 `.gitignore` 把 `private/` 排除在 Git 之外，偏好仓库里没有上游的文件，所以 `runtime:prepare` 在仓库自己的 `.git/info/exclude` 里写入同一条规则：给这个仓库做 `git add .` 式的备份时不会把敏感偏好提交进去。
- 没有配置 `origin`。敏感偏好（猫标为 sensitive 的，实测的那条就是）可以保存；公开偏好的发布会失败并回到待确认，聊天里如实显示没有成功。要不要给它配一个本地裸仓库作 `origin` 由使用者决定，绝不能指向 Clowder AI 的公开仓库（上游 F221 明确公开偏好只属于私有的 home 仓库）。

2026-11-11 在隔离运行时上验证：按新布局重建后，同意一条真实的偏好提议返回已落实，`GET /xbot-api/memory/taste` 读到该条，文件在 `taste-home/private/taste/`；随后改动锁文件强制重建，文件还是同一个（inode 未变），重启后仍能读到；`verify:upstream` 通过。现有实例要等下一次 `runtime:prepare`（需要先停运行时，约五分钟）后才接上。

仍然登记为上游需求：私有偏好应当和 Profile 一样放在数据目录，或提供受支持的定位方式，而不是依赖运行目录的 Git 布局。

## 差异台账

| 编号 | 改动位置 | 原因/影响 | 退出条件 |
| --- | --- | --- | --- |
| P001 | `patches/0001-thread-participant-policy.patch` | 原生 preferredCats 只是路由偏好。Bot 群聊需要显式执行成员。给 invokeSingleCat 入口加默认关闭的检查；Bot 开启后名单缺失/读取失败/非成员均拒绝，provider/session 尚未启动。新增 helper，加一处原生入口检查，共 2 文件。 | 上游提供覆盖直接、排队、A2A 的正式成员准入扩展点后，迁到该接口并删除补丁。 |
| P002 | `patches/0002-background-delegation-policy.patch` | 原生 L0 编译后追加部署级后台委派约束，覆盖缓存命中和文件输出；默认关闭，Bot 开启。主会话接待、长任务由原生后台子代理执行，不创建新协调 Agent。共 2 文件。2026-11-26 起不追加到上游新增的 `scoped-member` 投影（插件驱动的受限成员会话），那条路径保持上游原样。 | 上游正式支持部署级主会话指令扩展后迁移。 |
| P003 | `patches/0003-background-output-checkpoint.patch` | Claude SDK 每轮 result 发出类型化输出检查点，route-serial 刷新尾部草稿，不发 done、不终止有子任务的 query。带 parent_tool_use_id 的子执行事件只保留原始审计，不污染主会话文本/状态。沿用原生投影和存储，共 3 文件。 | 上游支持多轮长驻 invocation 的答复检查点和子执行输出隔离后删除。 |
| P004 | `patches/0004-task-background-control.patch` | 原生 Task 与 SDK attempt 绑定、精确停止/恢复、原生交接与子树边界（含「按发起时的分配授权重放」）、宿主 MCP 凭据传递、群聊输出检查点。Bot 开启 Task 控制开关。2026-11-26 随固定提交升级退掉三处，都是上游已经原生做到的：队列里「绑定当前回合的追问越过下一轮工作」及其测试、启动顺序的调整、前驱交接消息的 WATCH。不作用于插件成员会话。共 22 文件。 | 上游正式具备 Task 到 provider 子执行的生命周期接口及等价停止/交接证明后，逐项删除补丁。 |
| P005 | `patches/0005-cat-templates.patch` | 没有开关，随构建始终注册：新增 `/api/bot-cat-templates`（列表、读取、创建、带 `expectedRevision` 的修改与删除）和 `/instantiate`，模板库存于原生工作区 `.cat-cafe/bot-cat-templates.json`；`runtime-cat-catalog` 允许 `native_tool` 创建回执建立已发布的猫种族系。设置里的模板增删改、按模板建猫和资料页的 `cat_config` 依赖它，设计见 [猫猫模板](cat-templates-design.md)。共 4 文件。2026-11-11 起，只填名字的建猫不经过它，直接用未打补丁的 `POST /api/cats`（见 [接口范围](xbot-api.md)「开箱即用」），这条补丁的使用面不再扩大。 | 上游提供成员模板的存取与按模板创建，或确认模板只属于产品展示层并改由未打补丁的建猫接口组合后删除。 |
| A001 | `server/native/`、`server/xbot/` | Bot 名称/单聊/群聊/显示回执映射原生概念。无自研上下文、队列或 A2A。 | 将来官方插件可提供同等 HTTP/事件扩展时，替换宿主连接。 |
| P006 | `patches/0006-bot-schedules.patch` | 由 `CAT_CAFE_BOT_SCHEDULES=1` 启用：schedule 列表补充 reminder 归属、正文、版本与调度器就绪状态；owner 创建接受 UUID 并在原生定义表及审计事务去重；Bot 一次任务结束/错过后保留 disabled 定义和线程账本，拒绝恢复过期计划；通过原生原子 private input 投递完整任务正文。未新增调度器或存储。原先还把可选插件的激活挪到调度器启动之后，2026-11-26 退掉：上游已把插件激活移出启动路径。共 7 文件。 | 上游提供同等字段、幂等、历史保留、正文投递后删除。 |
| A002 | `server/product-store.ts` | 只保存 UI 元数据和原生引用；单进程原子写。 | 官方插件提供产品配置持久化时替换此存储。 |
| D001 | `scripts/start-runtime.mjs`、`scripts/prepare-upstream.mjs` | 独立配置/数据/workspace/Redis/API/指标端口、专属 cookie/userId；用上游 bootstrap 生成 MCP。避免与用户现有 Clowder 实例串线。构建目录是数据目录里偏好仓库的链接工作树（见「偏好仓库」），数据默认在检出之外（见「数据位置」）。 | 官方嵌入部署或插件生命周期接管时移除本启动器。 |
| A003 | `server/native/apps.ts`、`server/xbot/apps.ts` | 应用（2026-11-26；2026-11-28 T-39 在 `fe632f8f` 重核）：把上游的外部 MCP 登记（安装、探活、改密钥、全局与按猫开关、删除）和官方插件 `official.wechat-visible-reader` 的启停、授权操作及 `plugin_operation_changed` 订阅（`/xbot-api/apps/events`）呈现为「自定义应用」和「微信」。不保存状态与密钥，只在 A002 里保存自定义应用的显示名。上游对安装请求不做校验，校验在适配层；插件操作前先调上游的重置路由，绕开下面「应用依赖的上游行为」里记的缺陷。见 [应用：第一版接口](apps-api.md)。 | 上游修复操作状态的缺陷后去掉动作前的重置；上游让插件的 MCP（含子目录会话与按猫禁用持久化）与技能在 `clowder-bot` 部署下完整生效后，再评估是否以插件包承载（任意用户自填 stdio/HTTP 外部 MCP 仍需能力登记表）。 |
| D002 | `computer-driver.lock.json`、`scripts/install-computer-driver.mjs` | 「这台电脑」背后的桌面驱动（cua-driver 自带的已签名应用），固定到一个发布版本，按校验和、签名身份和公证安装到数据目录的 `tools/` 下。不随 Bot 启动，也不由 Bot 看管：驱动的 MCP 入口按需自己拉起后台进程。引擎里只有注册表中的一条登记（见 [接口范围](xbot-api.md)「这台电脑」）。 | 驱动只是暂定的选择（使用者 2026-11-26：「那我们也用cua-driver吧，暂时。」）。之后若并入「应用」，或上游提供自己的桌面能力，按那时的做法迁移。 |
| U001 | `client/public/app.js`、`runtime.*` | UI 显示原生排队状态、订阅事件、选择原生执行工具；独立面板承接原生特有概念。 | 随 Bot 产品迭代，不向核心反向渗透。 |

P001 是执行策略，不是文件系统、记忆库的多租户 ACL。这里只支持本机单用户产品。上游所有高级执行面并未被 Bot 代理公开；未来新增通道必须验证仍经过该准入入口。

## 更新流程

1. 停止 Bot 和本启动器（Ctrl+C）。API 先释放 lease，Redis 再持久化退出。备份 `data/`、`.env` 和当前锁文件；不要删除 SQLite、AOF、transcripts。
2. 在子模块 fetch 上游，选择明确提交并 detached checkout；同时修改 `upstream.lock.json` 的 commit 和 build（构建目录以提交命名）。不要直接跟踪浮动分支，不跳过上游数据迁移说明。先看清上游的分支：`main` 可能很久不动，更新都在 `next`；固定 `next` 上的提交前确认它的上游 CI 通过，并让使用者知道那不是发布版本。子模块是浅的、不带文件内容的克隆，一次取整个提交在不稳的网络上会断：先取提交和目录树（`--depth 1 --filter=blob:none`），再把缺的文件内容分批取（`git rev-list --objects --missing=print` 列出，每批几百个交给 `git fetch --stdin`）。
3. 审阅上游 HTTP/Socket.IO、账号、消息生命周期、队列和存储 schema 变化。补丁用三方合并移植（把补丁逐个提交在旧固定提交上，再挑到新提交上），冲突之外，「干净合并」的地方也要看：2026-11-26 那次有两处合并通过却引用了上游已经删掉的变量。逐项核查历史补丁是否已有原生替代；冲突需要先明确上游替代或迁移路径，不通过新增、扩大本地运行时补丁或模糊覆盖继续改变上游行为。纯适配层修改必须保持原生语义。
4. `npm run runtime:prepare && npm run verify:upstream`。只有生成代码会被替换；数据路径保持不变。
5. `npm test && npm run verify:frontend && npm run build`，启动专属运行时后 `npm run test:native && npm run smoke`。确有模型环境时加 `BOT_MODEL_SMOKE=1 npm run test:native`。补丁各自的专项测试都跑一遍（`test:background-policy`、`test:background-output`、`test:task-background`（带 `BOT_TASK_TEST_REDIS_URL`）、`test:task-mcp`、`test:cat-templates-native`、`test:schedules-native`、`scripts/test-native-policy.mjs`）。切换已有实例之前，用它数据的副本演练一次：副本用自己的端口，启动环境里不放任何 Agent 的可执行文件，把读出的猫猫、群聊、各对话内容与原实例逐项比较。
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

2026-11-26 换到 `fe632f8f` 那一次的完整做法——日常实例照常运行的同时构建新运行时、用数据副本演练、只在切换时停机、怎样回退——记在 [上游维护记录](history/upstream-records.md#switch-live)，那里写明「下次换固定提交照此进行」。它与上面第 1 步「先停止再备份」不一致的地方，以那一次的做法为准；这一节的步骤还没有照它改写（见 [计划与待办](backlog.md)）。

## 回退与旧数据

代码回退需要一起恢复子模块 SHA、锁文件、补丁、Bot 适配层，再重新构建。数据已被新版迁移时，必须用同一备份恢复整个数据集；仅回滚代码不保证原生数据库兼容。不要把不同版本的 Redis、SQLite 和会话转录随意拼接。

旧版 `data/state.json`、provider-secrets.json 不自动导入，也不会被删除。本工作区未发现旧业务数据。以后有旧数据迁移需求，应单独转换成员/消息/记忆并验证可表达性，不能将旧 CLI session ID 或摘要伪造成原生运行状态。

## 引擎的包（2026-11-12）

「说话简短」是引擎 Pack 机制（上游 F129）里的一条默认行为，不是补丁，也不写进猫的资料：

- 用的是未打补丁的 `GET /api/packs` 和 `POST /api/packs/add`。适配层（`server/native/chat-pack.ts`）在发消息、请猫打招呼之前和 Bot 启动时确认引擎里装着 style 包 `clowder-bot-chat`，没有或版本不同就装；它不删除、不调整别的包，引擎里已经有别的包时自己的也不装（见下）。
- 包存在引擎自己的目录里：`<数据目录>/native/workspace/.cat-cafe/packs/clowder-bot-chat/`（构建目录里的 `.cat-cafe` 是指向数据目录的链接，重建运行时不丢）。看装了什么：`curl http://127.0.0.1:<原生端口>/api/packs`。
- 升级固定提交时：`tests/chat-pack.test.ts` 对照上游源码里的包模式（`packages/shared/src/schemas/pack.ts`）、默认行为编成的那一节（`PackCompiler.ts`）、「只应用列出的第一个包」（`getActivePackBlocks.ts`）和两条路由；上游改了其中任何一处，这项测试会先失败，再到隔离运行时上重新量一遍回复长度。
- 固定的这版引擎一次只应用一个包（Phase A）：`PackStore.list()` 读目录得到的第一个，与安装先后无关。所以引擎里有别的包时适配层不安装自己的（按名字排在前面会把使用者的包顶掉），这条默认行为让位。上游做了多包合并或指定生效的包之后，这条限制可以去掉。
- 需要上游解决、这里不打补丁的两件事：安装是先删后拷、不是原子的（替换的瞬间正好开始的一轮读不到包；拷到一半失败时清单在而行为不在，列表却照样列出）。适配层只做到：一次安装没有好好回来之前不把列表当证据，下次重装；这份记账不跨 Bot 重启。

## 插件依赖与证书（2026-11-26）

上游给目录来源的官方插件装依赖时，用的是一个清空了环境的 `npm ci`（只留 `PATH`，`HOME` 指到沙箱，源固定为 `registry.npmjs.org`；`packages/api/src/domains/plugin/manager/package-assets/builtin-package-materializer.ts`）。使用者在 shell 里的 `NODE_EXTRA_CA_CERTS`、`~/.npmrc` 都带不进去。

在这台开发机上，Node 24 自带的根证书验不过 npm 官方源现在的证书链（`npmjs.org ← WE1 ← GTS Root R4 ← GlobalSign Root CA`，自带根证书里没有最后一张），于是所有带依赖的官方插件启动失败，插件管理里只看到 `UNEXPECTED_RUNTIME_FAILURE`，引擎日志里是 `BuiltinPluginPackageMaterializationError`。线上实例里几个长期「已启用但失败」的插件是同一个原因。

处理（机器设置，不是补丁）：在这套 Node 的全局 npm 配置里指定证书文件。全局配置按 npm 的安装前缀找，不受 `HOME` 影响。

```ini
; /opt/homebrew/etc/npmrc
cafile=/Users/<你>/.config/node-ca/system-ca.pem
```

验证：按上游同样的参数与环境在一个临时目录里跑 `npm ci --ignore-scripts --omit=dev`，加这一行之前报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`，之后装上 95 个包；隔离运行时里 `dev.clowder.video-analysis`、`official.enterprise-workflow`、`official.wechat-visible-reader` 随后都启动成功。撤销就是删掉这个文件。线上实例用的是同一个 npm：留在「已启用」而失败的插件会在它下次重启时启动。

已登记为上游需求：装依赖时沿用宿主的证书与代理设置，或让它可配置。

## 应用依赖的上游行为（2026-11-26）

固定提交在隔离运行时上的实测，与 [应用：第一版接口](apps-api.md) 相关的部分。升级固定提交时逐条重新核对。

2026-11-27：引擎换到 `next` 的 `fe632f8f` 之后重新核对过（读了改动的路由，又在升级后的隔离运行时上从界面走了一遍），下面各条都还成立，适配层没有因此改动。隔离运行时是这一天升级的：旧引擎正常停下后做了冷备份 `~/.clowder-bot-dev.before-fe632f8f-20261127`，旧锁文件留在 `.runtime/dev/upstream.lock.42017e0c.json`，旧构建 `.runtime/clowder-ai-dev` 没有删。

2026-11-28（`fe632f8f`，T-39 重核）：在临时隔离运行时（`.runtime/clowder-ai-fe632f8f` 只读 + `/tmp` 数据目录 + `CAT_CAFE_DEPLOYMENT_ID=clowder-bot`）结合上游源码重核了「应用不走插件包」的四个条件及 `plugin_operation_changed` 事件：

- **重核「插件带的 MCP 与技能到不了猫」的四个条件**：
  - `CAT_CAFE_DEPLOYMENT_ID=clowder-bot` 下 `allowsImplicitCapabilityWrites` 为 `false`（`persistCapabilities: false`）：插件运行时**不**将 MCP 写入 `capabilities.json`（只保留内存中的激活描述），**不**挂载也不登记技能（`declared-static-resources.ts:127` 直接返回，`.claude/skills`、`.codex/skills` 均未挂载）。同时 `GET /api/capabilities`（无 `projectPath` 或 `projectPath=workspace`）仍投影出该条（`accessManagedByPlugin: true`），`GET /api/capabilities?projectPath=<workspace>/cats/<id>` 返回空，且 `PATCH /api/capabilities` 对该条目返回 **404**（因 `capabilities.json` 中不存在，无法按猫禁用或全局开关）。
  - 上游在调用时通过 `projectLocalPluginMcpCapabilities`（`plugin-mcp-exposure.ts:39-92`、`invoke-single-cat.ts:1552-1609`）有条件地投影插件 MCP，**四个条件必须同时成立**：(1) `ownerAuthProvenance === 'strict'`；(2) `pluginMcpExposureProject(thread.projectPath, workingDirectory)` 与 `CAT_CAFE_CONFIG_ROOT`（`<数据目录>/native/workspace`）**完全同一目录**（`isSameCapabilityRoot`）；(3) 非插件受限成员（`!isScopedMember`）且成员匹配；(4) `capabilities.json` 中无同 id 或同 `:`→`__` 编码名冲突、且激活仍为 current。
  - **对 Bot 的结论**：Bot 的单聊 `projectPath` 是 `workspace/cats/<catId>`、群聊是 `workspace/groups/<key>`（`server/workspaces.ts`），与 `CAT_CAFE_CONFIG_ROOT`（`workspace`）不是同一目录，条件 (2) 在常规 Bot 会话下恒为假，实测投影结果为空（`[]`）；仅当线程的 `projectPath` 设为 `workspace` 自身或 `'default'`（且工作目录为 `workspace`）时才会投影。即便改通条件 (2)，自定义应用仍不能改走插件包：插件技能仍不生效、没有 `capabilities.json` 落点就做不了按猫禁用与全局开关、且用户添加的任意 stdio / `streamableHttp` 外部 MCP 服务并非插件包（上游声明式插件 MCP 也只支持 `stdio`）。
- **`plugin_operation_changed` 事件覆盖面**：实测与源码（`PluginManagerService.running`）确认，上游在用户房间 `user:<userId>` 推送 `plugin_operation_changed`（`{ pluginId }`），但**仅覆盖目录安装（`catalog install`）、`update` 与 `uninstall` 的起止**；`local-directory` 安装、`set-enabled`（启停与启动完成）及插件内部操作（10 分钟授权 `arm`/`disarm`/到期）均不发事件。适配层新增 `GET /xbot-api/apps/events` 转发 `official.wechat-visible-reader` 的该事件与断线重连 `resync` 以即时刷新微信状态，原有启动期间 2 秒轮询与到期重读仍需保留。

下面为 2026-11-26 初版记录（其中「插件带的 MCP 与技能到不了猫」的内部机制与「没有状态事件」两句以本节上方 2026-11-28 重核为准）：

- **插件带的 MCP 与技能到不了猫**。Bot 启动引擎时的部署标识是 `clowder-bot`，上游的 `allowsImplicitCapabilityWrites` 因此为假，插件运行时不把自己的 MCP 写进能力登记表、也不挂载技能；剩下的调用时投影要求线程的项目目录等于能力根目录，而每只猫的对话在 `workspace/cats/<id>`。实测：自写的插件包（一个 stdio MCP、一条技能、一个密钥字段）能安装、配置、运行，但猫的会话里没有它的工具和技能。读取侧的 `GET /api/capabilities/snapshot?catId=` 仍把它显示为已启用，不能当作「已连接」的依据。把标识改成上游自己的 `runtime` 能打开这个开关，但那是上游自身安装的身份（共享 MCP 的部署标签、运行时部署登记、启动时的 CLI 配置再生成），与使用者自己的 Clowder AI 会串线，不采用。
- **插件带的直接工具与外接节点到得了猫**：`tool` 贡献经 `plugin_list_tools`／`plugin_call`，`limb` 贡献经 `limb_list_available`。实测 `official.enterprise-workflow` 的两个工具和 `official.wechat-visible-reader` 的节点都被测试猫列出。
- **外部 MCP 的安装接口不做校验**（任意 id、空命令都接受，id 已存在时合并覆盖：后来的程序会配上先来的密钥）。适配层因此给每个添加请求一个独有的 id（名字的字母加请求自己的 8 位码），并用同一段码在登记表里认出重发的请求；请求头名称引擎按原样存，两种大小写会并存。
- **探活的错误原话可能带凭据**：MCP SDK 把非 2xx 回应的正文拼进错误，对方若把收到的密钥写在正文里，就会随 `error` 回来。适配层不把这段原话交给界面。
- **插件操作的步骤指针缺陷**：见接口文档「上游的实际行为」最后一条。
- **启用插件可能超过适配层一次请求的 30 秒**，上游继续执行；没有状态事件，只能再读。
- **微信插件的 10 分钟授权只管一种读法**（读插件 0.1.0-alpha.7 与上游 `routes/callback-limb-routes.ts` 的代码，没有实际读过）：读「正打开的那段聊天」要授权；按联系人名字读最近 1–30 条只要插件启用，引擎核对这次调用出自猫对使用者亲自发的一条消息的回复，两个确认标记由猫自己填。所以同意点是启用，界面在「打开」之前就把这些说清楚。插件换版本时要重新读这两处代码，界面的说明跟着改。插件也不请求屏幕录制权限，只检查；没有权限时读取失败。

向上游提的需求（尚未提交）：插件的 MCP 与技能在非 `runtime` 部署下对成员生效；装依赖时沿用宿主的证书与代理设置；不把 `operationState` 交给不认识它的插件（或由插件契约声明）；安装外部 MCP 时校验 id 与必填项、拒绝静默覆盖，并提供「不存在才创建」的原子安装（现在只能靠适配层给每个请求一个独有的 id 来避开合并）；探活的错误里不要带对方服务器回应的正文（可能含凭据），或提供脱敏后的诊断；请求头名称按不分大小写合并；插件生命周期事件；远程 MCP 的浏览器登录；按成员启用技能。

## 电脑驱动（2026-11-26）

「这台电脑」（[接口范围](xbot-api.md)）用的桌面驱动不是 Clowder AI 的一部分，也不进这个仓库：是 [trycua/cua](https://github.com/trycua/cua) 的 cua-driver（MIT）自带的应用 `CuaDriver.app`，用它的「独立」方式运行。

- **固定版本。** `computer-driver.lock.json` 写着发布标签、版本、压缩包的 SHA-256 与大小、应用的 bundle id（`com.trycua.driver`）和签名团队（`YCK386LBJ7`，Developer ID「Cua AI, Inc.」）。现在固定的是 0.34.0，和 OpenBot 固定的是同一版；这一版在隔离运行时上实测过。上游发版很密（2026-11 一天数版），不跟最新。
- **安装。** `npm run computer:install`：下载固定的压缩包（约 76 MB），核对大小和 SHA-256，只解出应用，核对签名（`codesign --verify --deep --strict`）、bundle id、签名团队、Gatekeeper（`spctl`）和版本，全部通过才放到 `<数据目录>/tools/CuaDriver.app`；任何一项不过就什么都不装，也不留下临时文件。`-- --from <文件>` 用已经下载好的压缩包（同样的核对），`-- --check` 只报告现状。适配层在使用前再核对一次签名身份，所以放一个同名的别的程序不会被当成驱动。
- **授权。** macOS 把辅助功能（macOS 27 上叫「设备控制与数据访问」）和屏幕录制记在 `CuaDriver` 这个应用上，与 Bot 是从终端还是由 launchd 启动无关。第一次给某只猫打开「电脑」时，驱动自己打开系统设置请使用者授权；授权不全时适配层什么都不改。给屏幕录制打开开关时 macOS 会要求退出并重新打开 CuaDriver，属正常。授权按应用的签名身份记，不按它放在哪里：2026-11-26 在开发目录那一份上给的两项授权，对随后装进日常数据目录的那一份同样有效（装好后启动它读了一次状态，两项都在，没有弹出系统设置）。
- **进程。** 驱动的后台进程由它自己的 MCP 入口在猫第一次调用工具时拉起，没有任何猫开着时适配层请它退出。Bot 的启动脚本不启动它，Bot 退出也不影响它。
- **遥测。** 驱动默认会发不含内容的使用统计。登记里带着 `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`、`CUA_DRIVER_RS_UPDATE_CHECK=0`，第一次登记时还执行一次 `cua-driver telemetry disable`（写在使用者的 `~/.cua-driver/config.json`）。
- **换版本。** 改 `computer-driver.lock.json`（标签、版本、文件名、SHA-256、大小、压缩包里的应用路径），重新运行安装，再在隔离运行时上走一遍：开、授权、让测试猫操作一次计算器、关、新建一只猫确认它是关的。签名团队或 bundle id 变了要同时改适配层里核对的值（`server/native/computer.ts`），有测试把两处对在一起。
- **卸载。** 把所有猫的「电脑」关掉；删除 `<数据目录>/tools/CuaDriver.app`；在系统设置里移除 CuaDriver 的两项授权；需要的话删除注册表里的 `computer` 登记（`DELETE /api/capabilities/mcp/computer?hard=true`）和 `~/.cua-driver`。

已知限制见 [接口范围](xbot-api.md)「这台电脑」。只在 macOS 27、Apple 芯片上实测过。

## 当前已知限制

- Git 子模块首次拉取与原生依赖安装较大；需要可访问上游及包仓库。
- 原生当前为应用级 API，并非稳定的嵌入 SDK。固定提交与契约测试只能降低升级成本，不能保证零冲突更新。
- 原生默认可选插件初始化在此机器出现告警，具体见 [后端说明](backend-reference.md)。未用 Bot 补丁绕过上游包校验。
- 本机多 Agent 共享 workspace 与原生记忆环境；没有新增容器、租户隔离或通用投票/奖励系统。
- 未来插件化仅保留依赖方向与替换点，当前不宣称已实现。
