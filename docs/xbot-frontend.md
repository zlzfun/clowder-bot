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
   - 2026-11-05 修正空抽屉（用户反馈：点开「研究员-b7191893 · 执行过程 · 已完成」只有一个空的圆角框；这两条记录的 `content` 与原生 `content` 都是空串，内容全在 `native.toolEvents` 里，分别 8 条、6 条）。只改 `chat-presentation.js/css`，`app.js` 未改：
     - 展开后先照旧用 Markdown 显示非空的 `content`/`text`，再按原顺序逐条显示 `native.toolEvents`，每条 `tool_use`、`tool_result` 各占一项，不配对、不汇总。沿用「轨迹」页的 `trace-call` 样式：名称行是 `toolName`（`tool_use` 没有时用原 `label`），结果写「结果」；`detail` 原文放在 `pre.trace-args`（调用）或 `pre.trace-out`（结果）里。所有字段都经 `textContent` 输出，不经 Markdown 或 HTML。
     - 结果状态只取这一条自己的 `status`：`ok` 写「成功」，`error` 写「失败」并用 `--err`；没有 `status` 时不写，其他值写「状态未知」。整次执行「已完成」不代表其中每个工具都成功。
     - 正文去掉空白后为空、且没有可显示的事件（没有非空的 `label`、`toolName` 或 `detail`）时，不再给可展开的空抽屉：整行是同样的头像加「猫名 · 执行过程 · 状态」的普通 `div`，不能点开。进行中的记录在刷新时有了内容就变回可展开，展开状态仍按消息 ID 记录，内容仍在第一次展开时才绘制。
     - CSS 新增四条：不可展开行与摘要行同样居中，正文与工具列表的间距，工具原文最高 240px 可滚动（与 `.coding-card pre` 相同），失败结果使用 `--err`；头像尺寸规则从 `summary` 放宽到两种行共用的 `.sysline`。测试补上真实记录的空正文形态、结果状态各自独立、正文在前、空白记录、刷新后出现内容并保持展开、恶意标记按原文显示。
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
14. 2026-11-03 下拉框聚焦箭头修正（用户反馈：深色主题下点开模板的 Agent 下拉，箭头铺满整个控件）。`app.css` 的 `.field select:focus { background: var(--hover) }` 用简写重置了全部 background 子属性，深色箭头规则的优先级更高、图片保留下来，于是平铺；浅色的箭头则在聚焦时消失。`cafe-theme.css` 末尾的一条 `.field select:focus` 规则补回 `app.css` 原有的 `no-repeat`、`right 10px center` 和浅色箭头（逐字节复制），深色箭头仍由原规则生效。覆盖所有 `.field` 内的下拉框，包括模板与新建猫猫的 Agent、模型、推理强度、猫种和编辑资料里的选项；聚焦底色 `--hover`、输入框和文本框不变，原 CSS 字节不变。
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
15. 2026-11-03 设置精简（用户要求：先去掉预留、未实现的设置项，从能用的最小产品逐步扩展）。设置只保留四项，相对顺序不变：通用（只有主题）、模板、本地 Agent、关于。不加「即将推出」、禁用占位或说明页，也不新增功能。服务端兼容路由不变，未实现的接口照旧返回或拒绝；原生审批、技能/插件、排程和数据不受影响。
   - `index.html`：删除账号、权限、网页搜索、技能、图片生成、设备、连接应用七个导航按钮及面板；「通用」删除「通知 · 手机推送」一节。「关于」保留运行面板链接，原生队列、审批和记忆仍从这里进入；页脚改为「版本来自当前运行的 clowder-bot。」，因为服务端只报 `0.2.0`，不再写「短号用于核对构建」。
   - 不再加载只服务这些面板的 `web-search.js`、`image-gen.js`、`skills.js`、`apps.js`、`pairing.js`（设备页的配对弹层），以及 `web-search.css`、`image-gen.css`、`apps.css`；原文件与来源摘要保留。共用样式照常加载：`skills.css`（模板与本地 Agent 的列表外壳）、`persona-cards.css`（模板编辑）、`providers.css`（更换 Agent 弹层与消息引用）、`account.css`（登录前的账号界面）、`devices.css` 与 `remotechat.css`（侧栏远端分组与远端对话）。
   - `account.js`、`devices.js`、`remotechat.js` 照常加载，分别负责登录前的账号界面、侧栏底部的本机名与远端分组、远端对话。它们的设置页代码（`XBotAccount.mountSettings`、`xbotDevices.mount` 等）不再被调用，原样保留；本机名暂时不能在页面里改。
   - `app.js`：设置只挂载模板与本地 Agent；回到首页、切换面板、关闭设置三处只卸载这两个模块。删除账号、网页搜索、图片生成、技能、设备、连接应用的挂载与卸载，权限读写（`GET/PUT /xbot-api/permissions`），手机推送（启动时和打开「通用」时的 `GET /xbot-api/push`、订阅与退订），以及在对话里安装连接器的 `connectApp`。
   - `openSettings` 只打开导航里有的面板，其他一律落到「通用」，不会出现空白页。例如 `devices.js` 的 `XBotSettings.open("devices")`，来自远端对话的「在『设备』里查看」。旧入口 `?s=account` 直接打开「通用」。桌面与手机端的导航、模板与 Agent 的二级详情、Escape 与焦点归还、主题切换不变。
   - 测试未改：`tests/frontend-agents.test.ts` 的接线检查仍覆盖保留的模板与本地 Agent 面板；网页搜索、图片生成两个模块的测试针对保留的原文件，照常通过。
16. 2026-11-04 定时任务（用户要求开发定时任务能力；接口以 [schedules-api.md](schedules-api.md) 为准）。入口是每只猫信息抽屉的「任务」标签，设置导航不变。
   - 新增 `schedules.js`（classic script，在 `cat-templates.js` 之后、`app.js` 之前加载，对外提供 `window.ClowderSchedules`）和 `schedules.css`（排在所有样式最后）。模块只调用 `GET/POST /xbot-api/bots/:name/routines`、`PATCH/DELETE …/routines/:id` 和 `GET …/routines/:id/runs`，不读 profile 里的 `routines`（原生 profile 恒为空）。列表只在挂载、改动之后、点「刷新」和重新打开抽屉时读取；没有计时器、轮询或浏览器端排程。
   - 「任务」末尾是「定时任务 · N」一节，工具为「刷新」「新建」。每条是紧凑行：名称、状态、规则 ·「当前聊天」或「创建时的聊天」（聊天标签不拆行）。点开成面板卡片，状态留在行首，摘要行收起，卡片里依次是消息、规则、发到、上次、次数，以及「暂停/恢复」「触发记录」「删除」；任务 ID 和聊天 ID 收在默认折叠的「任务详情」里。加载、空、读取失败分别显示；读取失败不会显示成空列表。刷新失败时保留上次的列表并注明，下一次读取成功后这条提示自动消失。
   - 状态：`enabled`、`effectiveEnabled`、`registered` 分开判断。用户已启用、但被全局暂停或治理规则挡住，显示「暂不可触发」；运行时没有登记，显示「未生效」；都不会显示为「已启用」。触发结果按原生字段显示：`RUN_DELIVERED` 为「已触发」，并注明只表示消息已发给猫猫、不代表工作已完成；`RUN_FAILED` 为「触发失败」并附原生原因；`SKIP_MISSED_WINDOW` 为「错过时间」；其他 `SKIP_*` 为「已跳过」并保留原始代码。已触发的一次任务不再提供暂停或恢复；时间已过的一次任务不能恢复，提示重新新建。暂停和删除都注明已经开始的执行不受影响。
   - 投递聊天：`currentThread` 为真写「当前聊天」，否则写「创建时的聊天」，并注明结果不会发到当前聊天，同时给出「在运行面板查看」链接（`/runtime.html?thread=<聊天 ID>`）。
   - 新建（行内表单）：名称（1–80）、消息（1–16000）、时间规则（一次、每天、每周、间隔，复用 `.field`、`.choice`）。一次任务用浏览器的 `datetime-local`，按本机时区转换成带偏移的 ISO 时间；本机因夏令时不存在的时刻或已过去的时刻在发送前拒绝。每天、每周默认本机 IANA 时区，接口报告的时区作为另一选项；星期按原生 0 为周日。间隔为 1–10080 的整数分钟，并照原生规则注明创建或恢复后先等满一个间隔、运行时重启后会立即检查一次，固定钟点应选每天或每周。表单写明结果发到当前聊天、需要运行时和电脑在线、离线错过的一次任务不会补跑、不会发后台通知或手机推送。请求体只有 `{name, prompt, schedule, idempotencyKey}`，目标成员和聊天由服务端绑定。内容不变时重试沿用同一个 UUID，改动后换新值。保存中整张表单禁用，重复点击和 Escape 都不起作用；出错时保留输入。结果不明（没有应答或 5xx）时，提示先「刷新」核对再决定是否重试。创建成功但随后的列表读取失败，单独说明「已创建…但没能刷新列表」，不让用户重新创建。没有编辑、立即执行、任意 cron 或群聊任务控件。
   - 删除用原有 `.modal`/`.modal-card` 确认层，焦点先落在「取消」。Escape、Tab 和其余按键都留在层内，不会关闭抽屉；关闭后焦点回到「删除」，删除后焦点移到下一条。删除进行中两个按钮都不可用，Escape 也不起作用。失败时层保持打开，并说明是没能删除还是结果不明。
   - 生命周期：同一只猫的这一节是同一个元素。资料轮询的频繁同步只确认它仍在原位，所以打开的表单、触发记录和对话框都不受影响。「任务」标签重建时，元素移入新视图并重新读取列表，已输入的内容保留。切换到另一只猫、群组或取消选择时整节卸载，对话框随之关闭，之前发出的请求作废，不会写到另一只猫的界面。原先那只猫晚到的改动结果，只会让重新打开的同一只猫重读列表；关掉的表单或记录不会因此重新出现。焦点只在原本就在这一节里、或已经丢失时才移动。
   - `app.js`：
     - `syncTaskView` 去掉「例程」小节和整页「没有任务 / 让它『每天 8 点提醒我』」空状态，改为 `scheduleSection` 把模块挂在执行任务各小节之后。删除 `routineCard`、`updateRoutineCard`、`routineChanges`，以及随之不再使用的 `cronText`。
     - `refreshWork` 只同步为当前猫绘制的任务视图，并删去按 profile `routines` 重绘详情页的分支；空聊天的起手句不再读取 profile `routines`。
     - `resetConversation` 和无选择时的 `paintPanel` 卸载模块；`panelOpen` 在抽屉从关到开时通知模块重读。
     - `api()` 新增 `serverError` 选项。只有经 `scheduleApi` 发出的定时任务请求才保留服务端 5xx 原话（例如需要 `npm run runtime:prepare`、原生未确认已创建），其他调用仍显示通用说明。
     - 聊天中的定时消息（`routineOf`、`routineLine`、`routineRuns`）属于另一回事，保持原样。
   - `runtime.js`：首次读取会话列表时，按 `?thread=` 选中对应会话；列表里没有时，在 `#error` 写明「没有找到链接里的会话 …」，不默默换成别的会话。之后仍以选择器为准。
   - `schedules.css` 只用现有 token：行沿用任务标签的紧凑行与 `--x-panel-card` 卡片，按钮沿用 `.secondary`、`.text-btn`，折叠沿用 `.task-details`，危险色只用于删除与失败。浅色、深色随 token 切换，窄屏下动作按钮自动换行。不新增颜色、字体或动画，原 CSS 字节不变。
   - 测试：`tests/schedules.test.ts` 覆盖规则文本与时区、请求体与校验、夏令时空档、同步不重读、标签重建保留输入、加载/空/失败状态、启用与实际可触发分开、已触发不等于完成、失败原因、四种规则的创建、防重复提交与幂等键、结果不明提示、创建成功与刷新失败分开、跨猫过期应答、暂停/恢复、删除确认与焦点、触发记录、关闭后不重开，以及静态接线。`tests/runtime-tasks.test.ts` 新增 `?thread=` 预选测试。
