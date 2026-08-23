<details open>
<summary><b>🇨🇳 简体中文</b></summary>

### Sinos CLI v3.4.9

- **Coffee CLI 已正式更名为 Sinos CLI。** 应用名称、安装包、仓库地址、桌面标识和全套图标均已统一更新，同时保留旧配置目录与 Hook 标识的兼容读取，现有用户升级后无需迁移配置。
- **文件浏览器现在集成 Monaco Editor。** 双击或通过右键菜单即可打开文件，支持多标签、常见语言高亮及 `Ctrl+S` / `Cmd+S` 保存；UTF-8 BOM 和换行格式会被保留，并通过文件大小、二进制、工作区边界和外部修改检查保护写入安全。
- **GitHub Release 改为多平台资产就绪后再提供更新。** Windows、macOS 和 Linux 安装包采用统一的 Sinos 命名；版本接口只会在对应平台资产实际上传后返回新版，避免 CI 编译期间出现可见版本已更新但安装包仍为 404 的时间差。
- **Linux AppImage 发布链路已补齐。** x64 与 arm64 AppImage 会与 DEB、RPM 一起构建、重命名并上传，发布前的 workflow 还会验证全部平台资产是否完整。

</details>

<details>
<summary><b>🇬🇧 English</b></summary>

### Sinos CLI v3.4.9

- **Coffee CLI is now Sinos CLI.** The application name, installer packages, repository links, desktop identity and complete icon set have been updated consistently, while legacy configuration directories and hook identifiers remain readable so existing users can upgrade without migrating settings.
- **The file explorer now opens files in Monaco Editor.** Double-click or use the context menu to edit with multiple tabs, language-aware highlighting and `Ctrl+S` / `Cmd+S` saving. UTF-8 BOM and line endings are preserved, while file-size, binary, workspace-boundary and external-change checks protect writes.
- **GitHub releases now expose updates only after platform assets are ready.** Windows, macOS and Linux packages use consistent Sinos names, and the version endpoint reports a release only when the requested platform asset has actually been uploaded, eliminating the CI window where an update was visible but its download still returned 404.
- **Linux AppImage publishing is now complete.** x64 and arm64 AppImages are built, renamed and uploaded alongside DEB and RPM packages, and the workflow verifies that every platform asset is present before release review.

</details>

<details>
<summary><b>🇹🇼 繁體中文</b></summary>

### Sinos CLI v3.4.9

- **Coffee CLI 已正式更名為 Sinos CLI。** 應用程式名稱、安裝套件、儲存庫連結、桌面識別與整套圖示均已一致更新，同時保留舊設定目錄與 Hook 識別的相容讀取，現有使用者升級後無須搬移設定。
- **檔案瀏覽器現在整合 Monaco Editor。** 雙擊或使用右鍵選單即可開啟檔案，支援多分頁、常見語言醒目提示及 `Ctrl+S` / `Cmd+S` 儲存；UTF-8 BOM 與換行格式會被保留，並透過檔案大小、二進位、工作區邊界及外部修改檢查保護寫入安全。
- **GitHub Release 改為多平台資產就緒後才提供更新。** Windows、macOS 與 Linux 安裝套件採用一致的 Sinos 命名；版本介面只會在對應平台資產實際上傳後回傳新版，避免 CI 編譯期間出現版本已更新但下載仍為 404 的時間差。
- **Linux AppImage 發布鏈路已補齊。** x64 與 arm64 AppImage 會與 DEB、RPM 一起建置、重新命名並上傳，發布前的 workflow 還會驗證所有平台資產是否完整。

</details>

<details>
<summary><b>🇯🇵 日本語</b></summary>

### Sinos CLI v3.4.9

- **Coffee CLI は Sinos CLI に正式に改名されました。** アプリ名、インストーラー、リポジトリリンク、デスクトップ識別子、アイコン一式を統一して更新しました。従来の設定ディレクトリと Hook 識別子は互換性のため引き続き読み込まれるため、既存ユーザーの設定移行は不要です。
- **ファイルエクスプローラーに Monaco Editor を統合しました。** ダブルクリックまたはコンテキストメニューからファイルを開き、複数タブ、主要言語のハイライト、`Ctrl+S` / `Cmd+S` 保存を利用できます。UTF-8 BOM と改行形式を保持し、サイズ、バイナリ、ワークスペース境界、外部変更の検査で安全に保存します。
- **GitHub Release は各プラットフォームの成果物が揃ってから更新を公開します。** Windows、macOS、Linux のパッケージ名を Sinos 形式に統一し、対象プラットフォームの成果物が実際にアップロードされた場合のみバージョン API が新版を返すため、CI 実行中の 404 を防ぎます。
- **Linux AppImage の公開フローを完成させました。** x64 と arm64 の AppImage を DEB、RPM とともにビルド、命名、アップロードし、公開前に全プラットフォームの成果物が揃っているか workflow で検証します。

</details>

<details>
<summary><b>🇰🇷 한국어</b></summary>

### Sinos CLI v3.4.9

- **Coffee CLI가 Sinos CLI로 공식 변경되었습니다.** 앱 이름, 설치 패키지, 저장소 링크, 데스크톱 식별자와 전체 아이콘 세트를 일관되게 갱신했습니다. 기존 설정 디렉터리와 Hook 식별자는 호환성을 위해 계속 읽으므로 기존 사용자는 설정을 이전할 필요가 없습니다.
- **파일 탐색기에 Monaco Editor가 통합되었습니다.** 더블 클릭하거나 컨텍스트 메뉴에서 파일을 열어 다중 탭, 주요 언어 강조 표시, `Ctrl+S` / `Cmd+S` 저장을 사용할 수 있습니다. UTF-8 BOM과 줄바꿈 형식을 유지하며 파일 크기, 바이너리, 작업 공간 경계, 외부 변경 검사를 통해 안전하게 저장합니다.
- **GitHub Release는 플랫폼별 설치 파일이 준비된 뒤에만 업데이트를 제공합니다.** Windows, macOS, Linux 패키지 이름을 Sinos 형식으로 통일했으며, 요청한 플랫폼의 파일이 실제로 업로드된 경우에만 버전 API가 새 버전을 반환하므로 CI 빌드 중 다운로드가 404가 되는 시간 차를 없앴습니다.
- **Linux AppImage 게시 흐름이 완성되었습니다.** x64 및 arm64 AppImage를 DEB, RPM과 함께 빌드하고 이름을 통일해 업로드하며, 공개 전에 모든 플랫폼 파일이 존재하는지 workflow가 검증합니다.

</details>
