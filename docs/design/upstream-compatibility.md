# 上游整合与 Sinos 兼容策略

status: accepted

当前已整合来源：Coffee-CLI `23b290bf5e01849bea2d6a99657491da88aacafd`。合并提交 `b7655a10` 保留上游 ancestry；日期、提交范围、回归和历次决定见[集成历史](../histories/upstream-integration.md)。

## 持续保持的行为

- 对外产品名 Sinos CLI / Sinos Agent，反馈与桌面更新使用 `Hopesy/Sinos`；版权、许可、上游与第三方来源保留。
- 品牌图片统一来自 `icons/branding/`。桌面 ICO/ICNS/PNG 由 `scripts/generate-sinos-icons.py` 生成，文件主题由 `scripts/generate-icon-themes.mjs` 复用品牌 SVG 生成；已保存的 `coffee` 主题 ID 由 `src-ui/src/lib/file-icons.ts` 映射到 `sinos` 图片目录。旧 Store/iOS/Android 图片目录、旧生成器及 Coffee 演示媒体已清理；新增平台从现行品牌源生成资源。网站预览使用当前 Sinos 界面截图。
- 密钥、消息 token 和保存的 SSH 密码使用 OS keyring；模型配置对前端暴露 `hasApiKey`。可选空密钥用于支持它的本地服务。
- 桌面更新仅使用 GitHub Releases；发布产物绑定平台/tag/名称，并核验非空大小与 SHA-256。保留 Linux AppImage 回退和安装脚本双位置一致性。
- 保留 Cloudflare 移动中继、配对/输入授权、同一 PTY 身份和回放、编辑/图片标签、启动显窗、托盘及通知。历史 coffee 配置目录、数据库键、协议标识和 hook 兼容语义稳定。
- 默认 Terminal 与已存储启动偏好保持；OpenCode/Pi 原生会话沿用启动代际、关闭取消、迟到清理和 Windows 进程组保护。
- Antigravity 同时兼容 SQLite 索引和旧 JSONL，避免历史与热力图重复；自动恢复全部标签保持关闭。
- Worktree 用实际分支、租约与清理票据协调重开/关闭，保护忽略文件；前端会话输入、录音、Pi 问答等修复由统一回归覆盖。

## 已排除方案

- 明文模型/消息/SSH 凭据迁移：保留系统凭据库方案。
- GitCode/CNB 发布镜像和静态 `version.json`：保留 GitHub 草稿核验后公开的分发链路。
- 用新的默认行为覆盖 Sinos 的移动会话和启动模式：保留上述兼容契约。

本机 Rust 构建政策已由 2026-11-13 的用户决定更新为[远程原生验证](release.md)。其他旧决定以本专题和相关 design 的现行规则为准，历史记录保留原始条件及结果。
