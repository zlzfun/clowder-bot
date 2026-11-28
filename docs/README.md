# 文档地图

三层。先看第一层；要动手改某一块时看第二层对应的那份；想知道当时为什么这么做，再去第三层。

## 第一层：现在是什么样

| 文档 | 回答什么 |
| --- | --- |
| [README](../README.md) | 这是什么，用起来什么样，怎么启动 |
| [特性与上游的关系](features.md) | 有哪些特性；每一项现在靠什么实现、上游走到哪一步、什么时候该换做法；六个补丁各自撑着什么 |
| [计划与待办](backlog.md) | 等使用者决定的、Bot 层可以做的、等上游的、还没验证的、文档里要改的 |
| [方向与分轮一览](chat-app-roadmap.md) | 产品方向；二十轮各做了什么，一句话一轮 |
| [协作纪律](../AGENTS.md) | 上游优先、聊天优先、前端归属、运行时归属 |

## 第二层：约定与手册

**改接口或适配层**

| 文档 | 管什么 |
| --- | --- |
| [接口范围](xbot-api.md) | `/xbot-api` 的总约定；开箱即用（建猫、说话方式）；搜索；这台电脑 |
| [聊天体验适配契约](chat-experience-api.md) | 文件、协作状态与已读、回复与表情回应、卡片与选项、等你确认的事、只读记忆 |
| [回复的实时呈现](chat-live-api.md) | `live` 事件、会话行、停止 |
| [应用](apps-api.md) | 微信与自定义应用 |
| [定时](schedules-api.md) | 每只猫的定时：创建、暂停、删除、触发记录 |
| [猫猫模板接口](cat-templates-api.md)、[实现说明](cat-templates-design.md) | 设置里的模板库与按模板的完整创建（靠补丁 P005） |
| [服务契约](api-contract.md) | 服务入口、本机访问、事件流、发送语义 |
| [聊天文件适配](workspaces.md)、[默认文件与兼容范围](default-files.md) | 聊天文件的范围和没有导入的东西 |

**改界面**

| 文档 | 管什么 |
| --- | --- |
| [前端接入](xbot-frontend.md) | 来源与许可、规则、逐项的改动日志（别处说的「第 N 项」指它的条目） |
| `xbot-frontend-manifest.json` | 前端文件清单与校验值，`npm run verify:frontend` 读它 |
| [界面规范](workspace-ui.md) | 文件、历史对话、状态行与已读、记忆、任务在界面上怎样呈现 |
| [Agent 相关界面](frontend-agent-ui.md) | 设置里的 Agents 与猫的 Agent 选择 |

**动引擎、补丁、数据**

| 文档 | 管什么 |
| --- | --- |
| [上游维护](upstream-maintenance.md) | 固定版本与构建、数据位置、偏好仓库、差异台账（补丁 P001–P006 与适配、部署各项）、更新流程、引擎的包、插件依赖与证书、应用依赖的上游行为、电脑驱动 |
| [底层对照](backend-reference.md) | 调用链、所有权、多 Agent 要素对照；后台委派、任务控制、定时几块补丁的设计说明（基线较旧，见文首） |
| [本地 Agent 接入边界](provider-reference.md) | 只绑定本机已登录的 Agent，不管模型与凭据 |
| [参考与复用边界](REFERENCES.md) | 引擎、界面、头像的来源与许可 |

**验证与部署**

| 文档 | 管什么 |
| --- | --- |
| [验证环境与部署](operations.md) | 预览替身、示例环境、隔离运行时；怎样部署到日常实例 |

## 第三层：历史记录

在 [`history/`](history/) 里。写的是当时的情况，后来变了也不回头改；现状以第一、二层为准。

| 文档 | 内容 |
| --- | --- |
| [各轮记录](history/chat-app-rounds.md) | 二十轮的完整经过、使用者的原话、部署记录、端到端实测记录、检视记录 |
| [上游维护记录](history/upstream-records.md) | 2026-10-31 至 2026-11-26 的引擎升级、验收与清理 |
| [上游更新梳理 2026-11-26](history/upstream-next-20261126.md) | 换到 `next` `fe632f8f` 时上游变了什么 |
| [可探索特性](history/feature-exploration.md) | 2026-11-11 的七项方向清单 |
| [资料与成果、协作、记忆的探索](history/chat-files-collaboration-memory.md) | 2026-11-05 特性 1、3、5 的研究与首批实施 |
| [猫猫模板样页](history/cat-templates-prototype.md) | 2026-11-03 的评审样页说明 |

## 写文档的规矩

- 现状写进第一、二层，同时改掉旧说法；经过写进第三层，带日期，写完不再改。
- 一件事只在一处写全，别处链接过去：与上游的关系在 [features.md](features.md)，待办在 [backlog.md](backlog.md)，补丁的细节在 [上游维护](upstream-maintenance.md) 的差异台账，接口在各自的约定文档。
- 做完一轮：在 [方向与分轮一览](chat-app-roadmap.md) 加一行，把经过写进 [各轮记录](history/chat-app-rounds.md)，更新 [features.md](features.md) 里受影响的行，把没做的记进 [backlog.md](backlog.md)。
- 换固定提交之后：逐行重看 [features.md](features.md) 的「上游」一栏和补丁一节。
- 下面这些文件被代码、测试或前端文件按路径引用，不要改名或移动：`xbot-api.md`、`chat-experience-api.md`、`chat-live-api.md`、`apps-api.md`、`xbot-frontend.md`、`xbot-frontend-manifest.json`、`upstream-maintenance.md`。
