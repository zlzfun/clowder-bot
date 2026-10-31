# Provider 接入与来源

参考快照：[`zts212653/clowder-ai@b2c9952f27d31480191ff6fd120789405c97238c`](https://github.com/zts212653/clowder-ai/tree/b2c9952f27d31480191ff6fd120789405c97238c)。`server/providers/cli.ts` 依据以下模块重新裁剪为独立适配器：

- [`ClaudeAgentService.ts`](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts)：print/stream-json 参数、prompt 经 stdin 传入。
- [`claude-ndjson-parser.ts`](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/agents/providers/claude-ndjson-parser.ts)：`system/init` 会话标识、`stream_event` 增量与最终 `assistant` 消息按 ID 去重。
- [`CodexAgentService.ts`](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts) 和 [`codex-event-transform.ts`](https://github.com/zts212653/clowder-ai/blob/b2c9952f27d31480191ff6fd120789405c97238c/packages/api/src/domains/cats/services/agents/providers/codex-event-transform.ts)：`exec --json`、thread ID、agent-message item 边界与完成消息。

上游当前 Gemini 路径已移到 AGY，当前项目的标准 Gemini CLI 接入依据 [Gemini 官方 headless 文档](https://geminicli.com/docs/cli/headless/) 实现。使用 `--approval-mode default`，没有采用可能在 headless 下自动切到 YOLO 的 plan 模式。Codex 命令同时核对 [OpenAI 非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)；HTTP 适配器依据 [Chat Completions 官方参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 实现 OpenAI-compatible SSE。

## 接入边界

本版本每轮从本项目的 persona、可见记忆、摘要和保留原文重新组装上下文，通过 stdin 发送给 CLI。保留原生 session ID 供溯源，但不使用原生 `--resume`，以免重放全量上下文造成重复，也避免旧会话越过已更新的记忆/画像边界。原生 app-server 长驻会话、工具展示、复杂权限交互不在这一版中。

- Claude、Codex 保留本机 CLI 原生权限配置，Gemini 显式使用默认权限模式；不额外禁用编码工具，也不主动放开权限。工作目录由设置指定，启用真实模式后 CLI 可在其既有授权范围内执行工具。需要用户批准的 CLI 操作可能失败或超时，当前 UI 不承接原生工具审批。
- Prompt 不进命令行参数；不执行 shell 拼接、不加 bypass/YOLO 参数。macOS/Linux 将子进程置于独立进程组，取消时先 SIGTERM、1 秒后 SIGKILL；Windows 当前仅终止直接子进程。
- HTTP 接入只从 `settings.apiKeyEnv` 指向的服务端环境变量读密钥，不把值保存在状态。URL 可填服务根路径（例如含 `/v1`）或完整 `/chat/completions` 路径。拒绝 URL 内密钥、查询参数、重定向。未配置或调用失败不会静默回退演示模式。
- 所有适配器有响应时限、输出长度限制、异常结束检测、取消清理。CLI 的协议不兼容、未安装、未登录均明确返回错误。
- 只运行伪 HTTP/伪子进程协议测试；没有真实模型/CLI 端到端验证。

## 上游许可证

MIT License

Copyright (c) 2026 Clowder AI Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
