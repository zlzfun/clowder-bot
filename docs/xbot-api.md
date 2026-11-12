# XBot 兼容层范围

UI 保留 Bot 名称和文件夹概念，实际成员、执行和历史以 Clowder AI ID 为准。

| XBot 行为 | 原生映射 |
| --- | --- |
| Bot 创建/职责/重命名/删除 | `/api/cats`；删除成员保留原生历史 |
| 首次启动与只填名字建猫 | `GET /start` 把原生 Agent 检测说成「能不能直接开聊」；`POST /bots` 的 `simple` 用原生默认值建猫，见下文「开箱即用」 |
| 本地 Agent 接入 | `/agents` 原生发现；`/bots/:name/agent` 绑定执行者并恢复原生默认继承 |
| 单聊/新会话 | 原生 Thread，preferredCats 为该成员；新建保留旧会话 |
| 首次单聊的问候 | `POST /xbot-api/bots/:name/greeting` 以 `expectedThreadId` 绑定已打开的单聊，向这只猫发起一次普通的原生聊天请求 |
| 群聊 | 原生 Thread，preferredCats 为显式成员；消息路由保持原生；不填名字时以成员名命名。`PATCH /groups/:id {name?, add?, remove?}` 改原生标题与 preferredCats：`add`／`remove` 是猫的名字，表达「加谁、移出谁」，由适配层读出原生当前的成员后套用（已在群里的不重复加，不在的移出不算错），同一个群的修改在 Bot 进程内逐个执行，所以页面上的名单过期也不会把别处刚做的修改抹掉；结果少于 2 只或多于 10 只时 400。仍接受整份名单 `members`（与 `add`／`remove` 不能同时用），它按字面覆盖，只适合确知名单是最新的调用方。要移出的猫在群里还有进行中或排队的事时 409，不替用户停止。原生没有带版本条件的成员修改，另一个不经过 Bot 的写入方（例如运行面板）与之并发时仍以后写为准 |
| 找聊过的话 | `GET /search?q=` 当场读取每个会话最新一页原生消息并按聊天里的可见口径过滤，见下文「搜索」 |
| 发消息/回复引用 | `/api/messages`，原生 ID 与幂等键 |
| 历史/导出 | 原生消息；主界面最近 200 条，导出完整分页。单聊 `transcript` 与群聊 `GET /groups/:id` 都返回 `hasMore` 和上一页的游标 `before`，带 `?before=` 读更早的一页 |
| 新对话 | `POST /bots/:name/new`：原生新建一个 Thread，旧对话留在历史对话里；可带 `{expectedThreadId}`（页面正在显示的对话），与当前对话不一致时 409，不新建 |
| 状态/停止 | 原生 queue、activeInvocations、withdraw、cancel；单成员取消不取消兄弟任务 |
| 笔记 | 原生 `/api/memory` 会话 KV；旧 shared/bot scope 明确拒绝 |
| 上下文压缩 | 原生 compact-native；工具不支持时保留原生错误 |
| 定时任务 | 每猫 `/bots/:name/routines` 映射原生 reminder 模板及 schedule/tasks；创建、启停、删除、触发记录见 [接口说明](schedules-api.md) |
| 头像/文件夹/置顶 | Bot presentation store |
| 每只猫的强调色 | `bots[].accent {primary, secondary}` 取自原生成员的 `color`（只在两个值都是 `#rrggbb` 时下发），供聊天里做低调的强调色 |

运行面板补充原生队列、会话链、原生消息分页、记忆 catalog/search、Agent 与审批。F306 question/approval/elicitation 使用原生 revision、cardRef、operationId；其他支持内联操作的审批按原生 manifest 转发。需要完整原生会话卡片的交互不会自动批准。

## 开箱即用

`GET /xbot-api/start[?refresh=1]` 是原生 `/api/cats/native-runtimes` 检测结果的一句话版本，只读，不安装、不登录、不调用模型：

