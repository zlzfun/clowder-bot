# XBot 原版前端接入

Clowder Bot 的前端复用 XBot 的静态页面与浏览器脚本，保留其布局和交互。后端直接运行固定版本的 Clowder AI 原生代码，通过 `/xbot-api/` 兼容路由提供数据。经头像样页选型后，应用采用原创 3D 猫猫头像及独立的猫咖配色覆盖层。

## 固定来源

- 仓库：<https://github.com/liu-zhengdong/xbot>
- 提交：`3b81c8efe55fee2606a9992203abd2e6082e08c4`
- 原始目录：`internal/web/static/`
- 页面：原 `index.html` 放入 `client/index.html`。
- 其余资源：按原相对路径放入 `client/public/`。
- 文件摘要：[xbot-frontend-manifest.json](./xbot-frontend-manifest.json)。逐文件记录原始 SHA-256、当前 SHA-256、目标位置与是否完全一致。

共保留 78 个上游文件。上游 CSS、字体、图片图标、KaTeX、头像生成器 `vendor/xbot-avatar.min.js` 及其依赖说明保持原始字节。原人像库保留为来源记录，页面改为加载本项目的 `cat-avatars.js`；猫咖颜色由新增 `cafe-theme.css` 覆盖，上游 CSS 不直接修改。

## 前端适配

1. `index.html` 在字符集元数据之后增加 `<meta name="application-name" content="clowder-bot">`。原始 DOM 结构、布局、样式引用及 classic script 顺序保留。
2. `app.js`、`account.js`、`apps.js`、`devices.js`、`image-gen.js`、`pairing.js`、`persona-cards.js`、`providers.js`、`remotechat.js`、`skills.js`、`sw.js`、`web-search.js` 中所有 `/api/` 路径前缀改为 `/xbot-api/`，与本项目原有 API 分离。本轮原生接入的进一步差异见第 7 项。
3. `app.js` 的 service worker 注册语句被一行说明注释替代，避免开发中的原版资源受到旧离线缓存影响。`sw.js` 本身仍随原资源保存，但页面不会注册它。
4. 按用户要求将可见品牌文案 `XBot` 改为 `clowder-bot`，覆盖页面与动态浏览器标题、关于页、设置/连接提示、PWA 名称和通知标题。仅替换文案；`window.XBot*` 模块名、API 路径、存储键、字体名、原始头像 seed 和来源署名保留，布局与交互不变。
5. 2026-10-31：按用户选定的 G 组接入 3D 玩偶猫猫头像。`cat-avatars.js` 以一张运行时图集 `/avatars/clay-cats.png` 渲染八个精确网格；模板 ID 和显式猫猫 seed 决定角色，原有上传图片优先。列表、聊天、群聊、详情和预设选择使用统一头像入口。
6. 在所有上游 CSS 后加载 `cafe-theme.css`，以奶油、燕麦、咖啡棕覆盖色彩 token，并补齐浅色/深色的必要局部颜色。启动脚本、PWA 及运行时浏览器主题色保持一致。布局、字体、动画和消息交互保持原有行为。