17. 2026-11-04 项目、工作区、附件与协作任务（用户要求：聊天里能用项目与猫猫工作区、附件与交付物、按任务的负责成员与交接记录，交互组织参考 OpenBot，不整体改版）。与第 16 项并行开发，变基到第 16 项之后重新编号，合并方式见第 19 项末条。其中的项目、工作区切换、新建任务与指派已由第 18 项收起，以下保留为当时的接线记录。新增扩展 `workspace-rules.js`（无 DOM 的规则）、`workspace.js`（`window.ClowderWorkspace`）、`workspace.css`；设计、文案、交互约束与已知限制见 [项目、工作区、附件与协作任务前端规范](workspace-ui.md)。本项只记录原文件的接线。
   - `index.html`：在 `cat-templates.js` 与第 16 项的 `schedules.js` 之后、`account.js` 与 `app.js` 之前依次加载 `runtime-tasks.js`（运行面板已有的原生 Task 规则，这里只复用其判断，不调用它的 `load`）、`workspace-rules.js`、`workspace.js`；`workspace.css` 排在 `chat-presentation.css` 与第 16 项的 `schedules.css` 之后，其后只有第 19 项的 `chat-experience.css`。DOM 结构不变：回形针按钮、顶栏工作区按钮和任务条由 `workspace.js` 在启动时插入（输入框原有的空 `plus` 列、`#head-chip` 之后、`#work-status` 之后）。
   - `app.js` 启动：在 `syncSidebar()` 前调用 `workspace.init({...})`，传入壳层已有的 `api`、`apiFetch`、`icon`、`visibleError`、`syncComposer`、`closePops`、`showToast`、`setStatus`、`copyText`、`openShots`（看图）、按原生猫 ID 取头像与名字的 `face`/`catName`，以及 `peer`、`busy`、`reselect`（切换项目后重新 `selectBot`）、`reload`、`repaintPanel`、`openTab`（打开抽屉到指定页）。`closePops()` 末尾一并关闭模块的菜单。
   - `app.js` 会话：`resetConversation()` 改为调用 `workspace.select(state.sel)`（取代原 `clearAttach()`）；`loadThread()` 每次读到单聊记录或群聊消息后调用 `workspace.observe(selection, 线程 ID, 是否有变化)`；原生 SSE 触发的那次读取前先 `workspace.touch()`，让任务和文件随之刷新。
   - `app.js` 附件：删除只收图片、上传到已退役 `/paste` 的整段实现（`ATTACH_MAX`、`attachState`、`attachNote`、`paintAttach`、`removeAttach`、`clearAttach`、`uploadAttach`、`imagesFrom`）和 `state.attach`、`state.attachBatch`；`attachReady()`、`attachBusy()` 改为委托模块，`syncComposer()` 按就绪数量判断。提交时 `workspace.takeAttachments()` 取走已就绪文件；上传中仍提示等待。粘贴与拖放改用 `workspace.filesFrom/carriesFiles/addFiles` 接收任意文件，粘贴文件时 `stopImmediatePropagation()`，不再把文件名当文本贴入；对等对话中不显示拖入描边。
   - `app.js` 发送：`sendText(text, pending, images, files)` 多一个 `files` 参数；请求体增加 `idempotencyKey`（新增 `requestKey()`）、附件的 `attachments` 与 `expectedThreadId`（无附件时也带上当前线程，避免发进已经换掉的会话）；非 2xx 时读取服务端 `error` 与状态码。没有发出去时 `workspace.giveBack(files)` 放回附件，失败行写明「没发出去：中文原因，原文还在输入框里，附件已放回」；结果未知（无应答或 5xx）时同样的文字和附件重发沿用原幂等键，4xx 换新键；409 后重新读取会话。乐观行用 `workspace.cards(…, {sending: true})` 显示随消息发送的文件。
   - `app.js` 消息：`userBubble`、`botBubble`（新增 `last` 参数，文件只挂在一条消息的最后一个气泡下）、`renderGroup` 按 `m.attachments` 追加 `workspace.cards(…)`；只有附件的消息不再画空气泡或「这次没有收到回复」，旧版无 `say` 的猫猫行有附件时也照常显示。
   - `app.js` 抽屉：`TABS` 在「任务」后加 `["files", "文件"]`；`paintPanel()` 增加一条快速路径：当前页是模块仍在用的页面（`workspace.current()`）时只更新顶部而不重建，单聊「任务」页仍走原快速路径；单聊「任务」页为 `workspace.tasksView()` + 小标题 + 原 `computerView()`，群组「任务」页由「没有任务」占位改为 `workspace.tasksView()`；两者的「文件」页为 `workspace.filesView()`。输入框上方「子代理在跑」那一行点开后滚动到这个小标题。小标题当时为「执行与例程」，`syncTaskView()` 的空状态标题当时改为「没有执行或例程」；与第 16 项合并后，小标题为「执行与定时任务」，那个空状态随第 16 项删除（见第 19 项末条）。
   - `app.js` 新建群组：`openNewGroup()` 通过 `openModal` 的 `after` 回调加入 `workspace.projectField(modalFields)`，选了项目时请求体带 `projectId`。
   - 不改原 CSS：新样式只在 `workspace.css`，覆盖抽屉标签在窄抽屉里的间距与横向滚动，其余均为新类名。测试：`tests/workspace-ui.test.ts`（附件限额与放回、按线程上传与切换中止、上传失败重试与焦点、缺失图片的说明、请求交接不改负责成员且重试沿用幂等键、负责版本变化后撤下旧负责成员提示与回执、迟到的交接 202 / 指派 / 停止应答不覆盖已读到的新版本、停止请求体与恢复等待、指派与负责记录、历史标记关闭、过期应答不落到新会话、新建任务、项目切换与拒绝、群组工作区固定、页面接线）。
18. 2026-11-05 精简文件与任务（用户看过参考 OpenBot 的功能后批准：保留附件与交付物；负责人与交接由 Clowder AI 原生 Task 负责，不另建负责体系或咨询、转交模式；收起项目与工作区管理，使用自动默认目录）。现行规范见 [文件、历史对话与聊天任务前端规范](workspace-ui.md)，服务端见 [默认文件目录与原生协作](default-files.md)。
   - `workspace.js`：删除顶栏工作区按钮与项目菜单、新建项目弹层、群组项目下拉，以及对 `/xbot-api/projects` 与 `PUT <scope>/workspace` 的全部调用。「文件」页只直接显示「交付物」「附件」；工作目录路径、目录浏览与「存为交付物」收进默认收起的「更多文件」，展开前不读取目录；工作区身份卡片与首屏的目录切换删除。不显示服务端的 `defaultRoot`、`filePolicy`，也不作只读或保护声明。任务卡改称「任务」「负责人」「请求传球」「流转记录」，删除「新建任务」表单与「指派 / 改派」（前端不再 `POST <scope>/tasks`、`PATCH <scope>/tasks/:id`）；负责人仍只取自读到的 Task，传球仍是异步请求，停止 / 撤销 / 恢复与防过期规则不变。新增 `conversationsView()`：猫猫已知对话多于一个时，「详情」里出现默认收起的「历史对话」，只经 `PUT /xbot-api/bots/:name/conversation {threadId, expectedThreadId}` 在已知线程间切换，沿用线程确认、待发送附件确认与迟到应答丢弃；群组没有这一项。
   - `workspace-rules.js`：删除 `assignBlocked`；流转记录的方式改为「传球 / 手动指派 / 认领」（未知为「负责人变更」）；新增 `conversations()` 整理历史对话（去重、单行标题、新的在前）。
   - `workspace.css`：删除顶栏按钮、菜单、工作区卡片、项目下拉、新建任务表单的规则；新增「更多文件」「历史对话」折叠和负责人标签的少量规则，只用已有 token，原 CSS 字节不变。
   - `app.js`：`openNewGroup()` 恢复为提交前的原版（只有名字与成员）；`closePops()` 不再调用模块；`workspace.init` 不再传 `closePops`、`botLabel`；`detailsView()` 在「配置」之后追加模块返回的历史对话节点（没有时不追加）；相关注释改掉「项目」「协作任务」的说法。其余第 17 项的附件、发送、消息与抽屉接线不变。`index.html` 未改。
   - 测试：`tests/workspace-ui.test.ts` 按新文案与入口更新，新增：收起的入口（无顶栏按钮、无项目请求与切换、新建群组只发名字与成员）、「文件」首屏无路径而展开后才读取与保存快照、旧项目会话的共享目录只在展开区、流转记录的方式区分、没有新建与指派、恢复请求体与说明、历史对话的出现条件、切换请求体与忙碌拒绝、待发送附件确认、发送中与切换中的限制、迟到应答与旧列表应答不生效、确认期间线程变化、应答前已到该线程时不再重开、同一线程刷新不重读也不丢附件、重绘后焦点回到原行。测试里的假 DOM 补上 focusin/focusout，DOM 节点按引用比较。
   - 第 17、18 项及 `chat-presentation.js/css` 的空抽屉修正由附件分支提交 `1893f70c` 的前端原样并入当前工作区（只取前端文件与对应测试、文档，不含该提交的运行时补丁 P006／P007、启动策略与后端文件），原始来源摘要不变。
