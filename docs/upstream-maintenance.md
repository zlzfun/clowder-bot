# 上游维护、差异与回退

## 固定来源与构建

`upstream.lock.json` 是提交、Node、pnpm 与补丁列表的唯一版本约束。Git 子模块保留完整原始文件和许可，不能直接修改。`runtime:prepare` 检查 SHA 与工作区洁净度，再生成 `.runtime/clowder-ai` 独立 Git HEAD，逐个 `git apply --check`，按上游 frozen lockfile 构建 API 依赖闭包。Bot 不 fork 核心 npm 包，也不通过复制精选函数实现第二套内核。

启动器同时持有数据目录锁与构建目录锁，阻止同一构建被其他配置并发使用或重建；准备脚本会加载 `.env` 中的自定义数据路径。构建来源摘要包含锁文件和全部补丁字节；编译成功后才写完成标记。`runtime:start` 拒绝不完整或过期构建。`verify:upstream` 检查子模块、生成目录的 HEAD、补丁逐字节结果及未记录的源码改动。不要在生成目录修业务代码。

## 差异台账

| 编号 | 改动位置 | 原因/影响 | 退出条件 |
| --- | --- | --- | --- |
| P001 | `patches/0001-thread-participant-policy.patch` | 原生 preferredCats 只是路由偏好。Bot 群聊需要显式执行成员。给 invokeSingleCat 入口加默认关闭的检查；Bot 开启后名单缺失/读取失败/非成员均拒绝，provider/session 尚未启动。新增 helper，加一处原生入口检查，共 2 文件。 | 上游提供覆盖直接、排队、A2A 的正式成员准入扩展点后，迁到该接口并删除补丁。 |
| P002 | `patches/0002-background-delegation-policy.patch` | 原生 L0 编译后追加部署级后台委派约束，覆盖缓存命中和文件输出；默认关闭，Bot 开启。主会话接待、长任务由原生后台子代理执行，不创建新协调 Agent。共 2 文件。 | 上游正式支持部署级主会话指令扩展后迁移。 |
| P003 | `patches/0003-background-output-checkpoint.patch` | Claude SDK 每轮 result 发出类型化输出检查点，route-serial 刷新尾部草稿，不发 done、不终止有子任务的 query。带 parent_tool_use_id 的子执行事件只保留原始审计，不污染主会话文本/状态。沿用原生投影和存储，共 3 文件。 | 上游支持多轮长驻 invocation 的答复检查点和子执行输出隔离后删除。 |
| A001 | `server/native/`、`server/xbot/` | Bot 名称/单聊/群聊/显示回执映射原生概念。无自研上下文、队列或 A2A。 | 将来官方插件可提供同等 HTTP/事件扩展时，替换宿主连接。 |
| A002 | `server/product-store.ts` | 只保存 UI 元数据和原生引用；单进程原子写。 | 官方插件提供产品配置持久化时替换此存储。 |
| D001 | `scripts/start-runtime.mjs` | 独立配置/数据/workspace/Redis/API/指标端口、专属 cookie/userId；用上游 bootstrap 生成 MCP。避免与用户现有 Clowder 实例串线。 | 官方嵌入部署或插件生命周期接管时移除本启动器。 |
| U001 | `client/public/app.js`、`runtime.*` | UI 显示原生排队状态、订阅事件、选择原生执行工具；独立面板承接原生特有概念。 | 随 Bot 产品迭代，不向核心反向渗透。 |

P001 是执行策略，不是文件系统、记忆库的多租户 ACL。这里只支持本机单用户产品。上游所有高级执行面并未被 Bot 代理公开；未来新增通道必须验证仍经过该准入入口。

## 更新流程

1. 停止 Bot 和本启动器（Ctrl+C）。API 先释放 lease，Redis 再持久化退出。备份 `data/`、`.env` 和当前锁文件；不要删除 SQLite、AOF、transcripts。
2. 在子模块 fetch 上游，选择明确提交并 detached checkout；同时修改 `upstream.lock.json` 的 commit。不要直接跟踪浮动 main，不跳过上游数据迁移说明。
3. 审阅上游 HTTP/Socket.IO、账号、消息生命周期、队列和存储 schema 变化。补丁冲突必须在 `patches/` 重新生成与评审，不用模糊覆盖隐藏冲突。
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