7. 原生引擎接入：`app.js` 增加 Socket.IO 转接 SSE 的状态刷新、排队状态、会话笔记说明；移除失败时模拟同伴消息。`index.html` 增加原生运行面板入口。新增 `runtime.html/css/js` 展示原生队列、会话、审批、账号（只读）和记忆；原始 CSS 继续保持原样。
8. 2026-10-31 本地 Agent 接入：Bot 的执行者是本机已安装/配置的 Agent（如 Codex、Claude Code），不再是模型供应商商店。
   - 新增 `agents.js`、`agents.css`：设置「本地 Agent」面板（只读检测、手动「重新检测」）、详情与编辑资料中的「执行 Agent」及「更换执行 Agent」弹层、新建 Bot 的 Agent 选择。只调用 `GET /xbot-api/agents[?refresh=1]` 与 `PUT /xbot-api/bots/:name/agent {runtimeId}`；新建 Bot 只发送 `runtimeId`，不发送模型。
   - `providers.js` 删除供应商目录、密钥与 OAuth 登录、模型拉取、厂商生图开关和模型绑定弹层，只保留消息里的搜索步骤与引用渲染。`app.js` 删除 `modelCatalog`/`modelHits`、模型绑定入口和首启「填写模型密钥」流程；`index.html` 删除对应的 `#setup` 表单，设置导航「模型与供应商」改为「本地 Agent」。
   - `image-gen.js`、`web-search.js` 改为只读说明：首屏即说明能力由本地 Agent 决定，读取接口只用于显示服务端说明及加载/错误态，并提供「查看本地 Agent」。原供应商选择、开关保存、搜索密钥探测等写入逻辑与辅助函数已删除，不保留备用路径；`image-gen.css`、`web-search.css` 原样保留。
   - `runtime.html/js` 移除「添加 API 账号」表单，原生检测与账号只读展示，并指回 Bot 设置。
   - 设计依据、文案与交互约束见 [本地 Agent 接入前端规范](frontend-agent-ui.md)；行为测试位于 `tests/frontend-agents.test.ts`。
9. 2026-11-02 消息呈现：按服务端 `presentation_kind`、`speaker`、`native_cat_id` 显示，不根据正文判断类型或发言者。
   - 新增 `chat-presentation.js`（在 `app.js` 之前加载）和 `chat-presentation.css`（在 `agents.css` 之后加载）。脚本对外提供 `window.ClowderPresentation`：按原生猫 ID 识别发言者；`activity` 行渲染为执行过程条目。
   - 单聊的猫回复改用群聊原有的头像与 `.who` 名字行，并沿用 `groupStart` 的连续消息规则：同一只猫五分钟内连发时，后续行不重复显示头像和名字，按群聊同样左缩进 32px。分组键是原生猫 ID，同名的不同猫不会合并；`speaker` 为 null（系统或未知）时显示中性几何头像，不借用当前 Bot 的脸。群聊的发言者、头像和 `[action]` 行也改用同一套身份规则。用户右侧气泡不变。旧流式入口的 `liveBubble` 显示本次所发往 Bot 的身份。
   - `activity` 是一次执行过程中持续累积的记录，不算回复。它按服务端顺序显示为折叠的 `routine-line`：xs 头像加「猫名 · 执行过程 · 状态」。状态取原生 lifecycle：进行中、已完成、失败、已停止、已中断，无法识别时显示「状态未知」。展开后用 Markdown 完整显示 `content`（群聊用 `text`），内容在第一次展开时才渲染。展开状态按消息 ID 记录，刷新后保持。它不进入 `spokenLines`、定时与后台回传判定，也不作左侧列表预览，同时会结束上方的气泡分组。
   - 重绘时如果用户不在底部，会以用户正在看的那一行（按 seq 或消息 ID 匹配）为锚点保持位置；即使上方已展开的执行过程变长，视图也不会跳动。在底部时仍跟随到底部。
   - 扩展 CSS 只有三条规则：单聊续行缩进、执行过程条目内头像 SVG 尺寸、失败状态使用 `--err`。不新增颜色、字体或动画，原 CSS 字节不变。测试位于 `tests/chat-presentation.test.ts`。
