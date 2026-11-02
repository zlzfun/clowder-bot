# 参考与复用边界

Clowder Bot 是独立项目，不代表上游项目，也没有上游官方背书。

## 执行引擎：Clowder AI

- 仓库：[zts212653/clowder-ai](https://github.com/zts212653/clowder-ai)
- 固定提交：`b2c9952f27d31480191ff6fd120789405c97238c`，以 `upstream.lock.json` 为准。
- **直接复用完整原生代码与执行链路**。Git 子模块原样保留；API、shared、finance、MCP 按上游依赖关系构建，原生 web 不作为 Bot 前端构建。
- 唯一核心差异为外置成员执行准入补丁；具体文件、原因、同步方法见 [维护说明](upstream-maintenance.md)。
- 角色模板读取原生 API，不再抽取为本地静态副本。
- MIT 许可保留于原始仓库与 [副本](licenses/clowder-ai-MIT.txt)。

## 界面：XBot

- 仓库：[liu-zhengdong/xbot](https://github.com/liu-zhengdong/xbot)
- 固定提交：`3b81c8efe55fee2606a9992203abd2e6082e08c4`。
- 复用原始 HTML、CSS、JavaScript、字体、图标、头像库和相关资源，保持聊天产品布局。
- 上游 CSS、字体和原头像库保持原始字节，独立增加猫咖配色和猫猫头像层。
- 脚本协议适配、原生运行面板和逐文件摘要见 [前端说明](xbot-frontend.md) 与 manifest。
- 原头像库、KaTeX 和字体的许可/署名完整保留。

## 头像

使用用户选定的 G 组原创 3D 玩偶猫猫肖像。N 手绘墨稿与 I 水彩绘本保留为候选，历史样页位于 `avatar-lab/`。XBot DiceBear 原库保留作来源记录，页面加载本项目 `cat-avatars.js`。
