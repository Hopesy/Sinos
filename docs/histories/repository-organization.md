# 2026-11-13 仓库整理与 harness-run 接入

## 用户目标

用户要求将 Rust 构建和打包交给 GitHub，清理本机工具链与无用产物，整理根目录文档/截图等目录，随后显式要求使用 harness-run 收拢项目资料。已有功能整合与 v4.0.6 发布准备须保留。

## 交付与原因

- 官方卸载 Rust/rustup/Cargo 缓存并清理两处 target，实际磁盘可用空间增加约 20.6 GiB；Visual Studio/Windows SDK 等共享组件及正式安装的 Sinos CLI 保留。
- 清理约 2.05 万文件、1.25 GiB 临时内容；旧代理工作区先做完整备份、gzip/内容/SHA-256 校验后移除，保留约 344 MiB 恢复材料及未提交状态。
- 移除未引用截图及 README 失效图片；品牌源素材归入 `icons/branding/`，贡献指南使用 `.github/CONTRIBUTING.md`。
- 文档统一为架构、现行 design、活动/完成计划及 histories。完整发布与开发硬规则得到承接，六份旧正文切换后清理旧位置；当前发布待办保留在独立活动计划。
- 新增 `run-project-docs-test.mjs` 并接入既有自动发现入口，防止断链、旧入口重现、共享正文被忽略或本机材料误纳入版本控制。
- 用户授权创建本机项目 SessionStart 导航；仅新增 harness-run hook，保持原有权限和用户级配置。

长期规则见[协作约定](../REPO_COLLAB_GUIDE.md)、[发布规则](../design/release.md)、[开发规则](../design/development.md)；完整结果和下一动作见[完成计划](../exec-plans/completed/2026-11-13-repository-organization.md)。

## 验收依据

被测范围为 `b7655a10f79b7236d5f428e1baf3f91097b9a81a` 上的本轮工作区变更，尚未提交；应用业务逻辑保持原样。

- 六份迁移正文逐字对照，只保留明确的链接、当前中继及远程执行政策修正；完整发布/开发规则在根导航切换前核验保留。
- 文档契约先在旧入口仍存在时失败，清理后通过；最后目录/链接计数以 `.Sinos-temp/harness-validation/docs-final.log` 为准。
- `npm run lint --prefix src-ui`、`npm test --prefix src-ui`：382 项 Vitest（64 文件）及 73/73 统一脚本通过，包含文档、ConPTY 资源和五语言日志检查。
- 实际运行图标生成器默认入口，在一次性夹具中核验 PNG 尺寸、ICO/ICNS 可读性、前端素材字节及圆角图像像素；未改写正式图标。
- hook 注册与 `--check` 返回配置一致、会话位于项目内；八种 stdin 情形通过且 stderr 为空。recall/read 找到发布计划，指纹一致、无警告。
- 证据集中在本机 `.Sinos-temp/harness-validation/`；原始发布验证保留在 `.Sinos-temp/release-v4.0.6/validation/`。

## 尚待观察与后续

宿主真实 SessionStart 注入需要下一次相应会话事件，当前结果覆盖配置与脚本合约。用户可通过 `/hooks` 审核或重新加载配置。

整理交付时未提交、推送或发布；后续发布目标接续为 v4.0.7，于 11-15 完成远程原生协议、五平台 CI、十个安装包下载校验和公开发布，见[发布验收](../exec-plans/completed/2026-11-13-release-v4.0.7.md)。