- `ready`、`agent {id, label, confirmed}`：新猫默认会用的本机 Agent。规则与旧的隐式选择相同：先取有登录记录（`configured`）的，其次是已安装且适配层能绑定的；`confirmed: false` 表示装了但没能确认登录。
- `blocked`：`null`、`login_required`（有装好但需要登录的）或 `no_agent`。
- `agents[]`：适配层能绑定的那几种（Codex、Claude Code、Kimi）各自的 `state`：`ready`、`unknown`、`login`、`missing`，以及原生给出的 `loginCommand`。
- `cats`：现有猫的数量。
- `faces[]`：可以选的猫脸，各带它在引擎里的同名模板的画像和它用的工具：`{id, rev, name?, nickname?, role?, personality?, strengths?, tool}`。
  - 画像来自未打补丁的上游 `GET /api/cat-templates` 的 `roleDescription`／`personality`／`teamStrengths`，各压成一行并截断；`rev` 随画像内容变化，建猫时带回（见下）。`name` 是上游模板的叫法（布偶猫、小鲸鱼…），`nickname` 是模板给这只猫起的名字（宪宪、鲸鲸…），可以作为建议的名字。挑哪张脸，建出来的猫就以这份画像起步，所以首屏和新建猫猫要把它的特点简短地说出来。
  - `tool {label, state, usable, id?, reason?, loginCommand?}`：**这只猫用哪个工具思考是模板的一部分**（使用者 2026-11-12 指出：选了暹罗猫还能在下拉里挑 Codex 不合理）。`usable` 为真时可以按这张脸原样建猫，`id` 是它会绑定的本机工具；否则 `reason` 用一句话说为什么（「这台电脑上还没有装 Kimi」「这个应用还接不上 AGY Native」「Codex 还没有登录」），`state` 是 `ready`／`unknown`（装了，登录没能确认，可以试）／`login`／`missing`／`unsupported`。应用接不上的工具先说接不上：装上也不会变。
  - 脸和工具的对应来自固定上游 `cat-template.json` 的猫种配置（`breeds[].variants` 的默认项）：布偶猫 Claude、缅因猫 Codex、暹罗猫 Gemini（AGY）、梵花猫 Kimi、狸花猫与金渐层 OpenCode、孟加拉猫 Antigravity；小鲸鱼是 DSH 运行时的猫。上游的模板接口自己注明是「纯灵魂层，不含 client/model 绑定」，没有受支持的接口给出这层对应，所以放在适配层的 `faceTools`（`server/native/agents.ts`）里，由 `tests/face-tools.test.ts` 对着固定上游的文件核对。适配层目前能接的只有 Claude Code、Codex、Kimi 三种（`supportsRuntime`），所以在只装了前两种的电脑上，能按模板建的是布偶猫和缅因猫，其余的脸只能「自定义」借长相。
  - 顺序是引擎模板的顺序（也是客户端头像库的顺序）；引擎没有对应模板的脸不在其中，模板缺颜色（建猫会被拒绝）的也不在其中；模板读不到时是空数组，首屏其余内容照常。引擎用 ACP 跑的成员在工具检测里以 `acp:<成员>` 出现，按它的 client 归到对应的脸上（只影响怎么称呼这个工具，这类接入应用仍然接不上）。

`POST /xbot-api/bots` 增加第三种请求体 `{name, simple: {face?, rev?, custom?, about?, personality?, agent?}, idempotencyKey}`：

- 只调用**未打补丁的上游** `POST /api/cats`（固定版本 `42017e0` 的 `routes/cats.ts`），与历史上的 fork／导入路径是同一个原生接口；不经过本地补丁 P005 的 `/api/bot-cat-templates/instantiate`。带 `catConfig` 的完整创建仍走 P005，那是待退出的历史补丁，不因这个流程而扩展。
- 请求体只有成员本身的字段：`catId`、名字与别名、所选猫脸对应角色模板的颜色、职责／性格／简介、`clientId`、`configurationSource: 'native_tool'`、`defaultModel: ''`。模型与推理强度不写，沿用该 Agent 的本机默认。不传 `breedId`，由原生按新成员处理；头像只存在 Bot 的展示数据里。
- `face` 是八张猫脸之一，决定头像和颜色，**也决定这只猫是谁、用什么工具**：默认按模板建，职责、性格、擅长取引擎里同名模板的原文（与 `faces[]` 里给界面看的是同一份），工具是这张脸自己的（`faces[].tool`），不另选。模板里没写的项用通用的「随叫随到的伙伴」补上。
  - 这张脸的工具在这台电脑上用不了时，创建在询问原生之前被拒绝：422，`code: 'face_unavailable'`，原因就是 `tool.reason`，并说明怎么办（没装的：装好再试或改用自定义；接不上的：改用自定义；没登录的：登录后再试）。
  - 按模板建时 `simple.agent` 可以不带；带了而且不是这张脸的工具，422，`code: 'face_tool'`（「这只猫猫用 Claude Code 来思考，不能另选；想自己选，请用「自定义」」）。
  - 不带 `face`：取 `simple.agent`（没有就取上面的默认工具）对应的那只猫——Claude Code 是布偶猫，Codex 是缅因猫，Kimi 是梵花猫。
