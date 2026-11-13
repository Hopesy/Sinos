# Sinos CLI 开发文档

## 从这里开始

- [AGENTS](../AGENTS.md)：共享指令与任务导航。
- [架构总览](ARCHITECTURE.md)：真实模块、依赖、数据流与维护入口。
- [协作约定](REPO_COLLAB_GUIDE.md)：保护变更、验证分工和项目 SessionStart 导航。
- [当前计划](exec-plans/README.md)：尚未交付的目标、接续摘要与下一动作。
- [贡献指南](../.github/CONTRIBUTING.md)：开发与 PR 流程。

## 现行专题

- [开发与兼容规则](design/development.md)
- [发布与验证](design/release.md)
- [Sinos Agent 使用与接口说明](design/agent.md)
- [Claude 移动事件](design/claude-mobile.md)
- [Codex 移动适配](design/codex-mobile.md)
- [上游兼容策略](design/upstream-compatibility.md)

## 计划与历史

- [计划约定](PLANS_GUIDE.md)、[计划模板](exec-plans/templates/execution-plan.md)、[技术债](exec-plans/tech-debt-tracker.md)
- [history 约定](HISTORY_GUIDE.md)、[history 模板](histories/template.md)
- [集成历史与回归记录](histories/upstream-integration.md)
- [历史发布记录](histories/legacy-releases.md)
- [内存测量记录](histories/memory-2026-11-01.md)
- [仓库整理与 harness-run 接入结果](histories/repository-organization.md)

当前客户端与 Release 正文共用 [install/release-notes-template.md](../install/release-notes-template.md)。本地前端命令、远程 Rust/原生协议验证及完整发版步骤统一维护在[发布规则](design/release.md)。

`design/`、`exec-plans/`、`histories/` 是共享 Markdown 正文位置；其他本地研究记录及非 Markdown 产物继续由 `.gitignore` 保护。临时文件与验收产物统一在 `.Sinos-temp/`，文档只链接关键证据。
