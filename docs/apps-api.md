# 应用：第一版接口

日期：2026-11-26。第一版只有两项：**微信**（这台 Mac 上的微信，只读）和**自定义应用**（自己接一个 MCP 服务）。

应用是什么，是和使用者一起对照 Dots、Grok Bot、OpenBot 定下来的：一个认得出名字的东西，连上之后猫会用它；背后可以是一个连接、一个上游插件或引擎自带的能力，不等于 MCP。这一版的两项各用一种上游机制，Bot 只做输入校验、状态翻译和展示：

| 应用 | 上游机制（固定版本，未打补丁） | Bot 自己保存的 |
| --- | --- | --- |
| 微信 | 官方插件 `official.wechat-visible-reader`：插件管理的读取与启停，插件自己声明的「短时授权」操作 | 无 |
| 自定义应用 | 能力登记表里的外部 MCP：安装、探活、改密钥、删除 | 使用者起的名字（`presentation.json` 的 `apps`，按原生 id） |

装没装、开没开、连没连上、授没授权，每次都从引擎读回来。密钥只进引擎，不进 Bot 的存储，也不出现在任何回应里（只列名称）。

## Bot API

- `GET /xbot-api/apps` → `{ apps: App[] }`。第一项总是微信，其后是登记表里的外部 MCP。不探活。
- `GET /xbot-api/apps/:id` → `App`。自定义应用在这里探活一次（引擎启动或连接它、列出工具）。
- `POST /xbot-api/apps/custom` → 201 `App`（已探活）。
- `PATCH /xbot-api/apps/:id`（自定义）body `{ name?, secrets? }` → `App`（已探活）。
- `DELETE /xbot-api/apps/:id`（自定义）→ `{ removed: true }`。微信回 405 `app_builtin`。
- `POST /xbot-api/apps/wechat/connect`、`/disconnect`、`/authorize`、`/revoke` → `App`（微信）。请求体为空对象。

`:id` 是 `wechat` 或 `custom:<原生 id>`（放进路径时要转义冒号）。

### App

```text
id, kind: "wechat" | "custom", title
state: "off" | "starting" | "on" | "failed" | "unavailable" | "unchecked"
reason?        不可用的原因，一句人话。failed、unavailable 一定有；上次启动失败后的 off、被引擎停用的 off 也有
detail?        引擎自己的原话，供排查，不需要它也能操作
source?        自定义：{type:"program", program, args[], secrets[]} 或 {type:"url", url, secrets[]}；secrets 只是名称
tools?         自定义、探活成功后：[{name, description?}]
authorization? 微信、state 为 on 时：{active, remaining_ms, until?}
disclosure?    微信：插件自己的隐私说明，原文
version?       微信：插件版本
```

各状态的含义与来源：

| state | 微信 | 自定义 |
| --- | --- | --- |
| `off` | 插件已安装、未启用 | 引擎里这一行被停用（`reason: 已停用`；这一版不提供开关） |
| `starting` | 已启用，运行时还在启动 | — |
| `on` | 运行中 | 探活成功，`tools` 是它提供的工具 |
| `failed` | 已启用但没有运行 | 探活失败；`reason` 是翻译过的原因，`detail` 是引擎的错误原文 |
| `unavailable` | 不是 Mac、引擎里没有它的程序包、程序包没通过校验、或引擎不允许启用 | — |
| `unchecked` | — | 列表里的每一行（列表不探活）；或探活没有结论（`reason: 没能检查`） |

### 微信

- 打开（`connect`）＝启用插件。回应是启用之后读回来的状态：可能已经是 `on`，也可能是 `starting`。第一次启用要装依赖、可能超过一次请求的时间；这时引擎仍在继续，接口照实回 `starting`，由界面再读 `GET /xbot-api/apps/wechat` 直到离开 `starting`。启动失败时读回来的是 `off` 加 `reason: 上次没能启动`（引擎自己把意图退回了停用）。
- 关闭（`disconnect`）＝停用插件。授权随之失效（插件在启动和停止时都会清掉授权）。
- 授权（`authorize`）＝执行插件自己声明的动作 `arm`：允许读取 10 分钟，到点自动结束。只在 `on` 时可用，否则 409 `app_not_on`。时长是插件清单里写定的，这一版不让改。
- 撤销（`revoke`）＝动作 `disarm`。
- 不可用时 `connect`／`disconnect` 回 409 `app_unavailable`，`error` 是原因。
- `authorization.remaining_ms` 是读取那一刻的剩余时间；`until` 是到期的 ISO 时间。界面按 `until` 自己倒数，到点后再读一次。
- 授权不等于猫可以随意读：按联系人读取时插件还要求使用者在当前对话里明确同意（会把微信切到前台、可能把那个会话标为已读）。这是插件自己的规则，Bot 不改。

