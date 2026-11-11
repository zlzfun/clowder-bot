# XBot 兼容层范围

UI 保留 Bot 名称和文件夹概念，实际成员、执行和历史以 Clowder AI ID 为准。

| XBot 行为 | 原生映射 |
| --- | --- |
| Bot 创建/职责/重命名/删除 | `/api/cats`；删除成员保留原生历史 |
| 首次启动与只填名字建猫 | `GET /start` 把原生 Agent 检测说成「能不能直接开聊」；`POST /bots` 的 `simple` 用原生默认值建猫，见下文「开箱即用」 |
| 本地 Agent 接入 | `/agents` 原生发现；`/bots/:name/agent` 绑定执行者并恢复原生默认继承 |
| 单聊/新会话 | 原生 Thread，preferredCats 为该成员；新建保留旧会话 |
| 首次单聊的问候 | `POST /xbot-api/bots/:name/greeting` 以 `expectedThreadId` 绑定已打开的单聊，向这只猫发起一次普通的原生聊天请求 |
| 群聊 | 原生 Thread，preferredCats 为显式成员；消息路由保持原生；不填名字时以成员名命名。`PATCH /groups/:id {name?, members?}` 改原生标题与 preferredCats；要移出的猫在群里还有进行中或排队的事时 409，不替用户停止 |
| 找聊过的话 | `GET /search?q=` 当场读取每个会话最新一页原生消息并按聊天里的可见口径过滤，见下文「搜索」 |
| 发消息/回复引用 | `/api/messages`，原生 ID 与幂等键 |
| 历史/导出 | 原生消息；主界面最近 200 条，导出完整分页 |
| 状态/停止 | 原生 queue、activeInvocations、withdraw、cancel；单成员取消不取消兄弟任务 |
| 笔记 | 原生 `/api/memory` 会话 KV；旧 shared/bot scope 明确拒绝 |
| 上下文压缩 | 原生 compact-native；工具不支持时保留原生错误 |
| 定时任务 | 每猫 `/bots/:name/routines` 映射原生 reminder 模板及 schedule/tasks；创建、启停、删除、触发记录见 [接口说明](schedules-api.md) |
| 头像/文件夹/置顶 | Bot presentation store |

运行面板补充原生队列、会话链、原生消息分页、记忆 catalog/search、Agent 与审批。F306 question/approval/elicitation 使用原生 revision、cardRef、operationId；其他支持内联操作的审批按原生 manifest 转发。需要完整原生会话卡片的交互不会自动批准。

## 开箱即用

`GET /xbot-api/start[?refresh=1]` 是原生 `/api/cats/native-runtimes` 检测结果的一句话版本，只读，不安装、不登录、不调用模型：

- `ready`、`agent {id, label, confirmed}`：新猫默认会用的本机 Agent。规则与旧的隐式选择相同：先取有登录记录（`configured`）的，其次是已安装且适配层能绑定的；`confirmed: false` 表示装了但没能确认登录。
- `blocked`：`null`、`login_required`（有装好但需要登录的）或 `no_agent`。
- `agents[]`：适配层能绑定的那几种（Codex、Claude Code、Kimi）各自的 `state`：`ready`、`unknown`、`login`、`missing`，以及原生给出的 `loginCommand`。
- `cats`：现有猫的数量。

`POST /xbot-api/bots` 增加第三种请求体 `{name, simple: {face?, about?, agent?}, idempotencyKey}`：

- 只调用**未打补丁的上游** `POST /api/cats`（固定版本 `42017e0` 的 `routes/cats.ts`），与历史上的 fork／导入路径是同一个原生接口；不经过本地补丁 P005 的 `/api/bot-cat-templates/instantiate`。带 `catConfig` 的完整创建仍走 P005，那是待退出的历史补丁，不因这个流程而扩展。
- 请求体只有成员本身的字段：`catId`、名字与别名、所选猫脸对应角色模板的颜色、职责／性格／简介、`clientId`、`configurationSource: 'native_tool'`、`defaultModel: ''`。模型与推理强度不写，沿用该 Agent 的本机默认。不传 `breedId`，由原生按新成员处理；头像只存在 Bot 的展示数据里。
- Agent 取 `simple.agent` 或上面的默认。`face` 只决定头像和颜色（八张猫脸之一；不选时按 Agent 取对应的那张）。`about` 是用户写的一句用途，成为职责与简介；不写时用一段通用的「随叫随到的伙伴」职责。
- 幂等用上游成员创建自带的请求身份：请求头 `x-cat-cafe-onboarding-journey: clowder-bot-simple` 与 `idempotency-key: onboarding:clowder-bot-simple:cat:<idempotencyKey>`（`config/member-create-receipt.ts`）。`catId` 由 `idempotencyKey` 推导，所以同一个键、同样的内容重发得到同一只猫；同一个键换了内容由原生拒绝（409）。重发时如果那只猫已经在，就不再按当前的 Agent 检测结果拦截。这一路径 2026-11-11 在隔离运行时上实测过创建、重放和冲突。
- 必须带 `idempotencyKey`；不能与 `catConfig`、`runtimeId`、`templateId`、`persona`、`description` 混用。没有可用 Agent 时 422，说明要先装好并登录；同名 409。

