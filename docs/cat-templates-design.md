# 猫猫模板与画像：实现说明

日期：2026-11-03。正式前端由本机 Claude Code `claude-opus-5-5 --effort xhigh` 开发，模板 CRUD 与创建接口已接通。此前样页留作历史记录，见 [样页说明](cat-templates-prototype.md)；当前接口以 [API 契约](cat-templates-api.md) 为准。

## 对象与入口

| 对象 | 内容 | 修改影响 |
| --- | --- | --- |
| Agent | 本机执行工具及其原生配置 | 由本机工具和 Clowder AI 管理 |
| 模板 | Agent 引用、模型、可选 effort、猫种和画像 | 保存新修订，供以后创建使用 |
| 猫猫 | 名字、独立配置、原生成员 ID | 不反写模板，不跟随来源模板更新 |
| 画像 | 职责、性格、擅长方向等原生角色字段 | 创建时复制到原生成员 |

设置内的「模板」替代「人设卡」，本地 Agent 仍在设置内。左侧顶端「＋ → 新建猫猫」先选模板，按默认值填写，自定义配置折叠；「从零开始」排在最后，进入后直接展开配置。模板平铺，无猫种分类标题。来源 ID、修订及实现说明不出现在正常表单中。

## 原生所有权和持久化

固定上游提交为 `42017e0cea07e3e259e7fb183be70433f05e131c`。新增原生能力放在 `patches/0005-cat-templates.patch`，由 `upstream.lock.json` 应用到 `.runtime/clowder-ai-templates`；submodule 保持原样。

原生新增 `config/bot-cat-templates.ts` 和 `routes/bot-cat-template-routes.ts`。模板库保存于活动原生工作区 `.cat-cafe/bot-cat-templates.json`，包含用户覆盖、新增模板、删除标记和创建预约。写入使用原生 `withRuntimeCatMutationLock` 跨进程文件锁和临时文件原子替换。已有文件损坏时返回错误，不重建或覆盖数据。用户的覆盖与删除在刷新、重启后仍生效。

模板种子来自随原生发布的 `cat-template.json`，并合并项目模板源。旧工作区的空 `breeds` 不抹除创建菜单。按角色身份去重，每种猫仅采用一个默认 variant；当前 8 份默认模板包含只有画像、尚无 runtime 默认值的小鲸鱼。其他上游 variant 保留不变。种子 ID 为 `seed:<breed>`；自定义 ID 为 `custom:<uuid>`。未覆盖种子的修订由内容散列产生，用户修改后递增，更新和删除均要求 `expectedRevision`。

Bot 的 `ProductStore` 只保存头像等展示元数据与来源模板的 ID、修订、名称，不建立第二份执行配置、模型目录、凭据库或模板库。已有 Redis、SQLite、账号、会话与成员不迁移、不删除。旧头像 ID 和来源模板 ID 分离；`moonshot → turkish-van` 仅用于头像显示。

## 模型、effort 与猫种

模型和 effort 各自保存 `{mode:'inherit'}` 或 `{mode:'explicit',value}`。继承表示继续跟随 Agent 的默认配置，而非把探测值固化。模板后续变化不会改变猫猫，但继承的本机 Agent 默认值可能影响后续执行。

模型选项来自原生 `runtime-models`，不另建 provider 目录。模型级 `efforts` 优先，其次使用匹配查询模型的 `effortOptions`；缺失表示未知，空数组表示明确不支持。未知值保留，明确不兼容时要求修正；不擅自把 `max` 降为 `high`。切换 Agent 时重置模型和 effort 覆盖，画像与手动猫种保留。

自动猫种按模型系列推断，与 Agent 或模型版本无关：Claude/Opus/Sonnet/Haiku 为布偶猫，GPT/Codex 为缅因猫，Gemini 为暹罗猫，GLM 为狸花猫，Kimi 为梵花猫，DeepSeek 为小鲸鱼。无法识别且没有手动猫种时，创建返回 422。孟加拉猫、金渐层及仅画像种子保留上游显式身份。创建后保存解析出的猫种，不随后续模型默认值自动变换。

