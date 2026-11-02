# 本地 Agent 接入前端规范

适用于设置「本地 Agent」、Bot 详情/编辑资料中的「执行 Agent」、更换执行 Agent 弹层和新建 Bot 的 Agent 选择。实现位于 `client/public/agents.js`、`agents.css`。

## 规范依据

本仓库内找到的依据如下。没有找到独立成文的上游设计规范文档；固定的 XBot 提交只以复制进来的资源形式存在，参考仓库不在本工作区，因此未查阅这些资源之外的上游材料。

| 依据 | 位置 | 采用的约束 |
| --- | --- | --- |
| 「XBot 视觉规范 v1 · 方向 A『白纸』+ 深色（B 式明度分层）」 | `client/public/tokens.css` 头注释与逐项注释 | 组件只引用 `--x-*` 变量；表面靠明度分层；含义色只给错误、在线点等限定用途；阴影只给浮层；字号、间距、圆角取 token。 |
| 猫咖配色层 | `client/public/cafe-theme.css` | 只覆盖颜色，布局与交互归原样式所有；新样式不写死颜色，浅色/深色随 token 切换。 |
| 设置页外壳 | `app.css` 中 `setpane`、`setsec`、`setlead`、`setrows/setrow`、`setfoot`、`sdot`；手机端隐藏页内标题的规则 | 面板沿用同一外壳与标题层级，窄屏标题由顶栏承担。 |
| 「approved neutral selection」单选行 | `web-search.css`、`image-gen.css` 注释 | 新建 Bot 的 Agent 选择复用 `ws-list/ws-provider/ws-radio/ws-meta`。 |
| 「quiet provider cards, details revealed on the next level」及更换模型弹层 | `providers.css`、原 `providers.js` | 更换 Agent 复用 `binding-dialog` 一族：点行只暂存，按钮确认才提交；入口沿用 `binding-trigger`。 |
| 前端适配原则 | `docs/xbot-frontend.md` | 原 CSS、字体字节不变；增量文件登记 manifest；classic script，不改为 ES modules。 |

## 视觉与组件

- 新样式只在 `agents.css`，排在 `cafe-theme.css` 之后；只使用现有 token，不引入新颜色、字体或动画。
- 状态点沿用 `sdot`：`ok` 表示已有登录/配置记录（沿用原供应商卡片「已配置」的用法），`off` 表示需要登录或未检测到，`idle` 表示未确认。不使用 `--x-danger` 表示可恢复的未登录状态。
- 行分隔沿用技能列表与绑定弹层的 `1px var(--x-fill-2)` 细线；其余层次靠底色明度。
- Agent 名称用界面字体；命令名、登录命令用等宽字体与 `fill-2` 底，与 `setfoot code` 一致。

## 文案约束

- `configured` 只写作「已有登录或配置记录」，不写「已连接」「运行中」「可用」。页脚说明它不代表已启动，也不保证额度和网络。
- 活动只叫「Bot 会话」，只统计 clowder-bot 管理的会话；`unknown` 写「状态未知」，不得显示为「空闲」。
- `unknown` 但已安装且已支持的 Agent 可以选，并提示「如果没登录，执行会失败」。`login_required`、未安装、未适配的 Agent 不可选，显示原因；有 `loginCommand` 时显示命令。
- 更换前说明影响：改由某 Agent 执行，清除 Bot 单独设置的账号、模型和推理强度，沿用 Agent 本机默认配置，聊天记录保留。
- 原生托管账号（`managed_account`）等旧绑定显示原名和「只读保留」，不显示为本地 Agent 已接入。

## 交互约束

- 只读：打开面板不安装、不登录、不调用模型；`?refresh=1` 只在用户点「重新检测」时发送。
- 只有用户确认才发送 `PUT /xbot-api/bots/:name/agent`，请求体只含 `runtimeId`；保持当前 Agent 且无覆盖时确认按钮不可用。
- 保存失败时弹层保持打开。中文服务端消息原样显示（任务在途、成员已在其他页面修改等都可能是 409）；无中文说明的 409 只提示配置有变化、请重新打开核对，不推断为任务在途。本地任务状态只作提示，以服务端判断为准。
- 保存进行中不能改选；回调收到的是发起保存时的选择。
- 新建 Bot 默认选中有登录/配置记录的 Agent；没有可选 Agent 时不能提交，可在表单内重新检测。
- 图片生成、网页搜索只显示「由本地 Agent 管理」的只读说明、服务端说明及加载/错误态，以及前往本地 Agent 设置的入口；没有供应商、密钥或开关。
