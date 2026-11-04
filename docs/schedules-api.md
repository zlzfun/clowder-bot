# 定时任务第一版接口

Clowder AI 保存和执行定时任务，Bot 只做输入校验、成员范围映射和展示。入口放在每只猫的信息抽屉「任务」中，沿用 XBot 的列表、表单和猫咖配色。首版支持创建、查看、暂停/恢复、删除与最近触发记录；结果发到创建时绑定的单聊。新会话不会迁移已有任务。

## Bot API

- `GET /xbot-api/bots/:name/routines` → `{ routines, currentThreadId, timezone }`
- `POST /xbot-api/bots/:name/routines` → 201 `{ id, name, prompt, trigger, threadId }`
- `PATCH /xbot-api/bots/:name/routines/:id`，body `{ enabled: boolean }` → `{ success: true, enabled }`
- `DELETE /xbot-api/bots/:name/routines/:id` → `{ success: true }`
- `GET /xbot-api/bots/:name/routines/:id/runs` → `{ runs }`（最近 50 条）

创建 body 严格限定为 `{ name, prompt, schedule, idempotencyKey }`。name 为 1–80 字符，prompt 为 1–16000 字符，idempotencyKey 为 UUID；同一份表单的重试复用该值，改动内容后用新值。

schedule 四选一：

```json
{"kind":"once","at":"2026-11-05T09:00:00+08:00"}
{"kind":"daily","time":"09:00","timezone":"Asia/Singapore"}
{"kind":"weekly","time":"09:00","days":[1,3,5],"timezone":"Asia/Singapore"}
{"kind":"interval","minutes":60}
```

一次任务必须是未来的带偏移 ISO 时间；重复任务使用明确的 IANA 时区，星期 0 为周日；间隔为 1–10080 的整数分钟。周期输入仅转换为原生 TriggerSpec，不在 Bot 运行计时器。

间隔任务沿用原生规则：创建和恢复后等待一个间隔；运行时重启时会立即检查一次，再按间隔执行。需要固定钟点的任务应选每天或每周。

routine 的字段：

```text
id, name, prompt, threadId, currentThread (boolean),
trigger: {type:'once',fireAt:epochMs} | {type:'cron',expression,timezone?} | {type:'interval',ms},
enabled, effectiveEnabled, registered,
status: 'scheduled' | 'paused' | 'blocked' | 'delivered' | 'failed' | 'missed' | 'unregistered',
lastRun: null | Run, runStats: {total,delivered,failed,skipped}
```

Run 保留原生字段：`outcome, started_at, scheduled_at?, fired_at?, duration_ms, error_summary, assigned_cat_id, threadId?`。`RUN_DELIVERED` 表示唤醒消息已投递/入队，不代表猫猫的工作完成；展示为「已触发」。`RUN_FAILED` 为「触发失败」，`SKIP_MISSED_WINDOW` 为「错过时间」，其他 `SKIP_*` 为跳过，保留原始原因。任务是否正在执行仍以原生 invocation 为准。

enabled 与 effectiveEnabled 分开：用户启用但被全局暂停/治理规则挡住时标为「暂不可触发」，不能显示成已运行。已过期的一次任务不能恢复，重新创建即可。删除/暂停只阻止后续触发，不取消已入队或已开始的执行。

## 交互边界

- 列表、新建、记录都有明确的加载、空态和请求错误；失败不能渲染成空列表或成功。
- 创建成功后的刷新失败单独显示，不能把它当创建失败重提。保存时防重复点击；网络结果不明时提示先刷新核对。服务端透传原生错误。
- 删除用现有确认交互；处理跨猫切换、关闭抽屉、重绘和异步响应失效，不能修改另一只猫的界面。
- 列表标明「当前聊天」或「创建时的聊天」。旧聊天结果可通过带 thread 参数的原生运行面板查看，不能声称会发送到新聊天。
- 表单说明运行时及电脑需要在线；离线错过的一次任务不会补跑。不会后台通知或发手机推送。
- 不增加未实现的编辑、立即执行、任意 cron、高级治理或群聊任务控件。

## 原生边界

复用 `reminder` 模板及 `/api/schedule/tasks` 创建、列表、启停、删除、runs API。成员 ID、投递线程和触发者由服务端及原生会话绑定，不接受浏览器传入。仅管理 `dyn-*`、reminder 模板且目标成员吻合的记录，排除内置调度和 hold-ball 系统唤醒。

外部补丁补充原生列表中的模板、目标成员和提醒正文，以及 owner 创建时可选的持久化幂等身份。Bot 创建的一次任务结束或错过后保留为 disabled 记录，原生账本按绑定线程查询，过期不能恢复；其他原生任务保持原有退役规则。不增加第二套调度器或任务存储。旧运行时缺少列表能力标志时明确要求重新准备运行时，不能悄悄返回空列表。

Bot reminder 通过原生 `deliverVisibleWithPrivateInput` 原子保存触发记录并将完整正文交给目标猫。只写 hidden system History 虽然能唤醒 Agent，却不会把正文放入模型上下文；因此不能以账本 `RUN_DELIVERED` 作为全文投递的唯一验收依据。该处理限定在 Bot 创建的 `dyn-bot-*` reminder，保留原生 owner 身份、队列准入与权限策略。

原生列表另带 `botSchedulerReady`，创建和恢复需要调度器真正启动。Bot 启动模式先启动核心调度器、安装关闭处理器，再等待可选插件激活；插件校验照常执行。

## 可重复验证

- `npm run test:schedules-native`：真实 SQLite、定时器、原生路由和重启恢复；覆盖幂等、归属、暂停、离线错过、失败记录、过期拒绝恢复和完整正文投递。
- `BOT_SCHEDULES_HTTP_URL=http://127.0.0.1:13210 npm run test:schedules-http`：仅对隔离验收实例运行；创建验收猫、计划并实际调用本地 Codex，必须收到正文中的随机标记才算通过。会保留验收猫、聊天与一次任务记录，证据写入 `.runtime/schedules-acceptance/http-evidence.json`；周期测试计划会删除。
- 真实模型验收已通过：2026-11-04 01:53 UTC 的一次任务收到 `SCHEDULE_OK_2287e84a`。原生回归 7 项及相关上游回归 69 项通过。此结果验证 Codex 路径，不代表所有 CLI 或外部插件均已实测。
- 最终 Bot 回归 132 项通过，2 项需单独开启的原生集成测试跳过；构建、前端来源校验和 upstream 校验通过。浏览器验证了表单校验、每周创建、暂停/恢复、删除确认及取消、跨猫切换、真实触发记录和绑定聊天链接。隔离验收中的每周计划保留为暂停；界面证据见 `output/playwright/schedules-delivered.png`。
