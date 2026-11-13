## 发版检查清单

默认顺序：**整批审查并修复 → 自动化回归与五平台检查 → 构建安装包并上传草稿 → 核对全部产物 → 正式发布 → 核对远程版本与更新日志**。

### 整批审查

- 用户要求 code-review 或发布时，检查本次待交付的整批改动及关联交互，不只检查最后一个小修复。先确认分支、提交范围和未提交内容，保护其他人的修改，不顺带重构无关模块。
- 根据本批改动覆盖相关边界：缓存与后台刷新、首次启动和未安装状态、目录失效、配置写入与关闭后的清理、并发切换与取消、会话关闭与进程退出、主题／多语言、跨平台路径和权限。
- 真实缺陷应补充能复现问题的回归，再修复生产逻辑；交互时序问题不能靠任意延时、放宽断言或删除测试掩盖。新增回归须进入统一测试入口，不以历史测试数量作为免检依据。
- 发版执行下列全套验证；普通提交按影响范围验证。纯文档修改核对差异与实际流程即可，不必重跑无关功能测试。需要真实账号、另行安装的工具或特定机器的实测单独报告，不把模拟服务检查写成真实工具实测。

### 统一验证入口

发布前使用统一入口，避免手写脚本名单漏掉新功能。Rust 检查、原生程序构建、原生协议回归和五平台安装包默认全部在 GitHub Actions 执行；本地只做源码审查及前端验证，保留 CI 结果与产物核验。除非用户另行要求，不在本机安装 Rust／打包工具链或创建 Rust 构建缓存。远程验证项目和通过标准保持完整：

- 前端：在 `src-ui` 执行 `npm run build`、`npm run lint`、`npm test`、`npm run test:browser`、`npm audit --audit-level=high --omit=dev`；浏览器首次运行前执行 `npx playwright install chromium`，Linux CI 按工作流安装系统依赖。
- 后端：`cargo check --locked`、`cargo clippy --locked --all-targets --all-features -- -D clippy::correctness -D clippy::suspicious`、`cargo test --locked --no-fail-fast`。
- 原生编排协议：构建当前可执行文件后，通过 `COFFEE_TEST_EXE` 指定它，在 `src-ui` 执行 `npm run test:native`；各发布平台打包后、上传前也要验证最终编译出的程序。此测试只连接本地模拟服务，不启动真实工具任务。
- 主分支／PR 的 Review 和 Release 的 quality 均须包含前端构建、Lint、回归、依赖审计及 Rust 检查和测试；原生编排协议由 Release 的 quality 和各平台产物检查覆盖。quality 失败不得进入安装包构建。手动真实账号测试和基准测试不纳入自动入口。
- 五平台检查覆盖 Windows x64、macOS ARM64／Intel、Linux x64／ARM64。发版必须核对实际发布提交对应的 Review 与 Release 结果，等待必要作业全部成功；触发 CI、开始编译或仅本机通过都不算发布完成。
- 全仓格式与普通 Clippy 风格警告存在历史基线；新增正确性／可疑行为错误必须阻止发布，不为消除风格警告顺带重构无关模块。

### 版本、提交与构建

每次发 Sinos CLI 新版本严格按照这 5 步，一步都不能省：

1. **三处版本号同步**到同一个 SemVer 值：
   - `Cargo.toml` → `[package].version`
   - `tauri.conf.json` → `version`
   - `Cargo.lock` → 项目自身的 package version；在远程 Rust 环境运行不带 `--locked` 的 `cargo check` 自动同步，将生成的锁文件纳入 release commit，再执行锁定检查，不手改锁文件。
2. **完整验证（本地前端 + 远程原生）** — 本地执行前端统一入口；Rust 检查、测试、原生协议回归与安装包构建由 GitHub Actions 执行。推送后核对实际发布提交的五平台 Review 与 Release 结果，全部成功后才能公开发布。
3. **Conventional Commit**：
   - 功能/修复 commit 用 `feat(area):` / `fix(area):`
   - 最后一个版本 commit 是 `chore(release): v<x.y.z>`
   - Commit message 英文，不含网站（Web-Home）相关内容