19. 2026-11-05 聊天体验 1、3、5（用户批准实施：复用附件分支成果、记忆只读、聊天保持简单）。接口以 [聊天体验适配契约](chat-experience-api.md) 为准；新增扩展 `chat-experience-rules.js`（无 DOM 的规则，`window.ClowderExperienceRules`）、`chat-experience.js`（`window.ClowderExperience`）、`chat-experience.css`，并扩展 `workspace-rules.js/js/css`。交互约束见 [文件、历史对话与聊天任务前端规范](workspace-ui.md) 的「状态行与已读」「记忆」两节。
   - **1 文件**：消息与「文件」页继续用 `wsf-card`。原生文件视图（`nativeSource`）称「成果」，不称交付物或快照；`size:null` 不写大小；`availability` 不是 `available` 时卡片原位写服务端原因（无原因时「这份成果／这个文件暂时不能下载」），下载、预览停用，也不请求缩略图。地址只按编码后的 ID 拼 `/xbot-api/files/:id/…`，不用记录里的任何 URL。「文件」页在服务端读出原生记录后（`nativeReadStatus` 存在）于「交付物」前加「成果」一节；`nativeReadStatus:'unavailable'` 时保留快照与附件，「成果」写「猫猫在对话里发出的文件暂时读不到。下面只显示已保存的文件。」（读到一部分时写「这里可能不全」并列出读到的）加「重试」，服务端原因放在提示里，不显示「还没有成果」。只有附件的消息照常显示（沿用第 17 项）；不新增工作区界面，正常收成果不需要展开「更多文件」。
   - **3 状态行**：`index.html` 在 `workspace.js` 之后、`app.js` 之前加载两个脚本，`chat-experience.css` 排在全部样式最后。模块在 `#work-status` 之后插入 `.cx-status`；`GET <scope>/activity` 有应答（含失败）时给 `.dock` 加 `cx-on`，原执行行与任务条由 CSS 收起，只剩一行；接口 404 时不接管，原两行照旧。行首是最紧要的一类（待确认 › 失败 › 处理中 › 排队 › 未完成任务），只有一项处理中或排队时直接用服务端标签（如「宪宪正在处理」），待确认标签不重复「等你确认」，其余类别保留数量；点击原位展开，默认列前 6 项，更多时「查看其余 N 项／收起」原位展开全部待确认与并发事项（同一会话的刷新、重绘中保持展开与焦点，换会话或线程后恢复简短），按原生消息 ID 定位真实消息（闪烁并聚焦）或按 Task ID 打开「任务」页的对应卡片（`workspace.focusTask`）；服务端计数多于列出项时写「另有 N 项没有列出」。待确认项另给「去确认」打开运行面板，界面不批准任何事。读取部分失败写「部分状态读不到」，没有任何项时写「暂时无法确认状态」；断线时保留上次结果并注明可能已变化，从不显示为空闲。新回复只取服务端 `unread`，且只在最新回复不在视野内时出现。
   - **3 已读**：GET 不标已读。模块只在页面可见、对话区未被设置／看图／窄屏抽屉遮住、当前会话线程与 activity 的 `threadId` 一致、`unread>0`、`latestMessageId` 对应的行在对话视口内停留 0.8 秒后，才 `POST <scope>/read {expectedThreadId, messageId}`；同一条只发一次，一次一个请求，失败 20 秒内不重发；404（这条不是该线程的可见回复，不当作接口缺失）与 409（另重读 activity）都只记在这一条回复（会话 + 线程 + 消息）上，之后的新回复照常确认；切换会话或线程后的迟到应答不改当前会话，失败不留下拒绝、等待或重读。成功后侧栏该会话的红点立即消失。
   - **3 侧栏**：`refreshStatus()` 另存 `groups`；猫与群都按 activity 显示「N 项等你确认」「有一项失败／N 项失败」「暂时无法确认状态」（后者不可点），群聊也显示处理中、排队与红点。点待确认／失败先打开对应会话，再交模块按消息坐标定位；没有坐标或当前记录里没有该消息时展开状态行列表，不猜测。原 `jumpToApproval` 删除。（第 24 项起，第二行不再单独响应点击：点整行只打开会话，定位改由聊天状态行完成。）
   - `app.js` 其余接线：单聊、群聊消息行增加 `data-mid`（原生消息 ID）；`resetConversation()`、两处 `loadThread()` 读取、原生事件和两种对话的绘制结束（含空对话）分别调用 `experience.select/observe/touch/rendered`；`experience.init` 传入 `api`、`icon`、`visibleError`、`thread`、`face`、`peer`、`obscured`、`focusTask` 与 `onRead`。原执行行多项时的「N 个子代理 在跑」改为「N 项 在处理」。新增 `isSilent`／`hasMedia`／`silentOnly`：`renderMessages` 只跳过没有任何文件或图片的 `SILENT` 回复（原先只看图片，带文件的会被吞掉）；`botBubble`、`renderGroup` 对带文件的 `SILENT` 保留卡片但不写这个词，群聊里纯 `SILENT` 不再画成气泡，例程只折叠纯 `SILENT`，群聊预览跳过 `SILENT`。
   - **5 记忆**：单聊「记忆」页改由 `experience.memoryView(sel, data)` 绘制：默认收起的「关于你」「你的偏好」展开才 `GET /xbot-api/memory/profile|taste`，区分正在读取、没能读取（「这不代表没有内容」+ 重试）、没有权限、部分可读、暂时读不到、接口未开放与真的为空；条目按原生内容原样显示，停用条目排后并标注，`pendingCount` 只写「另有 N 条待确认的修改，确认前不算已保存」。每条的「来源」展开才带 `revision` 读取，409 提示重新读取列表，404、401／403、未记录、不可读各自说明；只有来源消息在当前对话里才给「在对话里查看」。没有编辑、确认、停用或遗忘按钮。原便笺改称「这个对话的便笺」，与原界面一样只读：不调用 `POST/DELETE /xbot-api/bots/:name/memory`（服务端旧路由不动），抽屉没带便笺时 `GET` 一次，失败写「便笺没能读取：原因。这不代表没有便笺。」加「重试」，读到为空才写没有便笺。整个记忆入口没有写操作。群聊「记忆」页只写「群聊没有可查看的记忆。关于你的资料和偏好，在和猫猫的单聊里查看。」，删除原「对它说『记住……』就会出现」的承诺；`libraryView`、`scopeLabel` 删除。
   - 测试：新增 `tests/chat-experience-ui.test.ts`（规则；并发待确认的行与列表、定位消息与任务、未找到时的说明、不批准；超过 6 项（8／9 项待确认 + 处理中、排队、任务）时「查看其余 N 项」、定位第 7、8 项、刷新保持展开与焦点、收起、换会话恢复简短；断线、首读失败、部分读取、404 回退；迟到应答；可见阅读确认的停留、只发一次、隐藏页、遮挡、浏览旧消息、迟到与 409、其他线程；A 被 404／C 被 409 后 B／D 仍确认；换线程后旧线程的 503 不给新线程加等待、换会话后旧会话的 409 不重读也不留拒绝；记忆的按需读取、待确认分开、失败／部分／无权限／未开放、来源的 revision 与 409；整个记忆入口无写控件、便笺只读与读取失败重试、群聊；页面接线），`tests/workspace-ui.test.ts` 新增原生文件卡片、原生记录局部失败与 `SILENT` 回复（取 `app.js` 自身的判定与 `botBubble` 运行：带文件保留卡片且不显示 `SILENT`）三项，样式顺序断言改为 `workspace.css` 之后只有本扩展。
   - 审查修正（同日）：去掉本轮多加的便笺添加与删除（用户要求记忆先做只读）；状态列表超过 6 项时可原位查看全部；`/read` 的 404／409 只记在那一条回复上（404 不当作接口缺失），换线程或会话后的迟到应答不再给当前线程加 20 秒等待、不再重读或留下拒绝；带文件的 `SILENT` 回复不再被吞。
   - 与第 16 项定时任务合并（同日，第 17–19 项变基到 `458ee358` 之后）：第 16 项的功能与接线保持原样，本轮只调整接合处。
     - `index.html`：脚本为 `cat-templates.js` › `schedules.js` › `runtime-tasks.js` › `workspace-rules.js` › `workspace.js` › `chat-experience-rules.js` › `chat-experience.js` › `account.js` › `app.js`；样式为 `chat-presentation.css` › `schedules.css` › `workspace.css` › `chat-experience.css`。三组样式的类名互不重叠（`.sched-*`、`.ws*`、`.cx-*`），顺序不改变定时任务的外观。
     - `app.js`：`syncTaskView` 取第 16 项的版本（没有「例程」小节和整页空状态，`scheduleSection` 把「定时任务」挂在执行各小节之后），第 17 项对那个空状态标题的改动随之作废。单聊「任务」页从上到下是 `workspace.tasksView()`（原生 Task 卡）、小标题「执行与定时任务」（原「执行与例程」，例程小节已由第 16 项的「定时任务」取代）、`computerView()`（进行中、排队中、最近结束，最后是「定时任务」）。`paintPanel` 的两条快速路径照旧：单聊「任务」页仍只同步 `.task-view`，模块挂载的定时任务节点不重建；`resetConversation` 与无选择时的卸载、`panelOpen` 的重读、`scheduleApi` 的 `serverError` 均不变。群聊「任务」页只有任务卡，不挂定时任务。
     - 测试：`tests/schedules.test.ts`、`tests/workspace-ui.test.ts`、`tests/chat-experience-ui.test.ts` 的接线断言同时成立，未放宽。
20. 2026-11-06 群组头像（用户参考 Grok Bot 截图）：群组头像由成员自己的头像拼成，最多四只，按成员顺序挤成一团：边缘略微相叠，大小有主次，错落而不成方阵；背后没有底色块，也不用通用人形图标。数据只来自已有接口：群组记录的 `members`（原生 Thread 的 `preferredCats`，由 `GET /xbot-api/groups` 与 `GET /xbot-api/groups/:id` 按顺序给出），以及 `/xbot-api/bots` 的头像字段（上传图片、seed、`templateId`）。只改显示，不新增请求、状态或写操作。
   - `app.js`：
     - `avatar()` 的绘制部分抽成 `drawFace()`：上传图片优先，加载失败时改画猫猫。单聊头像的行为不变。
     - `groupFace(g)` 按接口给出的成员顺序取前四个不重复的成员（猫猫名，找不到的猫猫是原生 ID），每个成员原位对应一个座位：在已读的猫猫名单里找到就画它的头像，找不到就留空座位。五个及以上只显示前四个，不显示数量；前面的成员暂时找不到时，第五个也不会补进它的座位，名单刷新后各座位位置不变。不足两个时用空座位补到两个：只有一个成员时补一个空座位，没有成员数据时是两个空座位。不编造猫猫，也不加入主人。`paintGroup()` 把座位画进 `.avatar.group`，记下 `data-seats` 与签名（座位上的猫名和头像签名）。
     - 侧栏群组行（含收起的窄侧栏）、顶栏、信息抽屉顶部和空对话用同一张图，各自取手上的群组记录：前三处用已读的群组列表，顶栏在列表里找不到这个群时显示空座位；空对话用 `GET /xbot-api/groups/:id` 随消息返回的 `group`。消息里仍是发言猫自己的头像。
     - 头像跟随变化：侧栏签名 `listSig` 包含每个群组的头像签名。顶栏按 `state.sel.type === "group"` 判断，缓存键是 `group:<id>:<签名>`，所以群组 ID 或名称与猫猫同名时也不会显示那只猫。列表刷新后，`refreshBotFaces()` 按 `data-avatar-group` 找到顶栏、抽屉和空对话里的群组头像，签名变了就用最新的群组记录重画（保留未读点）；列表里找不到的群保持原样。侧栏群组行的提示是显示的群名，原始 ID 仍在 `data-group`。
   - `cafe-theme.css`：群组头像框透明、不裁切，自成层叠上下文（`isolation`）。每种人数一套紧凑布局：第一位成员最大、在最前（两只、四只时在左下，三只时在下方正中），其余稍小、错落坐在后面，相邻座位边缘相叠，但每张脸的两只眼睛都不被遮住。座位是圆形窗口，底色与猫猫头像相同（`--x-avatar-bg`），外圈 1px 接缝取行底色（沿用未读点外圈的写法：`--x-win`，选中行 `--selected`），把相叠的边缘分开，不加粗描边。陶土猫猫图在座位里放大到 1.35 倍（原点 50% 40%），去掉图集自带的留白；上传图片按原样 `cover` 显示、不放大、不改色。空座位是行底色上叠 `--x-text` 14% 的淡色、不透明，后面的座位不会透出来。位置按头像框的百分比计算，所以 36px 列表、24px 顶栏、48px 抽屉与空对话共用一套。群组的未读点移到右上角外沿、压在座位之上，避免盖住右上那只猫的脸。原有的头像底色规则排除 `.group`。原 CSS 字节不变。