`disclosure` 的原文（插件 0.1.0-alpha.7）：

> 不会保存截图。识别出的微信文字会进入当前猫的模型上下文和 Clowder AI invocation trace。按联系人读取由你在当前 thread 逐次授权；执行时会短暂切到微信，可能清除目标会话未读，并在结束后尽力恢复原会话、滚动位置与前台 app。

界面可以用自己的话说这几件事，但不能少说：不存截图；认出的文字会交给那只猫用的模型，并留在运行记录里；按联系人读取会短暂把微信切到前台、可能把会话标为已读，结束后尽量恢复。

使用前提（插件 README）：只支持 macOS；本机要装了微信，以及编译原生读取器的工具（`xcrun swiftc`）；第一次读取时系统会要「屏幕录制」和「辅助功能」权限。读取范围是当前选中会话的可见部分，或某个名字完全匹配的联系人最近 1–30 条；不发消息、不点链接、不读数据库。

### 自定义应用

`POST /xbot-api/apps/custom` 的 body 二选一，都可带 `idempotencyKey`（UUID；同一份表单重试时复用）：

```json
{"name":"我的笔记","program":"npx","args":["-y","notes-mcp@1.2.3"],"secrets":{"NOTES_TOKEN":"…"}}
{"name":"Linear","url":"https://mcp.linear.app/mcp","secrets":{"Authorization":"Bearer …"}}
```

- `name` 1–40 字。`program` 1–512 字，`args` 至多 32 个、每个至多 2048 字，都不能含换行。
- `url` 必须是 `https://`；`http://` 只允许本机地址；不能带用户名密码。
- `secrets`：程序的是环境变量（名称为字母、数字、下划线，不以数字开头），网址的是请求头。至多 32 项，值 1–8192 字、不含换行。
- 程序与网址同时给或都不给：400「请填要运行的程序，或者一个网址（二选一）」。

添加之后的回应就是探活结果。**加上了但没连上也是 201**：应用已经在引擎里，`state` 是 `failed`，带原因；界面应当让使用者改密钥、再试或移除，而不是当作没加上。引擎的探活只等几秒（本机程序 2.5–7 秒，网址 8 秒），第一次要下载的 `npx` 包可能因此显示「几秒内没有回应」，稍后再读一次即可。

原生 id 由 Bot 生成：名字里有拉丁字母时用它（`My Notes` → `my-notes`，重名加 `-2`），否则是 `app-` 加 8 位十六进制。猫看到的工具名形如 `mcp__<id>__<工具>`。

`PATCH` 的 `secrets` 是合并：给出的名称被替换或新增，其余保留；不能删除单个密钥（上游没有这个操作），要删就移除应用重加。`name` 只改 Bot 保存的名字。

移除是硬删除（上游的 `?hard=true`），不可恢复。引擎自带的 MCP 服务（`cat-cafe-*`）和插件带来的不在这个列表里，这些接口也碰不到它们（404）。

**范围与确认**（界面必须让使用者在添加前知道）：

- 加上之后**所有猫**都能用，新建的猫也自动有。上游是全局登记加按猫屏蔽，这一版不做按猫开关。
- 猫用它**不会逐次询问**。上游让本机 Agent 以全权限运行，没有按工具调用的审批；唯一的确认点是「添加」。
- 本机程序型的应用会**在这台电脑上、以使用者的身份运行那个程序**。
- 密钥明文存在引擎的数据目录里（`workspace/.cat-cafe/capabilities.json`，引擎回应里打码）。
- 对正在进行的对话，下一条消息起生效，不用重启。

## 上游的实际行为（2026-11-26 在隔离运行时上读到的）