10. 2026-11-02 原生 Task：运行面板「会话与执行」在会话选择器下方新增「原生任务」，原执行视图前加小标题「执行、队列与记录」；会话选择器与原有交互不变，页头说明补上「任务」。
   - 新增 `runtime-tasks.js`（classic script，在 `runtime.js` 之前加载，对外提供 `window.ClowderTasks`）。只读取 `GET /native-api/api/tasks?threadId=<所选会话>` 和 `GET /native-api/api/cats`；不保存任务状态，不轮询、不排程。后续变化沿用面板现有的手动「刷新状态」和 SSE「原生状态有更新 · 点击刷新查看」提示。
   - 每个任务显示标题、负责成员名称、普通进度（`status`）、后台执行状态（`backgroundExecution.state`）、撤销或停止标记及其时间、停止的发起 Task（`backgroundStopOwnerTaskId` 不是自己时）和 `delegatedFromTaskId`（相关 Task 在同一列表时附标题）；原生 ID 与完整记录放在折叠的「原生 ID 与记录」里。成员名册读取失败时显示原生 ID；没有 owner 时写「尚无，等待原生认领」。负责成员只取自读取到的 Task。
   - 普通进度与后台执行分开显示。子执行完成不等于任务完成；没有 `backgroundExecution` 写「没有记录」，并注明不代表空闲；`starting`、`stopping` 以及已有停止标记（Task 的 `backgroundStopRequestedAt` 或记录自身的 `stopRequestedAt`）的进行中执行显示「…请求已提交」，只有原生 `stopped` 才显示「已停止」；无法识别的值写「状态未知」。不根据摘要或消息正文推断状态。
   - 历史记录：`backgroundExecution.ownerRevision` 与 Task 的 `ownerRevision` 不同，或 Task 有 `executionRef` 且其 `subexecutionId` 与记录的 `attemptId` 不同（包括没有 `subexecutionId`），这条记录就是历史。卡片的当前后台执行写「没有当前记录」（不代表空闲），另起一行「上次后台执行」写明它属于哪个 owner revision 或另一次执行、不是当前执行。历史记录不提供停止，它自身的 `stopRequestedAt` 也不算当前的停止标记。
   - 控制只调用 `POST /native-api/api/tasks/:id/background-control`，请求体为 `{action, expectedOwnerRevision: ownerRevision 或 0, expectedAttemptId: 最新读取到的 backgroundExecution.attemptId 或 null}`；即使记录已是历史也按原样传递，不改写。「停止此次后台执行」只在当前后台执行为 `starting`/`running` 且尚无停止标记时出现；「撤销整个任务」只用于普通 work Task（`kind` 为 `work`、`subjectKey` 为 null、没有 `entrustedWork`），且未完成、未撤销。
   - 停止和撤销都会留下停止标记，直到恢复才清除（撤销另记 `backgroundCancelledAt`）。有撤销时按钮为「恢复任务」，只有停止标记时为「允许继续」；两者都注明只解除禁止，不会自动重新开始执行，也不会撤回已经产生的外部影响。后台执行记录（无论当前还是历史）为 `starting`、`running`、`stopping` 或 `unknown` 时按钮不可用，等原生证明执行已结束（GET 会先对账）；没有后台记录但 `executionRef` 不是后台执行时，提示要由原生确认这次执行结束后才能恢复。只有当前记录已结束才不再附「这不代表已在进行的工作已经停止」的说明。
   - 请求进行中，该任务的所有控件禁用。应答中的 Task 立即重绘对应卡片，随后重新读取列表，因为停止和撤销都会影响所属子任务；重新读取失败时保留已显示的结果并提示。应答的 `unconfirmedTaskIds` 非空时，提示「停止请求已记录，部分执行尚未确认停止，请刷新查看」，其中每个子任务的卡片也注明尚未确认；没有后台执行的撤销只表示撤销意图。409 提示状态已变化或操作不适用（`task_assignment_changed`、`task_execution_stop_unproven`、`background_control_unavailable` 有中文说明，其他英文码用通用说明），404 提示接口或任务不存在，两者都会重新读取列表；其他失败只说明没能确认结果。任何失败都不会改用会话或成员的 cancel，也不 PATCH Task。恢复后提示需要继续时在聊天中给负责成员发送继续的消息。
   - 交接只对有 owner、普通且未完成的 Task 提供（与原生 Task 交接的前置条件一致）。目标下拉只列所选会话 `preferredCats` 中仍在成员名册内、且不是当前 owner 的成员。「请求交接」经 `POST /native-api/api/messages` 发送用户请求 `{threadId, mentions: [当前 owner], messageDisposition: 'continue_current', idempotencyKey, content}`，content 使用约定模板，标题压成一行。界面只显示「交接请求已提交」，负责成员始终取自读取到的 Task。同一目标失败后重试沿用同一幂等键，成功后作废；本卡片在下次读取前不再重复发送。未绑定后台执行的普通 Task 由主 Agent 先把状态改为 todo/blocked 再走原生交接，前端不新增操作。
   - `runtime.js`：`api()` 抛出的错误带 HTTP `status`。`refresh()` 中各原生读取独立结算：失败的视图显示自己的「没能读取」，审批与会话视图互不阻塞，`#error` 仍提示第一条失败。任务读取不依赖队列、会话和消息读取；旧后端返回 404 时只有任务区显示「暂不可用」。
   - 不新增 CSS，复用 `runtime.css` 的 `card`、`badge`、`actions`、`muted` 与 `details/pre`；结果提示使用 `role="status"`，所有原生文本经 `textContent` 输出。测试位于 `tests/runtime-tasks.test.ts`。