21. 2026-11-06 单只猫头像近景（用户反馈：单聊头像里猫头偏小，可能看不清是哪只猫）。`cafe-theme.css` 新增一条规则，只作用于 `app.js` 标了 `data-avatar-bot` 的猫猫头像，即侧栏列表（含窄侧栏与 pin）、顶栏、消息、信息抽屉和空对话：陶土猫猫图在 `createPortrait` 原有 8% 内缩的基础上，以 50% 40% 为原点放大 1.25 倍，等同于图块放大到 105%、水平居中、顶边贴齐（`translate(-11.0875px, 0) scale(1.05)`，单位为 viewBox）。猫头与眼睛约大四分之一。按图集实测，八个品种的耳尖都留在圆内，只有缅因猫的簇毛尖贴边；胸口底边移到圆外。
   - 只移动 SVG 视口里已裁切的那层图，圆的直径、布局和窄侧栏露在外面的未读点都不变。上传图片、远端同伴头像、编辑资料与模板里的选猫头像、群组座位（仍是原有的 1.35 倍）都不受影响。`cat-avatars.js` 与图集未改，原 CSS 字节不变。
22. 2026-11-06 透明猫猫头像（用户参考 Grok Bot：头像背景透明）。纯静态显示：只用已有的猫猫与群组记录，不新增请求、状态、文案或控件，后端与运行时不变。
   - 轮廓：图集 `clay-cats.png` 是不带透明通道的 RGB 图，底色是平整的米白（约 `#F8F5EF`），图集字节不变。开发脚本 `scripts/trace-cat-outlines.mjs`（无依赖，用 Node 自带 zlib 解码）从图集描出每只猫的外轮廓：从格子边缘向内泛洪与底色相差不超过 12 的像素，所以轮廓里面的浅色毛（布偶、梵花、金渐层的白胸口）不会被当成背景；半径 2px 的开运算去掉伸出轮廓的胡须和散毛，只留最大一块并填洞，内收 1px 去掉米白抗锯齿边，再以亚像素精度描线、1.1px 容差简化。胸口平直的底边改成第 21 项近景圆的下半弧，不补画不存在的毛。八条路径共约 3.8KB，以整数相对坐标写在 `cat-avatars.js` 的 `outlines` 里；`node scripts/trace-cat-outlines.mjs --check` 校验它与图集重新描出的结果逐字一致。
   - `cat-avatars.js`：`createPortrait` 去掉 `#f8f5ef` 底色矩形，裁切由整格方形换成该猫的轮廓路径；`<image>` 的位置与 8% 内缩不变。另导出只读的 `outlines`。
   - `cafe-theme.css`：
     - 带陶土猫 SVG 的 `.avatar`（`:has(> svg[data-cat-id])`）底色透明，浅色、深色都直接露出行底、选中底、消息区或抽屉；上传图片、几何头像兜底和空座位保持原有底色。第 21 项近景规则不变；轮廓的下半弧与近景圆重合，所以单猫头像底部仍是圆弧，不露平直切边。
     - 群组座位里是陶土猫时，座位不再填 `--x-avatar-bg`，也不画圆形接缝；改用四个 1px 偏移的 `drop-shadow` 沿猫自己的形状（猫轮廓与圆窗的交集）画 1px 接缝，后排的猫从前排猫的耳朵旁露出来，相叠处仍有一道表面色细缝。2/3/4 只的位置、大小、层次、1.35 倍和未读点不变；上传图片座位仍是圆形接缝，空座位不变。接缝色取所在表面：侧栏 `--x-win`，行悬停 `--hover`、按下 `--fill-hover`、选中 `--selected`，主区（顶栏、空对话）`--bg`，顶栏按钮悬停或展开 `--hover`，抽屉 `--panel`。侧栏问候语里的忙碌猫叠放 `.greet-stack` 同样把原 2px 圆环换成 1px 贴形接缝。原 CSS 字节不变。
   - 测试 `tests/cat-avatars.test.ts`：断言 SVG 只有 `defs` 和已裁切的图层（没有底色形状），裁切路径就是该猫的 `outlines`；新增一条：运行描线脚本 `--check`，每条轮廓只有一个闭合外形、在格内、占格子面积 35%–65%，底部不越出近景圆。
   - 已知取舍：伸出脸颊外的胡须随背景一起去掉（脸上的胡须保留）；缅因猫最细的耳簇尖被开运算磨圆约 0.5px（36px 下）；最浅的卡片底（`--x-card`）上，浅色毛的猫主要靠毛发明暗显出轮廓。任务执行条 `.work-stack` 原本没有接缝，本项未加。
23. 2026-11-06 单猫空聊天与开场问候（用户反馈：咖啡插画、大头像和名字堆在一起，三条固定建议呆板，「有什么事，直接说就行。」不好，参考 Grok 新 Bot 的开头；随后更正：不要关键词或模板，由猫按自己的名字和人设真实说一两句，名字用途明显可以顺着问一句，普通昵称只问好）。接口：`POST /xbot-api/bots/:name/greeting {expectedThreadId}` 应答 `{status:'accepted'|'exists'}`；transcript 可带 `greeting: {status:'accepted', sourceMessageId}` 或 `{status:'unconfirmed'}`，缺省表示没有登记。邀请原文、用途判断与模型调用都在后端和原生猫；已确认的邀请原文不在 `messages` 里。
   - 删除旧欢迎卡（涂鸦、72px 头像、居中标题、旧文案、起手句及 `starterPrompts` 等），也删除上一版前端按名字关键词拼出的 `opening`/`openingRow`。单聊空对话不画任何假的猫气泡、发言时间或消息菜单，开场白只来自上游真实的猫回复。群聊、未选择、跨设备、未登录和「连不上」页不变；`index.html` 未改。
   - 何时邀请（`chat-presentation.js` 的 `greetings`，只做本页的请求记账）：`loadThread` 每次成功读到所选单聊，都在签名比较之前交给 `greetings.observe`。只有 `messages` 为空、`before` 为空且 `hasMore` 为假、没有 `greeting`、页面 `visibilityState` 为 `visible`、屏上没有本次的发送或回复错误时，才发一次 `POST …/greeting {expectedThreadId: thread_id}`，新建猫猫后自动进入也一样。请求不被等待，不阻塞消息绘制。
     - 每个「猫 + 线程」在本页生命周期内最多自动发一次。读到任何记录、游标、登记或主人自己的发送后，这个线程也不再自动发。后台标签页读到空聊天时不发，回到前台后的第一次成功读取（下一次轮询，最多约 3 秒）才发。
     - 轮询、原生事件、重绘、迟到应答、切猫与切回都只是重新读取，不会再发。侧栏预览（`warmOne`）、群聊、读取失败或 `messages` 不是数组的记录不经过这里。
     - 应答只记到它所属的猫和线程。只有那个对话仍在屏上且仍为空时，才原位重画状态行并重新读取一次；切回来时按记下的结果显示。
   - 状态行：空对话顶部一行 `sysline`（猫的 xs 头像加短句，`role="status"`），只说本页的请求，不说猫已回复或正在工作，也没有转圈：
     - 发送中「正在邀请宪宪打个招呼」；应答 `accepted` 或 transcript `greeting.status` 为 `accepted` 时「已邀请宪宪打个招呼」。
     - `exists` 只表示已有记录，不显示任何行，交给下一次读取。
     - 请求失败「没能邀请宪宪打个招呼：原因」，原因沿用现有 `api()`/`visibleError` 的说法；transcript `unconfirmed`「没能确认宪宪收到了邀请」。两者都带「重试」：只针对这一行所属的线程，且它仍是当前对话；发送中再点无效。失败从不自动重试。
     - transcript 的 `greeting` 优先于本页回执（发送中除外），无法识别的状态不显示。
     - 一旦有真正的消息（猫的回复、失败记录或用户消息），状态行消失，由真实消息和原有的运行、错误反馈接管。屏上有发送中、已排队、没发出去或回复出错的行时也不显示：`optimisticMessage`、`liveBubble` 用 `dropGreeting` 移除它，不挤掉发送反馈和用户消息。例外是 transcript `unconfirmed`（原生已收到邀请但回执丢失时，邀请原文是一条普通行）：即使已有消息，这一行和「重试」仍在消息最上方，不改版式，不按正文判断哪条是邀请，屏上的错误与未发出的消息照常保留，发送或回复进行中照旧先撤下、下一次读取再画，本页重试得到 `accepted` 后不再显示；POST 200 但没有有效 `status` 也按未确认显示并可重试。
     - 原生记录不空但没有可显示的行（内部记录、后台轮次、纯 `SILENT`，或 `messages: []` 而 `before`/`hasMore` 表明还有记录）时照旧留空。读取失败照旧是「连不上 clowder-bot」与「重试」。
   - 版式：transcript 带 `greeting.status: 'accepted'` 的对话，以及邀请发送中或已受理的空对话，给 `.thread-inner` 加 `greeted`，消息流从顶部开始，猫的真实首句在最上方；之后照常聊天，超过一屏后与原来一样滚动。其他历史保持原来的底部对齐。只显示失败或未确认行的空对话在主人发送后撤掉 `greeted`，回到原版式。
   - `app.js`：`state.chatRead` 记录最近一次成功读取（`resetConversation` 清空）；签名改由 `transcriptSig` 计算（线程、消息、`history`、`greeting` 与状态行）；新增 `placeGreeting`、`paintOpening`、`dropGreeting`、`greetingAccepted`、`greetingReason`；`renderMessages` 的第三个参数改为这次读取。上一版对 `emptyState`、`renderMessages` 的精简和 `fetchBotProfile`（`profileRequests`）保留。
   - `chat-presentation.js` 新增 `greetings(post, changed)`（按猫和线程记发送中、已受理、已有记录、失败、已判定，不保存猫说的话）与 `greetingLine(view, opt)`（只用 `textContent`）。`chat-presentation.css` 删去上一版的 `.chat-opener` 规则，新增 `greeted` 顶部对齐与状态行的头像、重试按钮规则，只用已有 token，原 CSS 字节不变。
   - 模板样页：`template-lab/index.html` 恢复为本项之前的字节，不加载 `chat-presentation.js/css`。`lab.js` 里示例猫猫的空对话只有一行中性的「样页预览：不连接猫猫，不会生成问候或回复」，不调用接口，不模拟问候。
   - 测试 `tests/chat-presentation.test.ts` 新增：空且可见时每个线程只发一次（轮询、事件、重绘不再发）；后台页、有记录、有游标、已登记、主人已发送或没有线程时不发；失败不自动重试，重试只针对该线程且不重复；`exists` 不显示，应答 200 无有效状态按未确认；服务端登记优先；迟到应答的归属；状态行文案与重试；已有消息时 `unconfirmed` 仍可重试（不读正文、不重复、失败可再试、受理后消失），普通 accepted、有历史或未登记时不显示。
