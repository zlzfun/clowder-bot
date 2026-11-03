# 本地 Agent 接入前端规范

适用于设置「本地 Agent」、Bot 详情/编辑资料中的「执行 Agent」、更换执行 Agent 弹层，以及猫猫信息抽屉里的「配置」。实现位于 `client/public/agents.js`、`agents.css`，抽屉「配置」在 `app.js` 的 `catConfigSection`。新建猫猫选 Agent 已由模板模块 `cat-templates.js`（规则在 `cat-template-rules.js`）负责，不在本文范围。

## 规范依据

本仓库内找到的依据如下。没有找到独立成文的上游设计规范文档；固定的 XBot 提交只以复制进来的资源形式存在，参考仓库不在本工作区，因此未查阅这些资源之外的上游材料。

| 依据 | 位置 | 采用的约束 |
| --- | --- | --- |
| 「XBot 视觉规范 v1 · 方向 A『白纸』+ 深色（B 式明度分层）」 | `client/public/tokens.css` 头注释与逐项注释 | 组件只引用 `--x-*` 变量；表面靠明度分层；含义色只给错误、在线点等限定用途；阴影只给浮层；字号、间距、圆角取 token。 |
| 猫咖配色层 | `client/public/cafe-theme.css` | 只覆盖颜色，布局与交互归原样式所有；新样式不写死颜色，浅色/深色随 token 切换。 |
| 设置页外壳 | `app.css` 中 `setpane`、`setsec`、`setlead`、`setrows/setrow`、`setfoot`、`sdot`；手机端隐藏页内标题的规则 | 面板沿用同一外壳与标题层级，窄屏标题由顶栏承担。 |
| 技能列表「名字、一行、箭头」与二级详情 | `skills.css`（「List: name, one line, chevron. Nothing else.」）、`skills.js`；`persona-cards.js` 以 `skills-settings` 宿主类复用同一外壳 | 设置「本地 Agent」同样以 `skills-settings agent-settings` 为宿主类，复用 `sethd`、`sktoolbar/sksearch`、`sklist/skrow/skchev`、`sknone/clearsrch`、`setback/skdetail-name` 和 `onLevel` 二级导航；手机端隐藏页内标题与返回链接的规则随之生效。 |
| 来源图标 | `skills.css` 的 `.bico`（`oa`、`cl`、`ag`）与 `provider-icons/` | 行首 Agent 标记沿用 `.bico` 遮罩图标；只新增 Kimi 一个 `--bico` 指向已有 `provider-icons/kimi.svg`。 |
| 「quiet provider cards, details revealed on the next level」及更换模型弹层 | `providers.css`、原 `providers.js` | 更换 Agent 复用 `binding-dialog` 一族：点行只暂存，按钮确认才提交；入口沿用 `binding-trigger`。 |
| 前端适配原则 | `docs/xbot-frontend.md` | 原 CSS、字体字节不变；增量文件登记 manifest；classic script，不改为 ES modules。 |

## 视觉与组件

- 新样式只在 `agents.css`，排在 `cafe-theme.css` 之后；只使用现有 token，不引入新颜色、字体或动画。
- 设置「本地 Agent」分两层（2026-11-03 按用户反馈改为简洁列表）：
  - 列表：页标题、工具栏（检测状态短句、「搜索 Agent」、「重新检测」），按「已安装」「未安装」分组；每行为图标、Agent 名称、一行状态和右箭头，没有页首说明和页脚说明。
  - 详情：返回链接、图标 + 名称与「重新检测」，「状态」（本机、登录、接入/选用、Bot 会话）、「接入的 Bot」、「本机默认」（模型、推理强度）用 `setrows/setrow` 键值行；命令路径、接入方式、登录命令、检测时间、Agent ID 和运行面板入口放在默认收起的「检测详情」里。
- 图标只在运行时 ID 与 `clientId` 吻合时用品牌标（`codex`/`openai`、`claude`/`anthropic`、`kimi`/`kimi`，即服务端适配的组合），其余 Agent 用通用 Agent 图标，不按名称猜品牌。
- 状态点沿用 `sdot`（详情的「登录」行）：`ok` 表示已有登录/配置记录（沿用原供应商卡片「已配置」的用法），`off` 表示需要登录或未检测到，`idle` 表示未确认。不使用 `--x-danger` 表示可恢复的未登录状态。
- 行分隔沿用技能列表与绑定弹层的 `1px var(--x-fill-2)` 细线；其余层次靠底色明度。
- Agent 名称用界面字体；命令名、登录命令用等宽字体与 `fill-2` 底，与 `setfoot code` 一致。
- 不复制参考图的深色配色；浅色/深色均随现有 token 与猫咖覆盖层。旧版逐卡样式（`agent-list/agent-row/agent-facts` 等）仍留在 `agents.css`，供模板评审样页使用；`agent-facts` 同时用于抽屉「配置」的键值行（与 `renderSummary` 的 `agent-facts ct-facts` 一致）。
- 抽屉「配置」排在「执行 Agent」之后，是 `.psec` 小节：模型、推理强度、猫种三行；性格、擅长、提醒有内容时放进默认收起的「画像」（沿用任务卡片 `task-details` 的折叠样式）。