适配层的校验和几处处理是照这些写的；升级固定提交时要重新核对。测试用的假引擎 `tests/apps-fixture.ts` 按同样的行为回答。

- `GET /api/capabilities`：`items[]` 里 `type: mcp, source: external` 的行就是自定义应用；`mcpServer` 带 `command`、`args`、`url`，`env`／`headers` 的值是 `••••••`，另有 `envKeys`。在 Bot 的部署标识下这个读取不写任何东西。
- `POST /api/capabilities/mcp/install`：**不校验 id，不拒绝空命令，id 已存在时静默合并覆盖**。所以 id、必填项和重名都在适配层处理。本机程序安装时会探活并带回结果；网址型的 `probe` 是 `null`，适配层另问一次 `POST /api/mcp/:id/tools`。只带 `{id, headers}` 再装一次会合并请求头、保留其余配置。
- `PATCH /api/capabilities/mcp/:id/env`：合并环境变量。
- `POST /api/mcp/:id/tools`：`{connectionStatus: connected | disconnected | unknown, tools[], error?, latencyMs}`。
- `DELETE /api/capabilities/mcp/:id?hard=true` → `{ok, mode: "removed"}`；不存在时 404。
- `GET /api/plugin-manager/plugins/_local/:pluginId` → `{plugin}`：`artifact`、`intent`、`live`、`lifecycleRevision`、`actions.setEnabled`、`diagnostic`、`activationFailed`、`configFields`（其中 `kind: operation` 的 `description` 就是隐私说明）。
- `POST /api/plugin-manager/plugins/:pluginId/set-enabled` body `{enabled, expectedRevision}`；版本不对回 409 `STALE_REVISION`（适配层重读一次再试）。
- `POST /api/plugins/:pluginId/actions/:operation/:action` → `{ok, render: "status", data: {armed, remainingMs, expiresAt?}}`；插件没在运行时 409。
- **上游缺陷**：这个操作只要执行过一次动作，引擎就会把自己的步骤指针（`operationState`）一起交给插件，而这一版插件拒绝不认识的输入字段，于是之后的每个动作都失败（502「input contains an unsupported field」），重启也不恢复。`POST /api/plugins/:pluginId/operations/:operation/reset` 只清这个指针，不动插件自己的授权（实测：授权后重置再读状态，仍是已授权）。适配层在每个动作前先重置。Bot 不使用这个指针，显示的内容都来自动作的回应。已登记为上游需求。
- 上游没有插件状态的事件，界面靠再读一次。

## 已知限制

- 猫被插件拒绝时说的话来自插件自己的文案，里面叫「Plugin Hub」（上游界面的名字）；在这里对应的是侧栏「应用」里的微信。
- 微信的程序包不在引擎里时（`unavailable`），这一版不提供从目录安装。
- 远程服务只能用固定的请求头登录；需要浏览器登录（OAuth）的服务接不了，上游没有这个流程。
- 网址型的应用只对 Claude Code、Codex、Kimi 等几种 Agent 生效（上游的限制）。
- 没有按猫开关，没有暂停，只能移除。
- 官方插件要先能装上依赖：Node 自带的证书验不过 npm 官方源的机器上，需要在全局 npm 配置里指定证书文件（见[维护说明](upstream-maintenance.md)「插件依赖与证书」）。

## 验证

- `tests/apps-api.test.ts`（16 项）：列表与过滤、两种添加、失败也算添加、适配层的校验、id 规则、探活原因的翻译、改名与改密钥走哪条上游路由、移除、微信的每种状态、非 Mac、启停与版本重试、超时与失败的启动、授权的全过程（含每个动作前的重置）。
- 隔离运行时实测（2026-11-26，固定提交加既有补丁）：经适配层添加本机程序型应用后，Claude 猫与 Codex 猫下一条消息即可调用其工具并拿到密钥；添加找不到的程序、连不上的网址，各自如实回 `failed`；微信的打开、授权 10 分钟、读状态、撤销、关闭均与引擎读回的一致。`tests/fixtures/probe-mcp.mjs` 是实测用的无依赖 MCP 服务（一个不读不写的工具）。
- 没有验证的：真正读一次微信消息（要使用者本人授权，并给运行引擎的进程「屏幕录制」「辅助功能」权限）。
