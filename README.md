# clowder-bot

一个本地运行的猫猫协作聊天应用。把不同角色的 Bot 放进单聊或群聊，用熟悉的聊天界面完成协作。

后端核心对照 [Clowder AI](https://github.com/zts212653/clowder-ai)，前端复用 [XBot](https://github.com/liu-zhengdong/xbot) 的 HTML、CSS、JavaScript 与字体，保留原布局和交互。当前使用原创 3D 猫猫头像与奶油、燕麦、咖啡棕配色，深色模式采用夜间咖啡馆配色。项目独立运行，不代表上游项目。

## 启动

需要 **Node.js 22.13+**（开发验证使用 Node 24）和 npm。

```bash
npm install
npm run dev
```

打开 **http://127.0.0.1:5173**。开发 API 在 `127.0.0.1:3210`，Vite 代理原后端 `/api` 和 XBot 兼容层 `/xbot-api`。

生产构建在同一个服务中提供界面和 API：

```bash
npm run build
npm start
```

打开 **http://127.0.0.1:3210**。首次启动自动创建三只猫猫、一间协作室和对应私聊。默认 **演示模式**，不需要 API key 或任何 agent CLI。演示回复来自本地确定性脚本，用于体验聊天、流式更新和传球；它不进行真实推理，也不执行代码任务。

## 现在可以做什么

第一次体验时，在侧栏选择「宪宪」，输入「你好，介绍一下自己」并按 Enter。测试群聊时选择「猫猫协作室」，发送「请一起设计一个待办应用，并传给砚砚审查」；测试记忆时发送「记住：我喜欢简洁的中文回答」，随后打开 Bot 信息抽屉的「记忆」页。默认演示回复有明确标记，不代表已调用真实 AI。真实聊天按下方步骤配置模型后再试。

- 单聊、群聊、连续聊天记录、Markdown 消息与流式回复。
- 八种猫猫角色模板：布偶猫、缅因猫、暹罗猫、梵花猫、小鲸鱼、狸花猫、孟加拉猫、金渐层。职责和性格取自 Clowder AI 默认画像；当前使用 3D 玩偶猫猫头像，支持选择预设和上传图片。
- 从模板创建 Bot，编辑名字、画像、模型和接入方式；新建群聊、调整群成员、置顶、重命名和删除会话。
- 在群聊中 @ 指定成员；猫猫通过明确的行首 @ 传球。编排层检查成员身份，限制传球次数，并支持中止当前协作。
- 共享记忆、猫猫私有记忆和当前会话记忆；原版记忆面板可查看，后端保留增删接口。猫猫可用明确的记忆标记存储事实。
- 上下文预算和压缩，原始消息保留；长期记忆和历史摘要在后续轮次注入。
- 本地持久化、服务重启恢复、浅色/深色界面、窄屏布局。

## 接入真实模型

初始 Bot 使用本地演示。打开 Bot 的信息抽屉，在「详情 → 模型」中选择对应供应商和模型；该绑定对这一个 Bot 生效，可以在同一群中混合演示与真实 Bot。调用失败会显示错误，不会退回模拟答案。

### OpenAI 兼容 API

```bash
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY=你的密钥
npm run dev
```

1. 在原版「设置 → 模型与供应商」中配置 OpenAI 密钥并同步模型；也可以使用上面的环境变量方式。
2. 在 Bot 的「详情 → 模型」中选择 OpenAI 和该服务实际返回的模型。
3. 发消息验证连接。网页填入的密钥独立保存在数据目录的 `provider-secrets.json`（文件权限 `0600`），不写进聊天数据，也不返回状态接口。修改 `.env` 后需重启服务。

默认 base URL 是 `https://api.openai.com/v1`。原版设置布局没有自定义地址、上下文预算或 CLI 工作目录字段，本轮没有增加新控件；这些参数仍可以通过原后端 `PUT /api/settings` 配置。例如切换兼容服务地址：

```bash
curl -X PUT http://127.0.0.1:3210/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl":"http://127.0.0.1:11434/v1","apiKeyEnv":"OPENAI_API_KEY"}'
```

接口使用标准 `/chat/completions` 文本 SSE。兼容服务需支持流式文本输出；目前未提供通用工具调用循环或图像输入。

### 本地 Agent CLI

Bot 的模型选择器可以选择 Claude Code、Codex CLI 或 Gemini CLI。需要你自行安装相应 CLI 并完成登录；工作目录默认是项目目录，可通过 `PUT /api/settings` 的 `cliWorkingDirectory` 字段修改。后端以参数数组启动进程、解析结构化输出，并处理取消、超时、缺少命令和异常退出。

没有为本项目自动安装或登录这些 CLI，也没有加入跳过权限的参数。本机缺少完整多 CLI 环境，真实 CLI 的端到端执行未验证；已用协议样例和替身进程测试适配逻辑。参数和会话处理细节见 [Provider 对照](docs/provider-reference.md)。

## 数据与架构

```text
client/index.html   XBot 原版页面结构
client/public/      XBot 基础资源、cat-avatars.js、cafe-theme.css 与头像素材
shared/types.ts     前后端和 Provider 契约
server/core/        提及路由、上下文和记忆组装
server/providers/  演示、OpenAI 兼容 API、CLI 适配器
server/xbot/        将 XBot 原版接口映射到本项目后端
server/             HTTP/SSE、编排与原子存储
tests/              核心行为和协议测试
data/state.json     本机运行数据（已被 Git 忽略）
```

数据默认位于项目的 `data/`，可用 `CLOWDER_DATA_DIR` 改变位置。服务只监听本机；这一版面向一个用户、一个服务进程，不应直接暴露到公网。备份数据时停止服务并复制数据目录。原始聊天、摘要和记忆保存在一起，删除会话前请确认不再需要其记录。

上下文预算是混合中文/英文的保守估算，不是模型厂商的计费 token 数。历史压缩是有损操作；原文保留在界面，但不保证每一轮都把全部历史发送给模型。

本版没有接入账号登录、跨设备、语音、插件、猫猫球、外部消息渠道和定时任务。原版 UI 的扩展入口保留，但未接入的写操作会明确报不可用；没有伪造完成结果。完整的参考边界与来源见 [REFERENCES](docs/REFERENCES.md)，接口适配范围见 [XBot API 兼容层](docs/xbot-api.md)。

## 验证

```bash
npm test
npm run verify:frontend
npm run build
npm run smoke
```

测试不需要真实密钥或 CLI。`verify:frontend` 对照固定上游版本的哈希清单，验证所有原版视觉资源，以及已记录的少量接口适配。资源来源与精确差异见 [XBot 前端接入说明](docs/xbot-frontend.md)。

头像候选保留 **N 手绘墨稿、G 3D 玩偶肖像、I 水彩绘本**，当前启用 G。开发服务下访问 `/avatar-lab/` 查看已选方案及历史样页；这不是应用的主题切换设置。