4. **Tag + Push 触发 CI**：
   - `git tag v<x.y.z>` 打在 release commit 上
   - `git push origin main && git push origin v<x.y.z>`
   - 正常发版通过 Tag push 触发 CI Release workflow；仅 push commit 不会触发安装包发布流程
5. **验证 CI 权限** — 确保 workflow 配置里有 `permissions: contents: write`（踩过 GITHUB_TOKEN 只读的坑）

### 草稿与产物核对（公开前必做）

- 安装包先上传到 Release 草稿，等所有必要 CI 作业结束并确认成功，再公开发布。用户授权发布版本包含最终公开草稿步骤，不重复请求确认；普通开发或文档修改不自动授权发版。
- 十个安装包必须齐全：Windows x64 的 EXE／MSI，macOS ARM64／Intel 的 DMG，Linux x64／ARM64 各自的 DEB／RPM／AppImage。核对版本、平台命名、上传完成状态和非空文件，实际下载全部安装包，计算 SHA-256 并与 GitHub 资产摘要逐一比较；Windows MSI 还需核对包内 ProductVersion。
- 已推送标签的候选版本若查出真实缺陷，停止出包并保持未公开；修复后使用新版本和新标签，不改写已推送标签，不公开已知有问题的候选包。

### 更新日志（每次发布必做）

- 更新 `install/release-notes-template.md` 的五种语言内容，所有标题版本必须与本次版本一致；`node src-ui/scripts/run-release-notes-test.mjs` 会检查内置日志与应用版本。每次只简要记录本版本的新增、改进与修复，不沿用旧版完整说明，也不累加旧版本内容。
- Release 草稿与客户端内置日志使用同一份模板。安装包全部上传并验证后再正式发布；授权发布版本时包含这一步。
- 桌面更新只走 `Hopesy/Sinos` 的 GitHub Releases，版本查询、安装包下载和更新日志均使用该仓库。客户端日志先查询 latest，版本与当前安装版本不符时读取对应 tag，离线时使用内置模板。
- 发布完成须核对 `Hopesy/Sinos` 的 GitHub latest 指向本版、十个安装包齐全、Release 正文与五语言内置模板一致。最终报告发布链接、验证结果和未实测范围。
- 首次安装或升级按已安装版本展示一次，旧版客户端不能提前展示新版日志。

**版本号自增规则**：

- **默认每次发版都 patch+1**，无论 feat / fix / chore，一视同仁
- **不要按 SemVer 跳 minor**：用户看不到 v2.5.x → v2.6.0 的 "minor 语义"，他们看到的就是"又有更新"。直接跳 minor = 浪费 v2.5.2 ~ v2.5.9 这 8 个号
- **禁止两位 patch**：`v2.5.9` 后下一个发 `v2.6.0`（不是 `v2.5.10`）。这是触发 minor bump 的**唯一**条件
- 反例：v2.5.1 加了 Changes tab 新功能就发 v2.6.0 ❌ —— 应该发 v2.5.2 ✅。已踩过这个坑（2026-05-08）

### version.json 已不再手动维护（v1.0.2+）

旧的"第 6 步——改 `Web-Home/version.json` 为新版本号"已经**废弃并删除**。

历史问题：静态 version.json 在 tag push 的瞬间就指向新版，但 CI 构建各平台安装包要 15-20 分钟；用户在这窗口内跑 `install.ps1`，脚本能读到 "Latest: v1.x.y" 但 `/download/windows` 返回 404——糟糕体验。

当前桌面分发链路：
- GitHub Releases 的草稿在全部安装包上传并核验后公开，客户端查询已公开的 latest release。
- 两份 install 脚本（`install.ps1` + `install.sh`）直接查询 `Hopesy/Sinos` 的 GitHub latest release，并确认目标平台安装包存在；缺少安装包时提示稍后重试。

结果：发版时**零手动 version.json 维护**，用户侧**零时间差**。