- 自定义（不按模板）：带 `custom: true`，或者写了自己的话（`about` 一句用途，成为职责与简介；`personality` 性格，≤500 字）。这时猫脸只是外观，任何一张脸都可以配这台电脑上能用的工具：`simple.agent` 指定，不带就用默认的那个；没写的项用通用的「随叫随到的伙伴」和「亲切耐心，讲得清楚」。2026-11-12 之前只填名字建的猫都是这份通用画像，不受这次改动影响。
- 建出来的就是看到的那只：按模板建时带上 `faces[]` 里这张脸的 `rev`。引擎里这份画像在页面读取之后变了，创建会在询问原生之前被拒绝（409，`code: 'face_changed'`），页面应重新读取 `/start`、让用户再看一眼。不带 `rev` 时按当前模板建。自定义不受它影响。
- 模板读不到（或这张脸没有可用的模板和颜色）时创建被拒绝：503，`code: 'faces_unavailable'`，「暂时读不到猫猫的资料，这次没有创建」。这时还没有向原生发出任何创建请求，所以不是「结果不明」；自定义也需要模板里的颜色，同样建不了。
- 重发（应答丢了，同一个键、同样的内容再来一次）按已知的事实回答：
  - 本进程里记得这次请求：把第一次解析出来的原生请求原样重放（工具、模板当时的原文都不重新解析），所以即使模板在两次之间变了，原生看到的仍是同一个请求。这份对应关系只留在进程内存里（最近 50 个），不写入展示数据。
  - 上一次什么都没建出来、而当时解析到的工具现在用不了了：按现在的情况重新解析，不会在一个已经不在的工具上建猫。
  - 进程重启过、不记得这次请求，但这个键建出的那只猫已经在（`catId` 由键推导）：直接回答这只猫，不再向原生发创建，也不按现在的模板和工具重新解析——不会对一只已经建好的猫说「没有创建」或「介绍变了」。能从猫身上核对的（名字、脸、工具、自定义时写的话）与请求不符时，按「不是同一个请求」拒绝（409）。
  - 同一个键换了内容，而原来那次已经建出了猫：409，不再询问原生。同样的请求同时到达两次，只解析一次，两次到达原生的是同一份内容。
