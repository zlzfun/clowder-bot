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
16. 2026-11-04 项目、工作区、附件与协作任务（用户要求：聊天里能用项目与猫猫工作区、附件与交付物、按任务的负责成员与交接记录，交互组织参考 OpenBot，不整体改版）。其中的项目、工作区切换、新建任务与指派已由第 17 项收起，以下保留为当时的接线记录。新增扩展 `workspace-rules.js`（无 DOM 的规则）、`workspace.js`（`window.ClowderWorkspace`）、`workspace.css`；设计、文案、交互约束与已知限制见 [项目、工作区、附件与协作任务前端规范](workspace-ui.md)。本项只记录原文件的接线。
   - `index.html`：在 `cat-templates.js` 之后、`account.js` 与 `app.js` 之前依次加载 `runtime-tasks.js`（运行面板已有的原生 Task 规则，这里只复用其判断，不调用它的 `load`）、`workspace-rules.js`、`workspace.js`；`workspace.css` 排在全部样式最后（`chat-presentation.css` 之后）。DOM 结构不变：回形针按钮、顶栏工作区按钮和任务条由 `workspace.js` 在启动时插入（输入框原有的空 `plus` 列、`#head-chip` 之后、`#work-status` 之后）。
   - `app.js` 启动：在 `syncSidebar()` 前调用 `workspace.init({...})`，传入壳层已有的 `api`、`apiFetch`、`icon`、`visibleError`、`syncComposer`、`closePops`、`showToast`、`setStatus`、`copyText`、`openShots`（看图）、按原生猫 ID 取头像与名字的 `face`/`catName`，以及 `peer`、`busy`、`reselect`（切换项目后重新 `selectBot`）、`reload`、`repaintPanel`、`openTab`（打开抽屉到指定页）。`closePops()` 末尾一并关闭模块的菜单。
   - `app.js` 会话：`resetConversation()` 改为调用 `workspace.select(state.sel)`（取代原 `clearAttach()`）；`loadThread()` 每次读到单聊记录或群聊消息后调用 `workspace.observe(selection, 线程 ID, 是否有变化)`；原生 SSE 触发的那次读取前先 `workspace.touch()`，让任务和文件随之刷新。
   - `app.js` 附件：删除只收图片、上传到已退役 `/paste` 的整段实现（`ATTACH_MAX`、`attachState`、`attachNote`、`paintAttach`、`removeAttach`、`clearAttach`、`uploadAttach`、`imagesFrom`）和 `state.attach`、`state.attachBatch`；`attachReady()`、`attachBusy()` 改为委托模块，`syncComposer()` 按就绪数量判断。提交时 `workspace.takeAttachments()` 取走已就绪文件；上传中仍提示等待。粘贴与拖放改用 `workspace.filesFrom/carriesFiles/addFiles` 接收任意文件，粘贴文件时 `stopImmediatePropagation()`，不再把文件名当文本贴入；对等对话中不显示拖入描边。
   - `app.js` 发送：`sendText(text, pending, images, files)` 多一个 `files` 参数；请求体增加 `idempotencyKey`（新增 `requestKey()`）、附件的 `attachments` 与 `expectedThreadId`（无附件时也带上当前线程，避免发进已经换掉的会话）；非 2xx 时读取服务端 `error` 与状态码。没有发出去时 `workspace.giveBack(files)` 放回附件，失败行写明「没发出去：中文原因，原文还在输入框里，附件已放回」；结果未知（无应答或 5xx）时同样的文字和附件重发沿用原幂等键，4xx 换新键；409 后重新读取会话。乐观行用 `workspace.cards(…, {sending: true})` 显示随消息发送的文件。
   - `app.js` 消息：`userBubble`、`botBubble`（新增 `last` 参数，文件只挂在一条消息的最后一个气泡下）、`renderGroup` 按 `m.attachments` 追加 `workspace.cards(…)`；只有附件的消息不再画空气泡或「这次没有收到回复」，旧版无 `say` 的猫猫行有附件时也照常显示。
   - `app.js` 抽屉：`TABS` 在「任务」后加 `["files", "文件"]`；`paintPanel()` 增加一条快速路径：当前页是模块仍在用的页面（`workspace.current()`）时只更新顶部而不重建，单聊「任务」页仍走原快速路径；单聊「任务」页为 `workspace.tasksView()` + 小标题「执行与例程」+ 原 `computerView()`，群组「任务」页由「没有任务」占位改为 `workspace.tasksView()`；两者的「文件」页为 `workspace.filesView()`。`syncTaskView()` 的空状态标题由「没有任务」改为「没有执行或例程」。输入框上方「子代理在跑」那一行点开后滚动到「执行与例程」。
   - `app.js` 新建群组：`openNewGroup()` 通过 `openModal` 的 `after` 回调加入 `workspace.projectField(modalFields)`，选了项目时请求体带 `projectId`。
   - 不改原 CSS：新样式只在 `workspace.css`，覆盖抽屉标签在窄抽屉里的间距与横向滚动，其余均为新类名。测试：`tests/workspace-ui.test.ts`（附件限额与放回、按线程上传与切换中止、上传失败重试与焦点、缺失图片的说明、请求交接不改负责成员且重试沿用幂等键、负责版本变化后撤下旧负责成员提示与回执、迟到的交接 202 / 指派 / 停止应答不覆盖已读到的新版本、停止请求体与恢复等待、指派与负责记录、历史标记关闭、过期应答不落到新会话、新建任务、项目切换与拒绝、群组工作区固定、页面接线）。
