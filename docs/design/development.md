# 开发与兼容规则

## 剪贴板 I/O：只走 `src-ui/src/lib/clipboard.ts`

WebView2 对 `navigator.clipboard.*` 和 `document.execCommand('copy'|'paste')` 会弹原生权限框（"tauri.localhost 想要查看剪贴板…"），每次右键粘贴都弹一次，UX 极差。同一个坑已经在 Explorer、TierTerminal、Gambit 修过 3 次，第 4 次不能再发生。

**硬规则**：
- 需要读/写剪贴板一律 `import { clipboardRead, clipboardWrite } from '@/lib/clipboard'`（内部走 Tauri `plugin-clipboard-manager`，不弹框）
- **禁止**在 `src-ui/src/` 下直接出现 `navigator.clipboard`、`document.execCommand('copy')`、`document.execCommand('paste')`、或 `from '@tauri-apps/plugin-clipboard-manager'`
- 唯一例外：`lib/clipboard.ts` 自己的实现
- Review / 自检时用 `grep -rn "navigator.clipboard\|plugin-clipboard-manager" src-ui/src` 确认只命中 `lib/clipboard.ts`

---

## Tauri 前端要点

- **用 `import()` 不用 `require()`**：Tauri API 如 `convertFileSrc`、`readTextFile` 等必须 dynamic import，否则 TS build 会报错
- **本地资源加载走 `assetProtocol`**：在 `tauri.conf.json` 配 `app.security.assetProtocol.enable: true` + `scope` 列允许的路径；**不要**盲加 `fs:allow-read-file` 权限（需要 `tauri-plugin-fs` 插件才行，而这个项目没装）
- **xterm 插件先查 peer 依赖**：`@xterm/*` 生态包（addon-canvas、addon-webgl、addon-fit 等）的 peer dep 经常和当前 xterm 主版本不对齐；盲 `npm install` 导致 CI 失败过一次。安装前：
  ```bash
  npm view @xterm/<addon> peerDependencies
  ```
  确认和现有 `@xterm/xterm` 版本兼容再装

---

## 项目基础设施参考

- **分支策略**：只用 `main`，master 已删。install 脚本硬编码 `raw.githubusercontent.com/.../main/...`
- **安装脚本双位置**：`install/` 和 `Web-Home/` 各一份，改动必须同步两处（CF Worker 路由根据路径分发）
- **桌面分发**：版本与安装包直接使用 `Hopesy/Sinos` 的 GitHub Releases；`Web-Home/_worker.js` 保留的历史路由独立于当前桌面更新流程。移动连接继续使用 Cloudflare 中继。
- **PTY 锁死根因 #1 已修**（v0.6.1）：child watcher 线程；若复现视为根因 #2（emit/channel backpressure），看 `src/terminal.rs` reader 线程
- **Hook forwarder 纪律**（v3.2.5+）：`__hook` 全路径 exit 0；`argv[1]` 以 `__` 开头但不认识的子命令也 exit 0（不起 GUI），防止"新配置 + 旧 exe"时 hook 报 exit 1。Claude hook 条目按 Git Bash 是否可探测写两种形态（`claude_hook_entry`）：有 Git Bash → `"shell": "bash"` + 引号命令；没有 → `"shell": "powershell"` + `& "..." __hook`——Windows 上 Claude 检测不到 Git Bash 会 fallback PowerShell，而 PowerShell 把引号开头的命令串当表达式直接 ParserError exit 1。排查 hook 问题用 `COFFEE_HOOK_DEBUG=1`，日志在 `~/.coffee-cli/hooks/hook-debug.log`