## 文案约束

- 不写引导性长句：设置页不再有页首说明（如「Bot 交给这台电脑上已安装的 Agent 执行…」）和页脚说明；加载、空、错误状态只用短句（「正在读取…」「没有检测到 Agent」「没能读取本地 Agent」「没有匹配的 Agent」）。准确性靠标签本身。
- 分组只用 `installed` 能证实的事实：「已安装」「未安装」。`installed` 为真但 `readiness.status` 为 `not_installed` 时按未安装处理。
- 列表一行：未安装写「未检测到」；已安装但未适配写「暂未适配」；否则为登录证据短语（「已有配置记录」「需要先登录」「未确认登录」），后接「N 个 Bot」，再接 Bot 会话的「N 个执行中」「N 个排队」。空闲不写（未安装的 Agent 也报 0/0）；有 Bot 而活动未知时写「会话状态未知」。
- `configured` 只写作「已有登录或配置记录」（列表短语「已有配置记录」），不写「已连接」「运行中」「可用」。
- 活动只叫「Bot 会话」，只统计 clowder-bot 管理的会话；`unknown` 写「状态未知」，不得显示为「空闲」。详情只在已安装且有 Bot 或正在执行时显示这一行。
- `unknown` 但已安装且已支持的 Agent 可以选：更换弹层的行只标「未确认登录」，设置详情的「选用」行写「可以选用，未登录时执行会失败」。`login_required`、未安装、未适配的 Agent 不可选，显示原因；有 `loginCommand` 时在设置详情显示命令。
- 更换弹层没有常驻说明。只有确认会清除猫猫自己的设置时，才用一句短文说明清除什么：「确认后会清除原有接入、单独指定的模型 X、单独指定的推理强度 Y。」（只列实际存在的项；推理强度取自 `cat_config.effort`，模型取自 `agent.modelOverride`）。本地状态显示有任务在执行或排队时，另接「有任务在执行或排队，完成或停止后才能更换。」。不再写「聊天记录会保留」和登录提醒长句。
- 执行 Agent 入口的副行：有自己的模型或推理强度时写「Bot 单独指定 模型 · 推理强度 X」，否则写「沿用本机默认 · 本机模型」。
- 原生托管账号（`managed_account`）等旧绑定显示原名和「只读保留」，不显示为本地 Agent 已接入。
- 抽屉「配置」只显示 `cat_config` 里复制进猫猫的值，不显示模板名、来源、修订或任何内部 ID，也不加说明；职责和 Agent 已有各自的小节，不再重复。模型、推理强度为跟随时写「默认」。猫种名按原生猫种 ID 查名称（`moonshot` 对应 `turkish-van` 头像的名称），查不到名称的 ID 不显示「猫种」行，例如旧原生猫的合成 ID `bot-…`。不把 ID 当名称显示，不按猫猫当前头像推断猫种，也不改存储的 ID。`cat_config` 为 `null`（如托管账号）时不显示这一节。

## 交互约束

- 只读：打开面板不安装、不登录、不调用模型；`?refresh=1` 只在用户点「重新检测」时发送。搜索只在已读取的列表里按名称和 ID 过滤，不发请求；打开详情也不再读取。
- 二级导航沿用技能页：点行进入详情并通过 `onLevel({title, backLabel: "本地 Agent", back})` 更新设置顶栏，手机顶栏返回与页内返回链接都回到列表，焦点回到刚打开的那一行；进入详情时焦点落在 Agent 名称上。详情里「重新检测」后留在同一 Agent，按新数据重绘；该 Agent 不再出现时回到列表。
- 只有用户确认才发送 `PUT /xbot-api/bots/:name/agent`，请求体只含 `runtimeId`；保持当前 Agent 且没有自己的模型、推理强度时确认按钮不可用。成功后入口按服务端返回的绑定重绘，并按该接口的约定把本地副本的推理强度置为跟随，面板随后重新读取。
- 保存失败时弹层保持打开。中文服务端消息原样显示（任务在途、成员已在其他页面修改等都可能是 409）；无中文说明的 409 只提示配置有变化、请重新打开核对，不推断为任务在途。本地任务状态只作提示，以服务端判断为准。
- 保存进行中不能改选；回调收到的是发起保存时的选择。
- 新建猫猫的 Agent 选择、默认选中和不可用提示由 `cat-templates.js` 负责；`agents.js` 不再提供新建表单字段（原 `field()` 已删除），壳层也不再自己发送创建请求。
- 图片生成、网页搜索只显示「由本地 Agent 管理」的只读说明、服务端说明及加载/错误态，以及前往本地 Agent 设置的入口；没有供应商、密钥或开关。