17. 2026-11-05 精简文件与任务（用户看过参考 OpenBot 的功能后批准：保留附件与交付物；负责人与交接由 Clowder AI 原生 Task 负责，不另建负责体系或咨询、转交模式；收起项目与工作区管理，使用自动默认目录）。现行规范见 [文件、历史对话与聊天任务前端规范](workspace-ui.md)，服务端见 [默认文件目录与原生协作](default-files.md)。
   - `workspace.js`：删除顶栏工作区按钮与项目菜单、新建项目弹层、群组项目下拉，以及对 `/xbot-api/projects` 与 `PUT <scope>/workspace` 的全部调用。「文件」页只直接显示「交付物」「附件」；工作目录路径、目录浏览与「存为交付物」收进默认收起的「更多文件」，展开前不读取目录；工作区身份卡片与首屏的目录切换删除。不显示服务端的 `defaultRoot`、`filePolicy`，也不作只读或保护声明。任务卡改称「任务」「负责人」「请求传球」「流转记录」，删除「新建任务」表单与「指派 / 改派」（前端不再 `POST <scope>/tasks`、`PATCH <scope>/tasks/:id`）；负责人仍只取自读到的 Task，传球仍是异步请求，停止 / 撤销 / 恢复与防过期规则不变。新增 `conversationsView()`：猫猫已知对话多于一个时，「详情」里出现默认收起的「历史对话」，只经 `PUT /xbot-api/bots/:name/conversation {threadId, expectedThreadId}` 在已知线程间切换，沿用线程确认、待发送附件确认与迟到应答丢弃；群组没有这一项。
   - `workspace-rules.js`：删除 `assignBlocked`；流转记录的方式改为「传球 / 手动指派 / 认领」（未知为「负责人变更」）；新增 `conversations()` 整理历史对话（去重、单行标题、新的在前）。
   - `workspace.css`：删除顶栏按钮、菜单、工作区卡片、项目下拉、新建任务表单的规则；新增「更多文件」「历史对话」折叠和负责人标签的少量规则，只用已有 token，原 CSS 字节不变。
   - `app.js`：`openNewGroup()` 恢复为提交前的原版（只有名字与成员）；`closePops()` 不再调用模块；`workspace.init` 不再传 `closePops`、`botLabel`；`detailsView()` 在「配置」之后追加模块返回的历史对话节点（没有时不追加）；相关注释改掉「项目」「协作任务」的说法。其余第 16 项的附件、发送、消息与抽屉接线不变。`index.html` 未改。
   - 测试：`tests/workspace-ui.test.ts` 按新文案与入口更新，新增：收起的入口（无顶栏按钮、无项目请求与切换、新建群组只发名字与成员）、「文件」首屏无路径而展开后才读取与保存快照、旧项目会话的共享目录只在展开区、流转记录的方式区分、没有新建与指派、恢复请求体与说明、历史对话的出现条件、切换请求体与忙碌拒绝、待发送附件确认、发送中与切换中的限制、迟到应答与旧列表应答不生效、确认期间线程变化、应答前已到该线程时不再重开、同一线程刷新不重读也不丢附件、重绘后焦点回到原行。测试里的假 DOM 补上 focusin/focusout，DOM 节点按引用比较。

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