模板可保存尚未就绪的配置。真正创建时重新发现 runtime、检查安装/登录状态、适配能力及已知 effort 选项。目前 Bot 的本地绑定适配支持 Claude Code、Codex、Kimi；其他种子可以展示和编辑，创建时需选择已支持的本地 Agent，不能静默替换。安装、配置、活动是不同事实；只有原生 invocation 表示正在执行。

## 接口与创建一致性

产品层 `/xbot-api/cat-templates` 的列表、读取、新增、修改和删除转发给原生 `/api/bot-cat-templates`。`/xbot-api/agents/:id/models` 仅按发现的 runtime ID 查询能力，不接受任意启动命令或凭据。

创建使用 `POST /xbot-api/bots` 的新形态 `{name,catConfig,sourceTemplate?,idempotencyKey}`；与旧 `templateId`、`runtimeId` 等创建字段互斥。配置是模板的一次性副本，微调后的完整值直接提交；从零创建不带 `sourceTemplate`。

原生实例化路由复用已有模型能力与成员创建接口，不启动 Agent、不发送消息。首次请求校验来源修订，在原生文件锁内冻结创建预约，使用 UUID 派生稳定成员 ID，并复用原生 `memberCreationReceipt`。相同请求重试返回同一成员；相同键配不同配置返回 409。预约后来源模板修改或删除不阻断原请求重试。原生成功而展示元数据保存失败时，可重试补齐，无需删除成员或创建第二只猫。

旧工作区缺少猫种时，只有携带原生创建回执、采用 `native_tool` 且身份存在于原生角色模板的请求可以初始化该猫种。只加入请求创建的那一个成员，不批量导入种子变体。任意未知猫种仍被拒绝。

猫猫详情的 `cat_config` 始终从原生成员配置投影，`source_template` 仅用于来源追踪。模板保存、删除不会重新应用到已有成员。旧人设卡后台兼容接口保留；正式前端去掉实时绑定语义，保留直接编辑职责和资料导入导出。

## 验证

- `npm run test:cat-templates-native`：8 份种子、空工作区、覆盖与删除持久化、文件锁下并发修订、创建预约与重试、损坏状态保护及模型族映射。
- `tests/cat-templates-api.test.ts`：产品路由、版本转发、能力查询、创建 DTO 和独立配置/来源展示。
- `npm run test:cat-templates-http`：真实原生接口完成自定义模板增删改、版本冲突、创建成员、重复请求回执、模板变更后成员配置不变、来源删除后仍可重试。测试仅创建带唯一验收名称的临时对象并清理自己的对象，不执行任务。
- 前端组件验证、生产构建与 manifest 校验由本机 Claude 开发流程和主 Agent 集成复核完成；原始来源 hash 与署名继续保留。

创建流程验证不会证明某个模型可以成功执行任务；实际调用仍由已绑定 Agent 及原生能力决定，本轮未发起模型执行。

2026-11-03 集成验收：正式页面 `http://127.0.0.1:5173/` 通过设置内的 Agent 列表/搜索/二级详情、模板新增/修改，以及原左上角入口选择布偶猫模板、改为 Opus 5.5 / xhigh、创建并进入真实猫猫聊天的流程。后端核对保存值为原生目录返回的模型别名 `opus`、effort `xhigh`，来源为 `seed:ragdoll`。验收创建的临时模板和猫猫已仅按其唯一标识清理；原有对象保留。

390×844 窄屏下检查了设置返回层级、模板编辑和从零创建，表单使用单列、内部滚动。历史猫猫的未知猫种 ID 不再作为名称展示。回归测试共 106 项，104 通过、2 项按原生环境开关跳过；独立原生模板测试 6 项通过。正式界面截图见 `output/playwright/production-agents.jpg` 和 `production-create-cat.jpg`。