11. 2026-11-03 猫猫模板交互样页（评审用，未接入生产）：新增独立页面 `/template-lab/index.html`，文件在 `client/public/template-lab/`（`index.html`、`lab.css`、`model.js`、`lab.js`、`fixture.json`）。
   - 用户更正：第一版独立评审外壳「和当前的页面没有关系」；Agent 和模板应在设置里，新建猫猫仍从左侧顶端的 +。第二版因此直接复用当前外壳（`client/index.html` 的侧栏、pin 行、名单、我的菜单、顶栏、对话区、输入框、信息抽屉与完整 `#setpage` 导航，以及 `app.js` 中 `renderPinRow`/`toggleNewMenu`/`listButton`/`emptyState`/`paintGreeting` 的结构），删去教程页、独立按钮和侧栏主题/重置行。入口：pin 行末尾 +「新建」→「新建猫猫」；我 → 设置 → 模板 / 本地 Agent；样页主题与重置在 设置 → 通用；猫猫配置在顶栏名字打开的信息抽屉。示例猫猫没有会话或运行状态，输入框不发送、不生成回复。
   - 「人设卡」在样页中改称「模板」（Agent + 模型 + 可选 effort + 画像），放在原设置导航中人设卡的位置，其余设置项保持原顺序、只作占位；新建猫猫沿用 `.modal-card`。页面按顺序加载现有 `tokens.css`、`app.css`、`providers.css`、`web-search.css`、`skills.css`、`persona-cards.css`、`cafe-theme.css`、`agents.css` 与 `cat-avatars.js`，复用设置外壳、技能列表、人设卡编辑器、中性单选行、嵌套确认层和 3D 玩偶头像；`lab.css` 只补布局，只用 `--x-*` token，原 CSS 字节不变。
   - 只读取同目录 `fixture.json`（上游 `cat-template.json` 的只读字段子集与标明的示例 Agent 数据），不调用任何 Bot 或原生接口；状态只存在本标签页 `sessionStorage` 的 `clowder-template-lab:v1` 命名空间，不写 `xbot-*` 键。生产页面 `index.html`、`app.js`、`persona-cards.js` 未改动。
   - 设计决定、数据来源、评审路径与局限见 [猫猫模板交互样页](cat-templates-prototype.md)。
12. 2026-11-03 设置「本地 Agent」改为简洁列表 + 二级详情（用户反馈：去掉多余说明和引导文字；页面信息太密，参考截图改为列表、点入详情；不沿用截图的深色配色）。
   - `agents.js` 的 `settings()`：宿主类改为 `skills-settings agent-settings`，复用技能页的标题、工具栏、搜索、行、箭头、无匹配状态与返回链接。列表按 `installed` 分「已安装」「未安装」两组，每行为图标、名称、一行状态；详情是状态、接入的 Bot、本机默认三组键值行，加上默认收起的「检测详情」（命令、接入方式、登录命令、检测时间、Agent ID、运行面板入口）。删去页首说明和两段页脚说明，加载、空、错误状态改用短句。数据仍只来自 `GET /xbot-api/agents[?refresh=1]`，更换弹层和新建 Bot 的 Agent 字段不变。
   - `app.js`：打开「本地 Agent」时多传 `onLevel`，与技能、人设卡相同，详情页名称和「本地 Agent」返回显示在设置顶栏（手机端）。其余设置逻辑不变。
   - `agents.css`：新增的规则只覆盖列表/详情的间距、图标尺寸、键值行和「检测详情」折叠；Kimi 图标指向已有的 `provider-icons/kimi.svg`。旧的逐卡规则保留给模板评审样页。原 CSS 字节不变。
   - 文案与交互约束见 [本地 Agent 接入前端规范](frontend-agent-ui.md)，测试见 `tests/frontend-agents.test.ts`（分组与一行状态、搜索、详情与返回、事实分开不夸大、只在「重新检测」时刷新、加载/空/错误状态）。
