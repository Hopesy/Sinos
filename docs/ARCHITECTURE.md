# Sinos CLI 架构总览

Sinos CLI 是 Tauri 2 桌面工作区：Rust 管理本机 CLI、原生对话、文件与系统能力，React 19 / TypeScript 提供桌面及移动端界面。浏览器手机端和 Capacitor Android 客户端通过 Cloudflare 中继连接运行中的桌面实例。

## 模块与入口

| 路径 | 职责与主要依赖 |
| --- | --- |
| [`src/main.rs`](../src/main.rs)、[`src/server.rs`](../src/server.rs) | CLI / hook 路由、Tauri 初始化、命令注册、应用状态及桌面服务 |
| [`src/terminal.rs`](../src/terminal.rs) | portable-pty 会话、输出回放、输入与子进程生命周期 |
| `src/{claude,codex,dsh,opencode,pi}_session.rs` | 五类原生会话协议；`session_start.rs` 协调启动代际与取消 |
| [`src-ui/src/App.tsx`](../src-ui/src/App.tsx)、[`src-ui/src/tauri.ts`](../src-ui/src/tauri.ts) | React 桌面入口、IPC 包装；store 管理工作区，lib 中的会话 store 管理协议状态 |
| [`src/agent.rs`](../src/agent.rs)、[`src/channels.rs`](../src/channels.rs) | Sinos Agent 和消息渠道；配套 agent_* 模块负责上下文、记忆、工作区与权限 |
| [`src/orchestration.rs`](../src/orchestration.rs)、[`src/worker_worktree.rs`](../src/worker_worktree.rs) | MCP 编排、worker 生命周期、隔离 Git 工作区与租约清理 |
| [`src/remote_runtime.rs`](../src/remote_runtime.rs)、[`src/relay_host.rs`](../src/relay_host.rs) | 桌面远程会话、回放与中继连接；remote_* / pair_crypto 负责输入、图片、配对和共享 |
| [`src-ui/src/remote/main.tsx`](../src-ui/src/remote/main.tsx)、[`relay/src/index.ts`](../relay/src/index.ts) | 手机前端入口、Worker 路由；`relay/src/room.ts` 管理 Durable Object 房间 |
| [`src/update_sources.rs`](../src/update_sources.rs) | GitHub Release 元数据、平台产物选择与完整性校验 |
| [`src/voice_input`](../src/voice_input)、`src/usage_*` | 语音采集/服务适配、用量与余额查询 |
| [`src-ui/android`](../src-ui/android)、[`Web-Home`](../Web-Home) | Android 壳及独立网站/用户文档 |
| [`install`](../install)、[`.github/workflows`](../.github/workflows) | 安装脚本、五语言日志、Review / Release 与部署入口 |
| [`icons/branding`](../icons/branding)、[`scripts/generate-sinos-icons.py`](../scripts/generate-sinos-icons.py) | Sinos 品牌源素材及桌面/网站/手机图标生成；`generate-icon-themes.mjs` 复用同一 SVG 生成文件主题。Android 使用 `src-ui/android` 中的 Sinos 矢量资源；其他 scripts 维护网页语言和模型价格 |
| [`resources`](../resources)、[`licenses`](../licenses)、[`third-party`](../third-party) | 原生运行资源、被嵌入的许可证和第三方来源材料 |

## 关键数据流

1. **桌面终端**：工作区选择工具与目录 → Tauri 命令 → PTY → 输出事件 → xterm。会话关闭与进程退出共同清理子进程资源；Windows 使用 Job Object。
2. **原生对话**：会话组件 → 对应前端 session store → Tauri 原生命令 → 工具进程/本地协议 → 流式事件与权限卡片。隐藏界面保留会话所有者，渲染内容按可见性释放。
3. **手机连接**：扫码配对 → 加密中继 RPC → 桌面已有会话；事件、历史与屏幕回放共享会话身份。输入须通过当前会话、授权及输出序列检查。Claude/Codex 的结构化事件是同一终端的观察通道。
4. **Sinos Agent**：桌面或已配对消息渠道 → 模型与工具循环 → 现有终端/原生会话/工作区接口；模型密钥、渠道 token 与 SSH 密码使用系统凭据库，历史与长期记忆按身份隔离。
5. **更新**：`Hopesy/Sinos` 已公开 Releases → 平台安装包 → 大小与 SHA-256 核验 → 平台下载/打开流程。内置五语言日志使用安装版本对应的模板/远程正文。

## 编排传输选择

编排使用 rmcp 的 HTTP Streamable transport，服务实现见 `src/orchestration.rs`。主应用持有工具会话与 worker 状态，客户端连接同一服务；stdio 子进程协议属于各工具适配器，职责不同。后续传输变更以实际协议回归为依据，避免引用已移除的早期架构草稿。

## 专题与运行约束

- [开发与兼容规则](design/development.md)：剪贴板、Tauri、hook、路径与安装脚本约束。
- [发布与验证](design/release.md)：完整门禁、远程 Rust 构建、草稿和十个安装包核验。
- [Sinos Agent](design/agent.md)：用户操作、渠道与持久化契约。
- [移动中继与实例接管](design/relay.md)：连接归属、断线退避、调试/正式版配对隔离和回归入口。
- [Claude 移动事件](design/claude-mobile.md)、[Codex 移动适配](design/codex-mobile.md)：协议来源、回放、降级和验收条件。
- [上游兼容策略](design/upstream-compatibility.md)：保留的 Sinos 行为及明确排除项。

当前交付状态在[活动计划](exec-plans/README.md)维护；历史数据与测量结果位于 `histories/`。本文件描述实现结构，不替代发布或真实账号验收。
