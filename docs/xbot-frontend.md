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