13. 2026-11-03 猫猫模板正式接线（用户批准直接接正式前端，后端一并接通）。模板模块是新增扩展 `cat-template-rules.js`、`cat-templates.js`、`cat-templates.css`（另行开发，接口见 [cat-templates-api.md](cat-templates-api.md)）；本项只记录正式入口和资料页的接线。
   - `index.html`：设置导航 `data-set="persona"` 的内部 ID 和图标保留，显示名由「人设卡」改为「模板」；`rail-new` 的无障碍名改为「新建猫猫或群组」。脚本在 `skills.js` 之后、`app.js` 之前（头像模块 `cat-avatars.js` 之后）依次加载 `cat-template-rules.js`、`cat-templates.js`；`cat-templates.css` 排在 `cafe-theme.css`、`agents.css` 之后。不再加载 `persona-cards.js`，但原文件、来源摘要和 `persona-cards.css`（模板页沿用其 `pc-*` 编辑样式）保留。
   - `app.js` 设置：`persona` 面板改为挂载 `ClowderCatTemplates.mount({api, host, isCurrent, onLevel})`，`onLevel` 与技能、本地 Agent 相同，用于同步手机端设置顶栏的返回。回到设置首页、切换面板和关闭设置这三处，都由 `ClowderCatTemplates.teardown()` 取代原来的人设卡卸载。
   - `app.js` 新建：左上 pin 行「新建」和收起侧栏的 `rail-new` 共用的菜单项「新建 Bot」改为「新建猫猫」，`openNewBot(anchor)` 改为调用 `ClowderCatTemplates.openCreate({api, opener, names, manageAgents, onCreated, onError})`。
     - `opener` 是打开菜单的那个按钮，关闭弹层后焦点回到这里。
     - `names` 取当前名单，用于同名提示。
     - `manageAgents` 打开设置 · 本地 Agent；模块会先关闭自己的弹层。
     - `onCreated` 沿用 `refreshLists()` 和 `selectBot(name)`。
     - `onError` 只在创建之后刷新失败时显示状态。
     - 创建请求只由模块发送：`cat-templates.js` 的 `submit()` 在 `createBody` 之后附上稳定的 UUID `idempotencyKey`，同一请求重试复用同一个值。壳层不再 `POST /xbot-api/bots`。弹层只保留一个，Escape、Tab 和其余按键都在弹层内处理、不再冒泡；打开前先关闭菜单和原 `#modal`，所以设置、抽屉和原弹层不会被这次 Escape 关掉。
     - 原「新建 Bot」表单、头像换一张/上传和 `XBotAgents.field` 一并删除；头像随猫种决定，之后仍可在编辑资料里更换或上传。
   - `app.js` 编辑资料：删除「人设卡」小节，包括下拉框、「管理人设卡」入口、`GET /xbot-api/persona-cards`、`PUT /xbot-api/bots/:name/persona-card`，以及只给它用的抽屉代次计数。模板只在创建时复制一次，这里不再出现会持续绑定的控件。职责仍直接编辑，删去了指向人设卡的提示。资料 JSON 的「导出模板/导入模板」改名为「导出资料/导入资料」，行为不变。
   - `app.js` 信息抽屉：删除已经不会出现的人设卡小节（服务端 `persona_card` 恒为 `null`）。在「执行 Agent」后新增「配置」（`catConfigSection`），用模块的 `describe` 显示服务端 `cat_config` 的模型、推理强度、猫种。Agent 行和职责已有各自的小节，不重复显示。性格、擅长、提醒放在默认收起的「画像」里。不显示 `source_template`、修订号或内部 ID。
     - 猫种只显示能查到名称的 ID：`describe()` 只取目录里的名称，查不到时不出「猫种」行。抽屉的名称表也只收有名称的 ID。旧原生猫的合成猫种 ID（如 `bot-f4eb9bcb-844`）因此不会显示出来，也不会按头像推断；存储的 ID 不变。这是对 `cat-template-rules.js` 的小改，`tests/cat-templates.test.ts` 补了 ragdoll、moonshot、合成 ID、没有目录四种情况。
   - `index.html`：删除手机端设置首页的说明行「整台 clowder-bot 的共用选项。点开一项继续。」（`.setnavlead`），导航按钮和样式不变。
   - `agents.js`：
     - 执行 Agent 入口和更换弹层改用 `cat_config.effort` 判断猫猫自己的推理强度。弹层只在确认会清除原有接入、自己的模型或推理强度时，显示一句「确认后会清除…」，删去常驻的影响说明和登录提醒长句。
     - 无中文说明的 409 改为短句。「本机默认」读不到时只写「未读取到」。
     - 成功更换后，入口按 PUT 的约定把本地副本的推理强度置为跟随。
     - 删除 `field()` 及其样式（`.agent-field`、`.agent-choices`、`.agent-none`、`.agent-tools`），新增抽屉「画像」折叠内的一条间距规则。
   - 测试：`tests/frontend-agents.test.ts` 按新文案更新断言，新增两项。一项检查猫猫自己的推理强度会让「重新选当前 Agent」成为实际更换，并在之后显示已清除；另一项静态检查接线，覆盖导航名、脚本与样式顺序、三处卸载、新建入口与回调、壳层不发创建请求、资料改名、抽屉不显示来源。模块自身的行为测试在 `tests/cat-templates.test.ts`。

