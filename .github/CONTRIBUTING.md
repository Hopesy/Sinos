# Contributing to Sinos CLI / 贡献指南

Thanks for contributing to Sinos CLI. / 感谢你参与 Sinos CLI。

## Workflow

1. Fork this repository and create a branch from `main`.
2. Keep each change focused and use Conventional Commits such as `feat(area): ...` or `fix(area): ...`.
3. Run the local frontend checks in the [validation guide](../docs/design/release.md). GitHub Actions runs Rust checks, native protocol tests and platform builds; wait for the required CI jobs to pass.
4. Describe why the change is needed, what was changed, and how it was verified.

## License and upstream attribution

Contributions to this repository are accepted under AGPL-3.0-or-later unless a file states otherwise.
Sinos CLI is a rebranded fork of Coffee CLI by edison7009. Do not remove the original copyright and attribution recorded in `NOTICE`, git history, or source files.

The upstream Coffee CLI marks are governed by [TRADEMARKS.md](../TRADEMARKS.md).
Sinos CLI uses a separate name and distinct Sinos visual assets; contributing code does not transfer ownership of either upstream or Sinos brand assets.

---

## 中文说明

1. 从 `main` 创建功能分支。
2. 保持改动聚焦，提交信息使用 `feat(area): ...`、`fix(area): ...` 等 Conventional Commits。
3. 按[验证指南](../docs/design/release.md)运行本地前端验证；Rust 检查、原生协议测试及平台构建由 GitHub Actions 执行，等待必要 CI 作业通过。
4. PR 中说明改动原因、实现内容和验证结果。

贡献默认按 AGPL-3.0-or-later 接收。Sinos CLI 是 Coffee CLI by edison7009 的重品牌分支；不得删除 `NOTICE`、Git 历史和源码中的原始版权与署名。
Coffee CLI 上游商标边界以 [TRADEMARKS.md](../TRADEMARKS.md) 为准；Sinos CLI 使用独立名称与独立视觉资产。