24. 2026-11-06 侧栏行统一为打开聊天（用户反馈：点列表里的猫，有时进入聊天，有时弹出满是原始工具 ID 的「本轮」浮层；要求日常点击简单一致、聊天优先，不出现这种列表）。根因：处理中、排队的猫，第二行有自己的点击，`stopPropagation()` 后打开「本轮」浮层，行本身的 `pickBot` 收不到点击；等你确认、失败的第二行也有自己的点击，会跳到消息或展开状态行列表，已打开的那只猫也会重读并展开。只改 `app.js` 的显示与交互，并删去 `chat-experience.js` 里随之无用的 `attend()`；后端、上游（固定 `42017e0`）、原 CSS 与数据不变，聊天记录照旧来自 `/api/messages?threadId=…`，队列照旧来自 `/api/threads/:threadId/queue`。
   - 猫与群的整行是同一个点击目标：头像、名字、第二行（处理中、排队、空闲、等你确认、失败、暂时无法确认、离线）和行内空白都只触发行本身的点击，猫走 `pickBot`，群走新增的 `pickGroup`（即原先内联的同一判断）。点未打开的会话就打开它；点当前已打开、且不在对等对话中的会话，保持原样，不重置草稿、进行中的回复、待发送或发送失败的消息；窄屏下只用原有的 `closeDrawer()` 收起侧栏、露出这个聊天。在对等对话中点则回到该会话。固定 pin 行同样走 `pickBot`。长按、右键菜单和信息面板的开合偏好不变。
   - 第二行只显示状态：处理中、排队仍有转圈和「在处理」「等待执行」，等你确认仍有圆点和「N 项等你确认」；失败、暂时无法确认、离线照旧，文字和签名都不变。去掉 `click` 类（原 CSS 据此显示手型和下划线），第二行不再有自己的监听。打开会话后，聊天状态行仍提供原有的「查看」「打开任务」「去确认」。
   - 删除侧栏「本轮」浮层，包括：
     - 状态与函数：`stpState`、`stpSetup`、`toggleStp`、`openStp`、`closeStp`、`stpRefresh`、`stpPaint`、`placeStp`，以及只为它服务的 `tsOf`、`stClock`、`stDu`；
     - 请求：打开浮层时和每次状态刷新时的 `GET /xbot-api/bots/:name/steps?n=20`；
     - 节点与监听：动态插入的 `#stp`、`#mshade`，点击文档关闭、窗口缩放时重新定位的监听；
     - 关闭步骤：登出时和 Escape 链里的关闭。
     侧栏跳转 `jumpToAttention` 一并删除。后端 `/steps` 路由不动；`app.css` 的 `.stp`、`.mshade` 规则和 `cafe-theme.css` 的 `.mshade` 选择器原样保留，只是不再有元素用到。
   - 保留的部分：
     - 回到标签页时重新读取状态：改为与其他文档级监听放在一起的一个顶层 `visibilitychange` 监听，只在已登录且页面可见时读取。
     - `spinIcon`、`workText`、窄侧栏的 `.rail-status`、行排序和右键菜单。
     - 信息抽屉上下文诊断里的「本轮」小节。
   - `chat-experience.js` 删去 `attend()`：只有已删除的侧栏跳转调用它。`locate()`、聊天状态行的「查看」「打开任务」「去确认」和运行诊断不变。
   - 测试：`tests/chat-experience-ui.test.ts` 新增一项侧栏回归。它取 `app.js` 自身的行、状态、选择和抽屉函数，配合真实的 `chat-experience-rules.js`，在该文件原有的小型 DOM 上按 390 宽度运行（这个 DOM 为此补了 `replaceWith`）。覆盖：
     - 猫和群处于处理中、排队、等你确认时，点第二行里的文字，点击冒泡到行，只打开该会话。
     - 每次状态变化都原位替换第二行，不重建行。
     - 侧栏抽屉打开时，点当前已打开的忙碌的猫、群或 pin 猫：抽屉收起，不重新选择。在对等对话中点则回到该会话。

     去掉 `closeDrawer()`，或给第二行加一个 `stopPropagation()` 的监听，这项测试都会失败。接线断言改为：`app.js` 里不再有 `/steps`、`experience.attend(` 和 `jumpToAttention`。审批、失败和按消息定位仍由该文件原有的状态行测试覆盖。
