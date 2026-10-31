# 参考与复用边界

clowder-bot 是独立项目，不代表上游项目，也没有上游官方背书。

## 后端：Clowder AI

- 仓库：https://github.com/zts212653/clowder-ai
- 对照版本：`b2c9952f27d31480191ff6fd120789405c97238c`
- 从 `cat-template.json` 的 `roleTemplates` 提取八种角色的默认职责、性格和能力；模型绑定由用户自行配置。
- 核心参考：明确的 @ 提及路由、成员名单注入、有限传球链、每会话的运行隔离、上下文预算、滚动摘要和原文保留、分层记忆。
- 具体源文件、移植规则和简化点见 [后端对照](backend-reference.md) 和 [Provider 对照](provider-reference.md)。
- 上游软件采用 MIT；已保留 [完整许可](licenses/clowder-ai-MIT.txt)。直接派生的代码也带有来源注释。
- 没有移植整个上游平台，没有引入 Redis、语音、插件、MCP 工具管理、猫猫球或远端调度。

## 界面：XBot

- 仓库：https://github.com/liu-zhengdong/xbot
- 对照版本：`3b81c8efe55fee2606a9992203abd2e6082e08c4`
- 对照 `internal/web/static/index.html`、`tokens.css` 和 `app.css` 的核心交互：Bot 名册、单聊/群聊、聊天主卡片、浅灰背景、低饱和表面、单色主操作、资料抽屉。
- 按用户要求直接复用 `internal/web/static/` 的原始 HTML、CSS、JavaScript、字体、图标、头像库和相关资源；不再运行上一版 React 重写的界面。
- 所有上游 CSS、字体和原头像生成器保持原始字节。新增猫咖配色覆盖层和原创猫猫头像入口；浏览器脚本的适配与逐文件哈希见 [前端接入说明](xbot-frontend.md)。
- 登录、账户、跨设备等页面保留原始结构，本地入口不要求登录，尚未接入的扩展服务明确返回不可用。
- 原头像库、KaTeX 和字体自带的第三方许可和署名文件完整保留。

## 头像

当前使用本项目生成并经用户选定的 G 组 3D 玩偶猫猫肖像。`cat-avatars.js` 从运行时图集 `avatars/clay-cats.png` 显示八个品种，保留用户上传图片。N 手绘墨稿与 I 水彩绘本保留为主题候选，历史设计位于 `avatar-lab/`。

XBot 原版 `vendor/xbot-avatar.min.js`（DiceBear Notionists）及 `client/public/vendor/LICENSES.txt` 保留，页面不再加载其人像生成器。