- 上游的模板接口不校验条目，适配层读取时只保留格式正确的字段：不是对象、没有 `id` 的条目跳过，类型不对的字段当作没写。
- 上游有几个模板的职责本来就写着它用的模型或工具（狸花猫「GLM 对话猫」、孟加拉猫「混血多模型 agent…」、金渐层「开源多模型编码 agent…」）。现在按模板建的猫用的就是模板自己的工具，这些话与事实一致；它们的工具这个应用还接不上，所以这几张脸目前只能自定义。模型本身不写进成员（`defaultModel: ''`），沿用那个工具在本机的默认配置。
- 幂等用上游成员创建自带的请求身份：请求头 `x-cat-cafe-onboarding-journey: clowder-bot-simple` 与 `idempotency-key: onboarding:clowder-bot-simple:cat:<idempotencyKey>`（`config/member-create-receipt.ts`）。`catId` 由 `idempotencyKey` 推导，所以同一个键、同样的内容重发得到同一只猫；同一个键换了内容由原生拒绝（409）。重发时如果那只猫已经在，就不再按当前的 Agent 检测结果拦截。这一路径 2026-11-11 在隔离运行时上实测过创建、重放和冲突。
- 绑定 Claude Code 的猫，成员记录里带一组默认的「额外 CLI 参数」（上游成员编辑里的 `cliConfigArgs`，受支持的成员级设置）：`--settings {"skillOverrides":{"schedule":"off","loop":"off"}} --disallowedTools RemoteTrigger,CronCreate,CronDelete,CronList`，关掉 CLI 自带的云端定时，让「每天 9 点提醒我」走引擎的定时工具和它的确认。Codex 没有自带定时，不写参数。它是成员建好之后单独的一步（`PATCH /api/cats/:id {expectedRevision, cliConfigArgs}`），三种创建方式都一样；创建请求本身不带这组参数，形状始终是原生按幂等键记下的那个，所以默认值以后怎么变，重发旧请求都不会被当成「内容不同」。成员已有参数时不动（包括用户后来自己改的）；写入被拒绝时按成员当前的版本再试一次，仍不成功则猫照常建好，应答多带一句 `notice` 说明少了什么、去哪里补，不把它说成完全建好。`PUT /bots/:name/agent` 换 Agent 时在同一次修改里写入。设置 JSON 里不能有空白：上游按空白切分参数。只影响此后新建或重新绑定的猫，已有的猫不改。
- 必须带 `idempotencyKey`；不能与 `catConfig`、`runtimeId`、`templateId`、`persona`、`description` 混用。没有可用的工具时 422，说明要先装好并登录；同名 409。

`POST /xbot-api/groups` 带 `members` 时 `name` 可省略，群名取成员名用「、」连接（超过 64 字截断），之后可改名。可带 `idempotencyKey`（UUID）：它同时是群目录的名字和原生 Thread 创建的幂等键，应答丢失后用同一个键重发得到同一个群，不会建出第二个：这个键已经建过群时，适配层直接返回那个群现在的样子（200），不再把创建请求发给原生——原生对重复的键会返回同一个 Thread，但会把请求里的成员再写一遍（固定上游 `routes/threads.ts`），那样会把之后改过的成员改回去，也绕过了改成员时「还在忙的不能移出」的检查。群名是原生 Thread 标题，按自由文本校验；不带 `members` 时同一路由仍是建侧栏分组，分组名沿用原来的字符限制。

## 搜索

`GET /xbot-api/search?q=<1–100 字>` 返回 `{query, results[], more, searched, failed}`。每条结果是 `{chat:{type:'bot'|'group', id, name}, threadId, current, messageId, time, from:'owner'|'cat', catName?, snippet, match:[起,止]}`，按时间从新到旧，最多 30 条。

- 范围是用户自己的会话：每只猫当前的对话和它的历史对话（`current:false`，需要先从历史对话里打开）、所有群聊；各取最新一页（200 条）原生消息，搜索时当场读取，不建索引、不留副本。
- 可见口径与聊天一致：用户消息（应用代发的开场邀请除外）和可见的猫回复；草稿、处理中、`SILENT`、被显式发言取代的执行记录不算，匹配的是去掉署名后的显示文字，不区分大小写。
- 猫的回复按显示出来的文字匹配和摘录：标题、列表、引用、表格、粗体、行内代码、链接地址这些 Markdown 记号不出现在 `snippet` 里（`server/native/text.ts` 的 `plainLine`），`match` 指向去掉记号后的位置；只在带记号的原文里才匹配得上的词（例如搜 `` `npm ci` ``）按原文摘录。用户自己打的字不改。会话列表的预览行 `activity.last.text` 用同一规则。
- `GET /xbot-api/bots/:name/search?q=` 与 `GET /xbot-api/groups/:id/search?q=` 是同一个搜索，只看这一个聊天当前的对话，返回形状相同；用于「在这个聊天里找」，不会被别的聊天的结果挤掉。
- `more` 表示还有没返回的匹配，或有会话存在更早、这次没看的消息；`failed` 是没能读取的会话数，前端要如实说明，不当作「没有结果」。
- 固定上游自带的消息检索（`/api/evidence/search?resultUnit=message`）依赖证据索引，2026-11-11 在隔离运行时和现有实例上实测都返回空（`passages_count: 0`，未配置嵌入模型），所以这里没有用它；索引可用后可以改为调用原生检索，接口形状不变。