25. 2026-11-07 顶栏只显示猫名（用户要求：页面上方仅显示猫名，不显示他的简介）。`app.js` 的 `setStatus()` 在状态为空时不再回退显示猫的 `description`（服务端 `botItem` 给出的原生 `teamStrengths`），副标题随之隐藏；明确的错误、发送中/排队等状态与对等对话的只读说明照旧。只是 Bot 的显示选择：简介仍保留在资料、抽屉、侧栏预览等其他视图里，后端、上游、数据与 CSS 不变。
26. 2026-11-07 展开详情时的顶栏猫名（用户反馈：点开后猫名仍是一块淡色底，与变暗的底色不一致）。根因：`app.css` 给展开的 `.top-title.on` 填 `--x-fill-2`（悬停时 `--hover`），并以 `z-index: 29` 浮在抽屉遮罩（28）之上，没有随之变暗。`cafe-theme.css` 末尾一条规则让展开（含悬停）时无底色、`z-index: 27`，位于遮罩之下、仍在侧栏 backdrop（25）之上，与顶栏其余部分一起变暗。点击该位置落在遮罩上，由遮罩原有的处理关闭抽屉，效果与原先点按钮相同；聚焦时 Enter/Space 与 ⌘/Ctrl+\ 照旧开关。展开时悬停不再出「收起信息」提示，键盘聚焦仍会出。群组头像的接缝在展开时改取顶栏底色 `--bg`（不再取第 22 项的 `--hover`），不留淡色外圈。收起时的悬停、聚焦不变；`app.js`、DOM 与原 CSS 字节不变。
27. 2026-11-11 活的对话（回复写出来的样子、停止、回到最新）。接口以 [回复的实时呈现：接口约定](chat-live-api.md) 为准：线程 SSE 上的 `live` 事件（`start`、`thinking`、`step`、带原生累计长度 `end` 的 `text`、只表示「不再继续写」的 `done`）与会话行的 `in_progress`；停止用已有的 `POST /xbot-api/bots/:name/stop`、`POST /xbot-api/groups/:id/stop`。只做展示与请求记账，不保存回复、不补发、不排程；成稿与结局（完成、已停止、没完成）一律以随后读到的会话行为准。新增扩展 `chat-live-rules.js`（无 DOM 的规则，`window.ClowderLiveRules`）、`chat-live.js`（`window.ClowderLive`）、`chat-live.css`；行为测试 `tests/chat-live.test.ts`，两段真实采集的事件流（Claude Code 只追加；Codex 追加并多次整段替换）放在 `tests/fixtures/chat-live-claude.json`、`chat-live-codex.json`。
   - **回复写出来的样子**：进行中的回复是猫正常回复位置上的一行（头像、名字行与分组同成稿），还没有字时是气泡里的三个点，不写占位文字。引擎报 `thinking`/`step` 时，气泡下一行淡字用日常说法：在想…、在看 hello.txt、在写 / 在改 某文件、在运行命令、在翻找文件、在搜索「…」、在读 example.com、在分头处理、在列计划；MCP 工具按名字写在查找 / 在回想 / 在用浏览器 / 在用工具，其他未知工具一律「在处理」。Codex 的 `file_change`、`command_execution` 分别归为写文件和运行命令。不显示工具名、命令或路径，目标只取服务端已经缩成的文件名、主机名或查询词，带斜杠的不显示，过长截到一行。文字经与成稿相同的 Markdown 路径绘制，按动画帧节流，长回复按上一次绘制的耗时自动拉开间隔；写着的代码块先按闭合绘制；仍在写时最后一段后有柔和的光标。末尾独占一行的 `[…🐾]`、最后一行以 `[` 开头尚未闭合、整段只是 `SILENT` 或其前缀，写着时都不显示（与服务端同口径，代码块里的不算）。
   - **对齐**：一字不差地按契约。`replace` 整段替换（内容不变时不重绘）；`end - text.length` 等于已有长度才追加；`end` 不超过已有长度的丢弃；中间缺了一段的不拼，按原生位置等着，读到会话草稿补上缺口后再依次接上（缺口出现时提前约 1.5 秒读一次会话，而不是等下一次轮询）；没有 `end` 的只有从 `start` 起一片不落地看到时才追加，重连、`resync`、`disconnected` 之后、以及会话草稿补进了流还没送到的字之后，都不再追加（否则那一片会写两遍）。会话草稿取行里的原生 `content`（长度即流的位置），只能把文字补长，绝不用更旧更短的草稿替换已经写出的文字。引擎约 2 秒存一次草稿，存下的时间从读取的时间看不出来：本页还没见过整段替换时，接得上的草稿补长、接不上的草稿说明有一次替换本页没看到，以草稿为准；本页见过整段替换之后，草稿可能比替换更早（不管多晚读到），只用来补缺口，而且必须含有替换之后收到、正等在原位的那一片，否则不采用（审查 2026-11-11 第 1、2 条：旧草稿曾能撤销替换并让后面的片段被丢弃，草稿领先时无位置的片段曾重复）。
   - **成稿接手**：读到会话里这条回复不再 `in_progress` 时，成稿行按原生消息 ID 原位替换它，不闪、不再上浮、不跳；停下或没完成而已写了字的回复，成稿下多一行淡字「已停止」/「这次没完成」（按行的原生 `status`；没有字时服务端本身就写这两句）。成稿里没有这条回复（空回复、`SILENT`、转成执行过程）时，这一行在会话读取之后撤下。流断过、或中途才见到的回复若漏了 `done`：在一次「发出时间晚于它最后一次动静」的 activity 读取显示本会话线程里这只猫既没有处理中也没有排队后，才算结束（之后读到的会话里没有它就撤下这一行，后续发送照常有打字气泡）；那次读取失败、看不到队列、或计数多于列出项时都不下结论，会话里没有它本身也不算结束（审查第 3 条）。activity 读取由 `chat-experience.js` 新增的只读 `activityRead()` 交出，带着它的发出时间。
   - **发送即见**：发送时立刻出现自己的气泡（发送中）和猫的打字气泡；群聊在服务端说出是哪只猫之前，打字气泡不带头像（缩进同续行），第一只开始写的猫带着自己的头像和名字接过它，别的猫各占一行。只有看到 `start` 的回复才接过打字气泡，所以中途才看到的回复（例如开场问候）不会冒充这条发送的回答。会话读取按回复的原生 `replyTo`（它回答的那条消息）与回执的 `userMessageId` 对应：进行中的回复只接过它所回答的那条发送的打字气泡；已经在屏上自成一行的、回答这条发送的回复，让打字气泡撤下；流完全漏掉、第一次读到时已经写完的回复，原位接过那个打字气泡的位置（不再上浮），不会留下用户消息、成稿和又一个打字气泡（审查第 4 条）。会话记录没有 `replyTo` 时才退回按猫对应：漏了 `start`、在发送受理后才第一次见到的同一只猫的回复，会让打字气泡撤下。已有回复在写时追加发送不另起气泡（原生 `continue_current` 会接进当前一轮或排在后面）。发送的应答只是原生受理：它给出的 `userMessageId` 用来在会话里认出自己的这条，读到之前乐观气泡一直留着，不在 POST 与下一次读取之间消失。
   - **排队**：不再每次发送都闪「已排队」。打字气泡只在受理 2 秒后仍没开始、且状态里这条消息确实排在别的工作后面（单聊按状态里这只猫在本线程的排队项与 `userMessageId`，群聊按本线程 activity 的排队数）时，淡字写「排队中」；8 秒后状态里本会话既没有处理中也没有排队、且没人接手时，打字气泡撤下。群聊顶栏副标题不再停在「已排队」，单聊也不再写「正在回复」（第 25 项「发送中/排队等状态照旧」中的这两句由气泡与状态行取代）。
   - **不重建没变的行**：两种历史的绘制都经 `ClowderLive.commit()`：新画好的行按原生消息 ID（其次 seq、ID，其余按显示内容）与屏上的行配对；没变的保留原元素（不再上浮，选中的文字、展开的执行过程、滚动位置都在），变了的原位替换且不上浮（`.lv-still`），只有真正新出现的行才上浮；本页自己持有的行（发送中或失败的发送、回复错误、进行中回复的自有行）按屏上顺序跟在后面，已就位的元素从不移动。换会话时仍整段替换（与原版一样整屏上浮一次）。重绘判断不再包含进行中回复的草稿文字，草稿变长只交给 `chat-live.js`，不重建历史；只对由回复框绘制的行这样做，进行中的执行过程（`presentation_kind: 'activity'`，照旧由历史绘制）任何变化（新的工具结果、状态）仍会重绘（审查第 6 条）。
   - **少读会话**：线程 SSE 的 `native` 事件里，回复流已经画出的片段（流式 `text`、`tool_use`、`tool_result`、`system_info`、`session_init`、`status` 等）不再触发读取；`done`、`error`、队列、线程、任务、审批、连接器与消息更新、`resync`、`disconnected`、显式发言（非流式 `text`）和未知类型照旧去抖 180 ms 读取会话与状态。3 秒轮询保留，按上面的对齐规则不会冲掉更长的文字。服务端拒绝的 SSE（例如重启中）2 秒后重新打开。
   - **停止**：本会话的猫在工作（有进行中的回复、等着回复的发送，或状态里本线程有处理中 / 排队）且输入框为空时，发送按钮原位变成停止（箭头与方块交叉淡换）；输入框有字时仍是发送，追加的话由猫接进当前工作。停止只由点击按钮触发：停止模式下按钮不是提交按钮，空输入框按 Enter 不会停止，Esc 照旧只关闭浮层。点击后按钮不可用（「正在停止」），进行中的回复淡字写「正在停止…」，直到本会话不再有处理中或排队；停下后回复按会话所写结束（「已停止」等），已完成的动作不撤销，也不说已撤销。请求失败时顶栏写「没能停止：原因」并恢复按钮；20 秒仍没停下时恢复按钮并写「还没停下来，可以再点一次停止」。停止请求发出时已经受理、之后 1.5 秒仍没人接手的打字气泡在停止应答后撤下；停止发出之后才发送的、或换到别的会话后的打字气泡不受影响，换会话即作废这次清理（审查第 5 条）。
   - **回到最新**：在底部时，写着的文字、新出现的行和输入区变高都让视图贴住底部（状态行出现时也不遮住最后一行）；往上翻看时从不把视图拽回去，输入区上方出现一个小圆钮（向下箭头；服务端有未读回复时附「N 条新回复」，数取自 activity 的 `unread`），点一下回到底部（减少动效时直接跳），回到底部后它淡出。
   - **侧栏**：进行中的回复不作预览（单聊、群聊），所以预览不会停在半句话或占位字上；处理中仍显示原有的转圈与「在处理」。
   - **动效**：只用 180 ms ease-out 与已有的弹出曲线 token：新行上浮只给新行；打字的三点改为 1.2 秒一轮、错开 160 ms 的轻起伏（原 180 ms 往返），结束后静止；淡字变化交叉淡换；光标呼吸；发送 / 停止图标缩放交换；回到最新淡入上移。`prefers-reduced-motion` 时全部停止：`app.css` 的全局规则关闭 CSS 动画与过渡，`chat-live.js` 另外跳过交叉淡换，并用瞬时滚动。
   - `app.js`：新增 `replyFrame`、`liveRow`、`catWho`、`liveRows`、`sigRows`、`endedNote`、`chatKey`、`sendFeedback`（取代 `restoreSendFeedback`）、`botCatId`、`statusBusy`、`chatWorking`、`sendQueued`、`stopChat`、`settleStop`；`renderMessages`/`renderGroup` 给历史标 `data-chat`、把进行中的行画成回复框、改经 `live.commit()` 上屏；`loadThread` 在比较签名前交出草稿（`live.read`），签名不变时 `live.attach()`；`watchNativeThread` 增加 `live` 监听、按事件类型决定是否读取、拒绝后重开；`sendText` 去掉直连 SSE 的解析，按回执认出自己的消息；`liveRows` 带上回复的原生 `replyTo`；`syncComposer` 加停止模式；`refreshStatus` 后同步按钮；`resetConversation` 调 `live.select`。删除：`liveBubble`、`readSSE`（及其从未被这个服务端触发的 `part`/`tool`/`result`/`approval`/`done` 分支）、`setWorking`、只给 `readSSE` 用的 `approvalCard`、`paintStatus` 里往进行中气泡塞 `.live-status` 的分支、发送的 `queued` 标记与「已排队」「正在回复」两处文字。`pendingApprovalCard`、`workText` 等仍有别处使用，保留；原 CSS（含 `.live-status`、`.typing-dots` 原规则）字节不变，`chat-live.css` 只在其后覆盖三点的动画。
   - `index.html`：`chat-experience.js` 之后、`account.js`/`app.js` 之前依次加载 `chat-live-rules.js`、`chat-live.js`；`chat-live.css` 排在全部样式最后。`tests/chat-experience-ui.test.ts`、`tests/workspace-ui.test.ts` 的样式顺序断言随之改为最后两项是 `chat-experience.css`、`chat-live.css`，消息行带 `data-mid` 的位置由 3 处变为 4 处（加上进行中的回复框），`botBubble` 测试的假环境补上 `endedNote`。
   - 已知局限：中途打开页面或重连后，文字要等会话草稿补上缺口才接着走（引擎约 2 秒存一次草稿，最长等几秒）；会话读取之前，打字气泡由同一只猫下一次的 `start` 接过（`live` 事件不带它回答的消息），读到会话后才按 `replyTo` 核对；漏了 `done` 的回复要等下一次 activity 读取（约 6 秒一次）才结束；群聊的「排队中」只看本线程的排队数，不区分是哪一条；写着的 Markdown 未闭合时（如半个 `**`、半个表格）会先按原样显示，写完即正常。