`POST /xbot-api/groups` 带 `members` 时 `name` 可省略，群名取成员名用「、」连接（超过 64 字截断），之后可改名。群名是原生 Thread 标题，按自由文本校验；不带 `members` 时同一路由仍是建侧栏分组，分组名沿用原来的字符限制。

## 搜索

`GET /xbot-api/search?q=<1–100 字>` 返回 `{query, results[], more, searched, failed}`。每条结果是 `{chat:{type:'bot'|'group', id, name}, threadId, current, messageId, time, from:'owner'|'cat', catName?, snippet, match:[起,止]}`，按时间从新到旧，最多 30 条。

- 范围是用户自己的会话：每只猫当前的对话和它的历史对话（`current:false`，需要先从历史对话里打开）、所有群聊；各取最新一页（200 条）原生消息，搜索时当场读取，不建索引、不留副本。
- 可见口径与聊天一致：用户消息（应用代发的开场邀请除外）和可见的猫回复；草稿、处理中、`SILENT`、被显式发言取代的执行记录不算，匹配的是去掉署名后的显示文字，不区分大小写。
- `more` 表示还有没返回的匹配，或有会话存在更早、这次没看的消息；`failed` 是没能读取的会话数，前端要如实说明，不当作「没有结果」。
- 固定上游自带的消息检索（`/api/evidence/search?resultUnit=message`）依赖证据索引，2026-11-11 在隔离运行时和现有实例上实测都返回空（`passages_count: 0`，未配置嵌入模型），所以这里没有用它；索引可用后可以改为调用原生检索，接口形状不变。

问候复用固定版本 `42017e0c` 的 `POST /api/messages`。原生身份上下文包含猫名、角色说明与性格（`assets/prompt-templates/s1-identity.md`）。适配层指定单个成员、`next_work` 与同一猫和会话的稳定幂等键。首次请求先检查原生历史和队列，已有对话返回 `exists`。检查与准入是两个操作，并发到达的用户消息由原生队列决定顺序。创建猫和读取历史各自独立，生成失败时猫仍可正常聊天。

开场时，人设只影响问候的语气。普通昵称、意象和含义不明的名字以问好收尾。只有名字本身直接表达了一件要做的事，猫才顺着问一句，让用户自己说明想从哪里开始。

接口收到原生邀请记录的 ID 后返回 `accepted`。猫的实际回复和执行失败从历史及活动接口读取。等待回执时，Bot 记录邀请措辞的版本，保证升级后的重试仍用原键和原文。收到回执后只保留原生消息 ID，聊天页据此收起应用代发的邀请。原生历史与导出保留原文。若传输中断而未确认回执，`transcript.greeting.status` 为 `unconfirmed`，由用户显式重试。

`transcript` 为兼容 XBot 渲染器生成的投影，包含原生消息对象和 `native_message_id`。显示用 `send_message_to_user` 行带 `presentation_receipt: true`，不可计入模型工具调用/成本。真实工具轨迹来自 `toolEvents`。Bot 不自行估算或编造 Token。

回复进行中的呈现见 [回复的实时呈现：接口约定](chat-live-api.md)：同一条 SSE 在原生事件之后追加精简的 `live` 事件（开始、思考、步骤、正文增量、结束），会话行用 `in_progress` 标出还在写的回复，不再用占位文字；紧跟在问题后面的回复不重复引用上一句。

单聊与群聊的显示正文省去回复末尾的猫爪署名。固定上游 `42017e0` 的 `extra.outputLayout.hostTail` 提供署名范围，适配器核对线程、成员、轮次与正文长度及 SHA-256 后裁掉该范围。有范围但验证失败时保留原文。没有范围的旧记录，只识别 Markdown 代码围栏之外、末尾独占一行的 `[名字/模型🐾]` 或 `[名字🐾]`。用户消息、原生 `native` 对象和历史导出保留原文，新回复与历史读取共用这个展示转换。

单聊与群聊消息包含 `presentation_kind: "message" | "activity"`、`native_cat_id` 和 `speaker`（真实发送成员的 ID、名称和头像元数据；成员不可用时为 null）。只有当前返回页存在同一成员、同一原生 turn 的显式 callback 发言，才将对应 stream 累计记录投影为 `activity`；它不再生成聊天发送回执。前端将其显示为默认折叠的执行过程，正式发言保持原生顺序与各自时间戳。关联依赖精确执行身份，不用文本、时间接近程度或跨成员共享的外层 invocation ID 推断。错误、取消和缺少关联证据的回复继续作为普通消息；跨分页的关联暂不推断。该投影不修改或删除原生历史。

未迁移的跨设备、云账号、语音、应用、完整 skills/plugins 配置返回 supported=false 或明确 4xx/501。定时任务首版提供单猫创建、查看、启停和删除，尚不提供编辑已有计划、手动立即触发和高级调度治理。资料导入里的旧 XBot routines 格式仍拒绝，以免绕过原生计划校验。未读数量目前尚未从原生 read cursor 完整映射，不应将列表零值用于业务统计。

旧 `/models`、`/providers`、`/providers/*`、`/setup/key`、`/bots/:name/binding` 已退役为 410。Bot 新建和更新不再接受模型配置；更换 Agent 走专用绑定接口，避免普通资料更新意外改变接入。原生管理 API 中的账号能力不随 XBot 旧逻辑删除。