问候复用固定版本 `42017e0c` 的 `POST /api/messages`。原生身份上下文包含猫名、角色说明与性格（`assets/prompt-templates/s1-identity.md`）。适配层指定单个成员、`next_work` 与同一猫和会话的稳定幂等键。首次请求先检查原生历史和队列，已有对话返回 `exists`。检查与准入是两个操作，并发到达的用户消息由原生队列决定顺序。创建猫和读取历史各自独立，生成失败时猫仍可正常聊天。

开场时，人设只影响问候的语气。普通昵称、意象和含义不明的名字以问好收尾。只有名字本身直接表达了一件要做的事，猫才顺着问一句，让用户自己说明想从哪里开始。

接口收到原生邀请记录的 ID 后返回 `accepted`。猫的实际回复和执行失败从历史及活动接口读取。等待回执时，Bot 记录邀请措辞的版本，保证升级后的重试仍用原键和原文。收到回执后只保留原生消息 ID，聊天页据此收起应用代发的邀请。原生历史与导出保留原文。若传输中断而未确认回执，`transcript.greeting.status` 为 `unconfirmed`，由用户显式重试。

`transcript` 为兼容 XBot 渲染器生成的投影，包含原生消息对象和 `native_message_id`。显示用 `send_message_to_user` 行带 `presentation_receipt: true`，不可计入模型工具调用/成本。真实工具轨迹来自 `toolEvents`。Bot 不自行估算或编造 Token。

回复进行中的呈现见 [回复的实时呈现：接口约定](chat-live-api.md)：同一条 SSE 在原生事件之后追加精简的 `live` 事件（开始、思考、步骤、正文增量、结束），会话行用 `in_progress` 标出还在写的回复，不再用占位文字；紧跟在问题后面的回复不重复引用上一句。

单聊与群聊的显示正文省去回复末尾的猫爪署名。固定上游 `42017e0` 的 `extra.outputLayout.hostTail` 提供署名范围，适配器核对线程、成员、轮次与正文长度及 SHA-256 后裁掉该范围。有范围但验证失败时保留原文。没有范围的旧记录，只识别 Markdown 代码围栏之外、末尾独占一行的 `[名字/模型🐾]` 或 `[名字🐾]`。有的模型把署名写在回复开头（真实群聊里出现过「[快手/Haiku🐾]」独占第一行、正文在后面）：署名里的名字就是发言的这只猫、且后面还有正文时，开头这一段也不显示；别的猫的署名、不在开头的都保留。用户消息、原生 `native` 对象和历史导出保留原文，新回复与历史读取共用这个展示转换。

单聊与群聊消息包含 `presentation_kind: "message" | "activity"`、`native_cat_id` 和 `speaker`（真实发送成员的 ID、名称和头像元数据；成员不可用时为 null）。只有当前返回页存在同一成员、同一原生 turn 的显式 callback 发言，才将对应 stream 累计记录投影为 `activity`；它不再生成聊天发送回执。前端将其显示为默认折叠的执行过程，正式发言保持原生顺序与各自时间戳。关联依赖精确执行身份，不用文本、时间接近程度或跨成员共享的外层 invocation ID 推断。错误、取消和缺少关联证据的回复继续作为普通消息；跨分页的关联暂不推断。该投影不修改或删除原生历史。

未迁移的跨设备、云账号、语音、应用、完整 skills/plugins 配置返回 supported=false 或明确 4xx/501。定时任务首版提供单猫创建、查看、启停和删除，尚不提供编辑已有计划、手动立即触发和高级调度治理。资料导入里的旧 XBot routines 格式仍拒绝，以免绕过原生计划校验。未读数量目前尚未从原生 read cursor 完整映射，不应将列表零值用于业务统计。

旧 `/models`、`/providers`、`/providers/*`、`/setup/key`、`/bots/:name/binding` 已退役为 410。Bot 新建和更新不再接受模型配置；更换 Agent 走专用绑定接口，避免普通资料更新意外改变接入。原生管理 API 中的账号能力不随 XBot 旧逻辑删除。