28. 2026-11-11 开箱即用：第一次打开、新建猫猫与新建群聊（用户要求首屏和建猫、建群开箱即用，方向参考 Grok Bot 的「起个名字、选张图、创建」与「加几只进群，群名自动生成」；功能可用且好用，界面简洁高级，动效合理）。接口以 [XBot 兼容层](xbot-api.md)「开箱即用」为准：`GET /xbot-api/start[?refresh=1]`、`POST /xbot-api/bots {name, simple:{face?, about?, agent?}, idempotencyKey}`、`POST /xbot-api/groups {members, name?}`。新增扩展 `quick-create-rules.js`（无 DOM 的规则，`window.ClowderQuickCreateRules`）、`quick-create.js`（`window.ClowderQuickCreate`：`stage`、`noChat`、`openCat`、`openGroup`）、`quick-create.css`。
   - 首屏（还没有猫猫）：原「选一个对话 / 左边是你的 Bot。」和可以打字却发不出去的输入框，改为主区里的「领一只猫猫回家」。八只陶土猫排成一排（手机 4×2），是一个 radiogroup，只有一个 Tab 停点：点一下或方向键、Home、End 就换。默认选中与默认工具相配的那只（Claude Code → 布偶猫，Codex → 缅因猫，Kimi → 梵花猫，与适配层不传猫脸时的选择相同；否则第一只）。选中的那只走上前、坐上 `--x-fill-1` 圆垫并显示品种名，其余略小、略淡。名字预填所选猫脸的预设昵称（`cat-avatars.js`），换脸时跟着换，直到用户自己输入（清空后再跟随），已占用时后接「 2」「 3」。主按钮「带它回家」。下面一行安静的「它会用这台电脑上的 X 来思考」：可用工具（已登录，或已安装但没能确认登录）不止一个时，X 是一个原生 select，没确认登录的标「（未确认登录）」；没动过猫脸时换工具，猫脸也跟着换。`agent.confirmed` 为假时如实写「没能确认 Codex 已经登录。还没登录的话，先在终端里运行：」，并附可复制的原生 `loginCommand`。首屏不自动聚焦：先看到猫，手机也不弹键盘。
   - 交接（这一轮的那一点记忆点）：创建成功后，选中的猫从首屏或弹层原位滑到聊天顶栏这只猫的头像上（340ms，抽屉同款曲线，一次直线，不回弹）。落点按顶栏的近景裁切（第 21 项，1.25 倍）换算成同样大小，落地后换成真头像，看不出接缝；首屏其余内容在 120ms 内淡出。之后照常打开空聊天，由已有的问候流程（第 23 项）请猫自己打招呼。`prefers-reduced-motion` 或取不到布局时不滑动。
   - 被挡住时不演示、不假装：`login_required` 写「还差一步：登录 Codex」（不止一个时「Codex 或 Claude Code」），附每个工具的原生登录命令（复制按钮）和「重新检测」；`no_agent` 写「还差一步：装好 Claude Code 或 Codex」和「重新检测」。重新检测发 `?refresh=1`：结果与上次相同就直说「重新检测过了，还是没检测到登录。」或「重新检测过了，还是没找到能用的。」，有变化写「检测结果有变化。」，变成可用时表单出现、焦点落到名字。检测中按钮用 `aria-disabled` 而不禁用，焦点不丢。这时猫脸一排只是图（`aria-hidden`，全部坐后）。读取 `/start` 失败写原因加「重试」。
   - 创建失败原位说明，不跳走：名字先按服务端 `label` 校验（去空白后 1–64 个字符，只能有文字、数字、空格和 _ . -；zod 按字符计数），并与已有名字不分大小写比较。409 标在名字上：「已经有一只叫「X」的猫猫了，换个名字吧」。422 重新读取 `/start`，切到被挡住的说明，并注明「刚才没能建好：Codex 现在用不了。」。没有应答或 5xx 写「没能确认猫猫建好没有。不改内容再点一次就好，不会多出一只。」，同时刷新列表。同样的内容重发沿用同一个 `idempotencyKey`（按请求体指纹），内容变了换新键；请求体总带着显示给用户的那个 `agent`，重发因此是同一个请求。创建成功但聊天没能打开时，首屏写「「X」已经到家了，只是没能打开聊天。」加「打开聊天」，不会再建第二只。
   - 没有打开的聊天就没有输入框：`app.js` 给这类视图的 `.thread-inner` 加 `no-chat`，`quick-create.css` 用 `.main:has(.thread-inner.no-chat) .dock` 隐藏输入框和状态行，登录前的占位也一样。有猫猫却没有打开的聊天时显示「选一个聊天 / 从列表里选一只猫猫或一个群聊。」，手机上另有「打开列表」（与顶栏列表按钮相同）。启动时有猫总会打开一只，所以这一页只在少数情况出现。
   - 新建 → 新建猫猫：一个小弹层，同一套猫脸与名字（`catFlow` 与首屏共用），另加一行可不填的「它主要帮你做什么」（成为 `simple.about`）、同样的工具一行和「创建」。左下低调的「更多设置」关闭弹层并打开原模板创建（`cat-templates.js` 的 `openCreate`，行为与文案不变）。被挡住时弹层里显示同样的说明，「更多设置」仍在。
   - 新建 → 新建群聊（原「新建群组」）：每只猫是带头像的选择片（原生 checkbox），按点选顺序排成员（第一只坐在群头像最前），2–10 只。少于两只时「创建」不可用，并提示还差几只；满 10 只后其余不可选。群名可不填，占位文字就是不填时服务端会起的名字：成员名用「、」连接，按服务端 `clip` 同样截断。群名按服务端 `groupTitle` 校验。没有应答时说明「没能确认群聊建好没有。先看看列表里有没有它，再决定要不要重试。」并刷新列表；这个接口没有请求标识，所以不自动重试。不到两只猫时，弹层写「群聊至少要两只猫猫，现在只有 1 只。」，并给出「新建猫猫」。
   - 弹层沿用 `.modal`/`.modal-card`，一次只开一个：Escape 关闭（请求进行中除外）、Tab 不出层、Enter 提交，关闭后焦点回到打开它的按钮；请求进行中焦点停在弹层上，不随禁用的按钮丢失。
   - 文案只说猫猫、猫猫的名字和工具名。服务端原话里带 Bot、Agent 或模型字样的（例如 422 的「请先在本机 Agent 中完成登录」）不直接显示，改用上面的说法。
   - `app.js`（局部小改，不碰消息绘制、发送与 SSE）：顶部加模块引用 `quick`；`experience.init` 之后加 `quick.init({api, icon, face, cats, copy, refresh, openCat, openGroup, landing, more, showList, error})`，其中 `landing` 是顶栏里这只猫的头像（`#title .avatar[data-avatar-bot]`）。`boot()` 无选择时改调新增的 `showNoChat()`（没有猫猫用 `quick.stage()`，否则 `quick.noChat()`），登录前占位 `hold` 加 `no-chat`。`confirmDelete` 删到没有猫时也 `showNoChat()`，原先主区还留着被删的对话。新建菜单与 `rail-new` 的提示和无障碍名改为「新建猫猫或群聊」；菜单项「新建群组」改为「新建群聊」并传入打开它的按钮；菜单里按 Escape 只关菜单并回到「新建」（`closeNewMenu` 注释早已这样写，原来只能点外面关闭）。`openNewBot(opener)` 改为打开快速弹层；原模板创建原样移到 `openTemplateCreate(opener)`，由「更多设置」调用。`openNewGroup(opener)` 改为 `quick.openGroup`，原 `openModal` 表单删除。
   - `index.html`：`quick-create-rules.js`、`quick-create.js` 在 `chat-experience.js` 之后、`account.js` 与 `app.js` 之前加载；`quick-create.css` 排在 `chat-experience.css` 之后、`chat-live.css`（第 27 项，保持最后）之前；`rail-new` 的无障碍名改为「新建猫猫或群聊」。
   - `quick-create.css` 只用已有 token、动效时长（`--dur-pop`、`--press-scale`）、`app.css` 已有的 `rise`/`fade` 关键帧和抽屉的缓动曲线，不新增颜色、字体或关键帧；浅色、深色随 token 切换，窄于 560px 时猫脸改为 4×2。原 CSS 字节不变。
   - 测试：新增 `tests/quick-create.test.ts`（22 项）。规则部分：名字、群名规则直接对照从 `server/xbot/core.ts` 取出的 zod `label`/`groupTitle` 跑同一组样例（这样发现 zod 按字符而非 UTF-16 计长），群名预览对照 `server/native/text.ts` 的 `clip`；猫脸与工具、昵称去重与跟随；`/start` 的可选工具、未确认不算就绪、挡住时的说明与命令；请求体与失败分类。页面部分用小型 DOM：首屏默认、单一 Tab 停点、不抢焦点；点选与方向键、名字跟随；换工具与请求体；结果不明时同键同体重发、改内容换新键、409 标名字；发送前拦下非法名字；422 → 被挡住、复制命令、重新检测无变化时直说并保住焦点、可用后表单回来；没有工具与读取失败重试；未确认登录；建好但没打开；无聊天页；快速弹层的焦点、Tab、Escape、重名拦截、可选一行、请求中不可关闭、「更多设置」交接与被挡住；群聊不到两只、2–10 只与顺序、群名占位与校验、结果不明；静态接线与文案用词。`tests/chat-experience-ui.test.ts`、`tests/workspace-ui.test.ts` 的样式顺序断言改为其后只跟 `quick-create.css`，后者「新建群组」的静态断言改为检查快速弹层的请求体只有成员与可选群名、没有项目或工作区字段。
   - 验证：`npm test` 277 项（275 通过，2 项按原生环境开关跳过），`npm run typecheck`、`npm run verify:frontend` 通过。在脚本化预览（`scripts/preview-fixture.ts`，不连引擎、不调用模型）上用无头 Chromium 于 1440×900 与 390×844、浅色与深色逐一查看：两个工具、未确认登录、需要登录、什么都没装、重新检测有无变化、名字不合规、重名 409、请求中断后同键重发、422 转为被挡住、创建 → 顶栏交接 → 猫的问候、快速弹层（含「更多设置」打开原模板创建）、新建群聊（含不到两只）、无聊天页。除故意制造的 409、422 和中断请求外，没有控制台错误。
