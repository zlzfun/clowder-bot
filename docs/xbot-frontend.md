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