头像候选保留 N 手绘墨稿、G 3D 玩偶肖像、I 水彩绘本。`/avatar-lab/` 展示当前候选，首轮和第二轮完整样页均归档保留；应用暂不提供这三种画风的主题切换控件。

不再运行之前的 `client/src/` React 应用。原始 persona、memory、新建 Bot、群聊、详情抽屉与设置界面保留；providers 的模型目录、密钥/OAuth 与模型绑定界面按第 8 项移除，`providers.css` 原样保留供消息引用与弹层复用。账号登录和跨设备界面保留原结构；本地兼容层以已认证的 session 进入主界面，不要求用户登录账号。

## 接口原则

前端继续使用 XBot 的 Bot 名称、群聊 ID、profile、transcript 与事件结构；兼容层将它们映射到 Clowder AI 原生成员、Thread、消息、队列、会话和账号；Bot 仅保存显示元数据。优先调整兼容层，不改写原版页面以适应本项目原 API。

开发服务需要把 `/xbot-api/` 代理到本地后端。生产服务应在兼容路由之后提供 `dist/client` 的静态文件。原始脚本使用普通 `<script src="…">`，不转换为 ES modules。

## 完整性检查

以下检查仅验证工作区中的资源，不依赖本机临时参考仓库：

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(readFileSync('docs/xbot-frontend-manifest.json', 'utf8'));
for (const entry of manifest.files) {
  const actual = createHash('sha256').update(readFileSync(entry.target)).digest('hex');
  if (actual !== entry.sha256) throw new Error(`Changed: ${entry.target}`);
  const visualAsset = entry.file.endsWith('.css') || entry.file.startsWith('fonts/') || entry.file.startsWith('vendor/');
  if (visualAsset && actual !== entry.sourceSha256) throw new Error(`Upstream visual asset changed: ${entry.target}`);
}
console.log(`${manifest.files.length} files verified`);
JS
```

若后续确实需要修改上游脚本，应在本文件记录具体差异，并同时更新 manifest 中该文件的当前摘要；原始摘要保持不变。

`npm run verify:frontend` 在上述摘要检查之外，还要求 `index.html` 与 `runtime.html` 引用的每个本地资源都已列入 manifest 的 `files` 或 `extensions`；新增页面资源必须同时登记摘要。
