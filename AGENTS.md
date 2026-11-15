# Sinos CLI 项目导航与规则

跟随仓库 commit，随 branch 一起流转。补充 `~/.Codex/AGENTS.md` 的全局规则；冲突时以全局规则为准。

## 工作入口

- 首次接手先读[协作约定](docs/REPO_COLLAB_GUIDE.md)，核对 Git 状态和[当前计划](docs/exec-plans/README.md)的接续摘要。
- 模块与数据流见[架构总览](docs/ARCHITECTURE.md)；按任务读取其链接的 `docs/design/` 专题。
- **代码修改、自检及 review 必须遵守[开发与兼容规则](docs/design/development.md)**，包含剪贴板、Tauri、安装脚本和 hook 的现行硬规则。
- **code-review 或发布必须读取[完整发布与验证规则](docs/design/release.md)**，覆盖整批改动、统一测试入口、五平台 CI、版本/提交/tag、草稿、十个安装包及五语言日志核验。质量门禁保持完整。
- 最近交付见 [v4.0.7 发布验收](docs/exec-plans/completed/2026-11-13-release-v4.0.7.md)，沿用 v4.0.6 的接续记录。本轮目录/文档整理与正式发布分别验收。

## 用户可见文案

- 界面、提示、Agent 身份、通知和发布说明统一使用 Sinos CLI / Sinos Agent。更新日志直接描述用户得到的功能和修复，省略“合并上游”等开发过程表述。
- 产品反馈入口指向 `https://github.com/Hopesy/Sinos/issues`。每次整合外部更新，检查所有语言的品牌与链接，尤其是新增页面和英文回退文案。
- 版权、许可证与来源署名保留在 `NOTICE`、许可证文件、第三方声明和 README 来源说明中。历史兼容用的配置目录、数据库键和协议标识保持稳定。

## 记录与接续

- 同一长期目标使用[一份计划](docs/PLANS_GUIDE.md)，TODO、进度和接续摘要一起维护；同一任务沿用[一份 history](docs/HISTORY_GUIDE.md)。
- 用户修正及时写回约束；重要节点记录当前目标、已验证版本/范围、证据、待验收项、下一动作及阻塞。
- 现行事实和规则维护在架构或 design；决定变更注明条件、原因和替代位置。历史疑问先查相关短摘录，再展开原文。
- 新旧文档切换时承接独有内容、修正所有消费者并核验，再清理旧文件和跳转副本。详细日志、截图、过程文件及恢复备份放 `.Sinos-temp/`。
- 当前执行分工：本地源码审查和前端验证；Rust 检查、原生协议测试与五平台安装包由 GitHub Actions 执行。工具链安装和发布按用户授权及[发布规则](docs/design/release.md)处理。