29. 2026-11-11 找得到（一）：搜索与跳转（用户方向 Grok Bot 的「⌘K 搜联系人、群、消息和设置」；要求功能可用且好用，界面简洁高级，动效合理）。接口以 [XBot 兼容层](xbot-api.md)「搜索」为准：`GET /xbot-api/search?q=<1–100 字>` → `{results[], more, searched, failed}`，每条带 `chat`、`threadId`、`current`、`messageId`、`time`、`from`、`catName`、`snippet`、`match`。只做展示与请求记账，不建索引、不存结果；打开聊天、切换历史对话和每个操作都走已有的函数。新增扩展 `palette-rules.js`（无 DOM 的规则，`window.ClowderPaletteRules`）、`palette.js`（`window.ClowderPalette`）、`palette.css`；行为测试 `tests/palette.test.ts`。
   - 入口：⌘K（macOS）或 Ctrl+K（其他系统；macOS 上 Ctrl+K 仍是文本框的删到行尾），以及侧栏问候语下面一行安静的「搜索」（放大镜、文字、右侧 ⌘K 小键帽）。这一行在列表滚动时停在顶部，置顶行停在它下面；窄侧栏只剩放大镜，悬停提示「搜索 ⌘K」；触屏上不显示键帽。设置、弹层、看图等别的对话框开着时、未登录时，快捷键不响应，也不拦浏览器自己的处理；⌘N、⌘1–9 等浏览器保留键一概不碰。
   - 样子：桌面是窗口上方 12% 处的一张卡片（`--x-popover`、16px 圆角、浮层阴影，遮罩 `--x-scrim`），上面是输入框和 esc 键帽，中间是分组结果，底部一条淡色的按键提示（↑↓ 选择、↵ 打开、esc 关闭、⌥↑↓ 上一个、下一个聊天）。手机（< 768px）是铺满全屏的一页，右上「取消」，没有按键提示，行高 48px，输入框 16px 字号不触发缩放。分隔只靠底色和间距。打开时卡片 180ms 上浮、遮罩淡入（`app.css` 已有的 `rise`/`fade`），减少动效时没有动画。
   - 没输入时：「最近」是侧栏最上面的 6 个聊天（不含当前打开的；侧栏排序改成按最近活动后自然跟着变），下面是「操作」。
   - 输入时：「猫猫和群聊」当场按名字筛（整名 > 开头 > 后面某个词的开头 > 任意位置，不分大小写；群聊也认成员名，排在所有名字匹配之后，写「有 团子」；同分保持侧栏顺序；当前打开的标「当前」），「操作」按名字或关键词筛（「夜间」能找到「切换深浅色」）。停手 220ms 后搜「聊过的话」：新的输入会取消上一个请求，迟到的应答丢弃；同样的字（只差首尾空白）不重复请求；输入法拼写中不筛不搜。每条结果是这个聊天的头像、聊天名、右侧时间（今天写时刻，昨天，今年写几月几日，更早写年月日），第二行「你：」或「团子：」加片段，命中的字按服务端 `match` 加粗并衬 `--x-fill-3`；偏移对不上片段时什么都不标，不标错字。猫的历史对话（`current: false`）标「之前的对话」。超过 100 个字时不发请求，直说「最多可以搜 100 个字。」
   - 如实说明搜到了多少（在列表下方，始终看得见，`role="status"`）：等待时「正在找聊过的话…」；`failed > 0` 时「有 N 个对话暂时读不到，没能在里面找」，有结果时加「结果可能不全」；没找到时只说「能读到的对话里没有找到「…」」（全部读到时「聊过的话里没有找到「…」」），从不把读不到当成没有；`more` 为真时，结果满 30 条写「只列出了最新的 30 条，可能还有更多」，否则写「只搜了最近的消息，更早的里可能还有」。请求失败写「没能搜索聊过的话：原因」加「重试」；返回格式不对按失败说；后端没有这个接口（404）写「当前后端还没有开放消息搜索。」，不给重试。另有一句只给读屏软件的「找到 N 个聊天，M 条消息」。
   - Enter：聊天 → 打开它（侧栏同款 `pickBot`/`pickGroup`：已打开的保持原样，窄屏只收起列表），桌面上焦点交给输入框。消息（当前对话）→ 打开它所在的聊天，再按原生消息 ID 找到这一行：默认用 `chat-experience.js` 已有的 `locate`（滚到中间、闪一下、聚焦这一行），只在屏上已画出的消息里找；找不到时提示「这条消息不在已显示的消息里，可能在更早的记录里。」，聊天停在最新处，不猜。消息（之前的对话）→ 先在卡片里说清楚：「在之前的一段对话里 / 这条是你和年糕之前的一段对话里说的。切过去以后，和年糕说的话会接着那段对话。」并引用这条话，「取消」「切换到那段对话」（Esc 回到列表）；确认后打开这只猫的聊天，走 `workspace.js` 已有的历史对话切换（同样的 `expectedThreadId`、待发送附件先确认、任一边忙就拒绝），拒绝时把原因如实提示出来，什么都不动；切换成功后再找这条消息。操作 → 先关掉搜索、焦点回到原处，再调用应用自己的函数（新建猫猫、新建群聊打开第 28 项的快速弹层，设置打开设置，切换深浅色在浅色与深色之间切换并记住）。
   - 键盘与焦点：↑/↓ 在所有结果里循环移动（`aria-activedescendant`，焦点一直在输入框），鼠标移过即选中、点一下即打开且不夺走输入框的光标；Esc 关闭（追问时先退回列表），⌘K 再按一次也关闭；Tab 只在卡片里的控件间循环，焦点跑出去会被拉回；打开期间 `#shell` 设为 `inert`；关闭后焦点回到打开前的位置（侧栏的「搜索」或输入框），原位置不在了就交给输入框。卡片里的按键一律不再冒泡给页面自己的 Escape、⌘\ 等处理。
   - Alt+↑ / Alt+↓：按侧栏从上到下的顺序打开上一个、下一个聊天（置顶行、分组里展开的猫、群聊；收起的分组跳过），到头就停，不绕回；没有打开的聊天时 ↓ 取第一个、↑ 取最后一个。在输入框里也能用；焦点在别的输入框（抽屉里的表单等）时方向键保持原意。
   - 查找某个聊天：`ClowderPalette.open({scope: {type: 'bot'|'group', id}, query?})`（猫猫按名字或原生 ID，群聊按 ID），供另一项工作的顶栏菜单「在对话里查找」调用。输入框前多一个可移除的聊天名小标签，占位「在和团子的聊天里查找」；聊天列表和操作都收起，只留这只猫当前对话（或这个群聊）里的结果（按 `chat.type`/`chat.id` 与 `current` 过滤服务端结果），空输入时提示要输入什么；输入框为空时按退格移除范围。因为服务端只返回全部聊天里最新的 30 条，范围内为空而 `more` 为真时如实写「只看了所有聊天里最新的 30 条，这段对话里可能还有。」
   - 给其他工作接的口：`ClowderPalette.open/close/isOpen`；`ClowderPalette.actions`（`add` 同 ID 即替换、`remove`、`get`、`list`；条目 `{id, label, icon?, keywords?, hint?, when?(ctx), run(ctx)}`，`ctx` 是 `{selection, opener}`），现在只放了今天就能用的四项，新对话、历史对话等由合并后的代码按 `when: ctx => ctx.selection?.type === 'bot'` 加入；`ClowderPalette.locate = async ({type, id, messageId, threadId}) => boolean` 可以整个替换（例如换成会往前加载更早消息直到找到的版本），搜索在打开那个聊天之后调用它。
   - 没有猫猫时（第 28 项的首屏）：搜索照样能打开，只给「新建猫猫」「设置」「切换深浅色」，没有成员可选的「新建群聊」不出现。
   - 顺带修好的已有问题：`chat-experience.js` 的定位闪烁 `cx-hit` 用的是 `app.css` 的 `quote-flash`，后者读 `--bubble-fill`，而这个变量从来没有定义：自己的气泡在闪烁的 1.5 秒里变透明，浅色文字看不见；猫的气泡则根本不闪（动画加在没有底色的 `.body` 上）。`chat-experience.css` 给两种气泡各自的底色变量，并让猫的气泡本身闪烁；自己的气泡本来就是强调色，改为向页面底色方向淡一点。只用已有 token 和原关键帧，原 CSS 字节不变。`app.css` 里引用回复用的 `quote-hit` 有同样的问题，不在本项范围内，未改。
   - `app.js`（两处局部小改）：`showToast(text, iconName = "check")` 增加可选图标参数（搜索的提示用 `info`，原有调用不变）；在 ⌘\ 快捷键处理之后新增一段 `window.ClowderPalette.init({...})`，传入 `api`、`icon`、`visibleError`、`composer`、`chats`（猫按名字和原生 ID、群聊按 ID 与成员）、`order`（侧栏行从上到下）、`face`、`selection`（对等对话时为空）、`open`（`pickBot`/`pickGroup`）、`history`（当前画出的聊天）、`switchConversation`（`workspace.switchTo`）、`newCat`/`newGroup`（`openNewBot(opener)`/`openNewGroup(opener)`）、`settings`、`theme`/`setTheme`（`applyTheme`）、`note`（`showToast(text, "info")`）、`focusComposer`、`blocked`（`shell.hidden`）。消息绘制、发送、SSE 与 `ClowderLive.commit()` 都没有动，搜索不往会话里加任何行。
   - `workspace.js`：历史对话的 `switchConversation` 现在返回结果（`{ok: true}`、`{ok: false, text}`，或用户留下附件、会话已变时的 `{ok: false}`），拒绝时折叠区里的说法不变；新增并导出 `switchTo(threadId, opener)`：先读一次这只猫的历史对话列表，只切到服务端列出的那段（不在列表里时「这段对话已不在这只猫的历史对话里。」），其余规则与点列表完全相同。
   - `index.html`：侧栏 `#greeting` 之后加一行 `.pal-entry-wrap > #palette-open`（放大镜与键帽由 `palette.js` 填入）；`palette-rules.js`、`palette.js` 在 `quick-create.js` 之后、`account.js` 与 `app.js` 之前加载；`palette.css` 排在 `quick-create.css` 之后、`chat-live.css`（保持最后）之前。
   - 文案：猫猫、猫猫的名字、群聊、对话；不出现 Bot、Agent、会话、原生等词（测试逐条检查两个脚本里的字符串）。
   - 测试：新增 `tests/palette.test.ts`（18 项）。规则：名字排序与成员匹配、侧栏顺序与「最近」、操作的 `when` 与关键词、查询长度、范围与按原生 ID 找聊天、片段标记与错位偏移、各种「搜到了多少」的说法（含范围内）、时间、循环光标、Alt 方向键到头即停、快捷键（含其他键盘布局、输入法、浏览器保留键）。页面部分用小型 DOM 与假计时器：⌘K 打开、`inert`、空输入内容、Esc 与焦点归还、入口按钮；被其他对话框挡住；即时筛名、220ms 防抖、取消旧请求、丢弃迟到应答、同词不重发、过长不发；部分结果、失败重试、404、格式不对；↑/↓ 循环、Enter 打开、Tab 不出卡片、焦点拉回；定位命中、不在屏上时的提示、可替换的 `locate`；之前的对话先问、Esc 退回、拒绝如实提示、成功后定位；范围搜索与移除范围；操作的打开者、注册表的增删替换、没有猫时的操作；Alt 方向键与别的输入框、对话框；默认 `locate` 只认当前画出的聊天；静态接线、样式顺序、只用已有 token 与关键帧。`tests/workspace-ui.test.ts` 新增一项 `switchTo`（已在、不在列表、忙时拒绝、成功后重开、群聊）。`tests/chat-experience-ui.test.ts`、`tests/workspace-ui.test.ts`、`tests/quick-create.test.ts` 的样式顺序断言加入 `palette.css`。
   - 验证：`npm test` 334 项（332 通过，2 项按原生环境开关跳过；本项基于的 main `b2297f07` 为 315 项），`npm run typecheck`、`npm run verify:frontend` 通过。在脚本化预览上（3 只猫：两段单聊、一个群聊，年糕有一段之前的对话）用无头 Chromium 于 1440×900 与 390×844、浅色与深色逐一查看：侧栏入口与窄侧栏、空输入、按名字筛、等待中、结果、方向键、打开聊天、定位并闪烁（自己的气泡文字可见）、之前的对话的追问与切换、范围搜索（单聊与群聊）、操作（切换深浅色）、部分结果与读不到的说明（用浏览器替换应答模拟 `failed`/`more`）、什么都没找到、请求失败与重试、没有猫猫的首屏。除故意模拟的 500 外没有控制台错误。
   - 已知局限：不往前加载更早的消息，屏上没有的那条只提示不定位（`locate` 留给另一项工作替换）；片段是服务端给的显示文字，Markdown 记号（如 `**`、反引号、表格竖线）会原样出现；服务端只返回全部聊天里最新的 30 条，范围搜索可能因此漏掉，已如实提示；搜索结果不随会话的新消息自动刷新，重新输入即可。

头像候选保留 N 手绘墨稿、G 3D 玩偶肖像、I 水彩绘本。`/avatar-lab/` 展示当前候选，首轮和第二轮完整样页均归档保留；应用暂不提供这三种画风的主题切换控件。

不再运行之前的 `client/src/` React 应用。原始 persona、memory、新建 Bot、群聊、详情抽屉与设置界面保留（设置按第 15 项精简为四项）；providers 的模型目录、密钥/OAuth 与模型绑定界面按第 8 项移除，`providers.css` 原样保留供消息引用与弹层复用。账号登录界面和侧栏的跨设备分组保留原结构，设置里的账号、设备页按第 15 项移除；本地兼容层以已认证的 session 进入主界面，不要求用户登录账号。

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
