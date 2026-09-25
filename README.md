<p align="center">
  <img src="icons/icon-rounded.png" width="96" alt="Sinos CLI" />
</p>

<h1 align="center">Sinos CLI</h1>

<p align="center">
  <strong>Vibe Coding on one side, looking stylish on the other.</strong>
</p>

<p align="center">
  <a href="#english">English</a> ·
  <a href="#简体中文">简体中文</a> ·
  <a href="#繁體中文">繁體中文</a> ·
  <a href="#deutsch">Deutsch</a> ·
  <a href="#español">Español</a> ·
  <a href="#français">Français</a> ·
  <a href="#日本語">日本語</a> ·
  <a href="#한국어">한국어</a> ·
  <a href="#português">Português</a> ·
  <a href="#русский">Русский</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" />
  <img src="https://img.shields.io/badge/languages-10-orange" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%20%2B%20Rust-brown" />
  <img src="https://img.shields.io/github/license/Hopesy/sinos" />
</p>

<p align="center">
  <img src="screenshot/hero.png" alt="Sinos CLI — Launchpad with underwater wallpaper" width="860" />
</p>

---

## English

### What is Sinos CLI?

Sinos CLI is a rebranded fork of Coffee CLI by edison7009. It is a **native desktop workspace** for AI CLI agents — Claude Code, OpenAI Codex, Qwen, OpenCode, and more. Run multiple agents in parallel tabs, drive them with keyboard shortcuts via Gambit, automate them with hooks, and keep everything organized in one true desktop app — all with a **fully localized interface in 11 languages**.

This is not a web app. Not an Electron wrapper. A **true native desktop app** built with Tauri (Rust core), engineered for performance and low resource usage.

<p align="center">
  <img src="screenshot/wallpaper.jpg" alt="Sinos CLI workspace with custom wallpaper" width="860" />
</p>

### Supported AI CLIs

Sinos CLI can launch **any** command-line agent — but the ones below get deeper, purpose-built integration. The tier tells you how much of the workspace lights up for each one: **Dynamic Island** (live status), **History** (saved conversations), **Heatmap** (activity), **Changes** (diff panel), **Brand icon**, **One-click launch**, and **Custom launch args** (per-tool flags).

| Tier | What you get | CLIs |
|---|---|---|
| **T1** | Dynamic Island · History · Heatmap · Changes · Brand icon · One-click launch · Custom launch args | **Claude Code** · **Codex CLI** · **Grok Build** |
| **T2** | History · Heatmap · Changes · Brand icon · One-click launch · Custom launch args | OpenCode · mimocode · Kimi Code · OpenClaw · Hermes Agent · Antigravity · Qwen Code · Pi · Oh-My-Pi · CodeBuddy |
| **T3** | Brand icon · One-click launch | Crush · Aider · Goose · Copilot CLI · Cursor · Cline |
| **T4** | Open a terminal tab and type the command to launch | any other CLI |

*Dynamic Island status is hook-free for Claude Code, Codex CLI, Grok Build, Oh-My-Pi and Kimi Code. Sinos reads native terminal titles or supported screen states and does not install status hooks. Oh-My-Pi and CodeBuddy support history resume and conversation rendering on desktop and mobile.*

*T1 and T2 CLIs ship today; T3 integrations are rolling in.*

---

### Who is it for?

AI coding agents are transforming how work gets done — but they speak English, output dense terminal text, and assume you're comfortable with a command line. That leaves out a massive group of capable, intelligent professionals:

- **Business executives** who want AI to accelerate decisions and automate operations
- **Designers and creatives** who want to build and automate without learning bash
- **Product managers** who want to run agents against their own products
- **Researchers, analysts, consultants** — any domain expert who isn't a developer

Sinos CLI removes both barriers at once: **no terminal expertise required, no English required**.

---

### See It In Action

#### Theme Switching

Sinos CLI ships with multiple built-in themes. Switch between them instantly — the entire interface, including the active terminal session, updates live. No restart, no flicker. Whether you prefer a dark workspace late at night or a lighter tone during a presentation, one click is all it takes.

![Theme Switching](screenshot/theme-switching.gif)

---

#### Task Board

Your agent works fast. Keep up with it. The built-in task board lets you create and organize tasks into **To-Do / In Progress / Done** columns — right in the sidebar while the agent runs. No external tool, no tab switching. Everything the agent is doing and everything you still need it to do, visible at a glance.

![Task Board](screenshot/task-board.gif)

---

#### Session History

Every conversation with every agent is automatically saved. The **History panel** gives you a full searchable log of past sessions — scroll back through what was said, what was built, what went wrong. Pick up any past session exactly where you left off, or use it as context for a new one.

![Session History](screenshot/session-history.gif)

---

#### Multi-Tab: Vibe Coding + DOS Game

Run multiple agents and terminals in parallel, each in its own tab with its own independent context. Here: a **Claude Code vibe-coding session** running alongside a **DOS game in the built-in terminal** — two completely separate processes, zero interference. Sinos CLI handles whatever you throw at it.

![Multi-Tab Sessions](screenshot/multi-tab.gif)

---

#### 11-Language Interface

The Sinos CLI app ships with a fully localized UI in 11 languages — menus, dialogs, shortcuts, and every corner of the workspace speak English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский, or Tiếng Việt. Switch anytime from the settings.

![11 Languages](screenshot/multilingual.png)

---

### Key Features

| Feature | Description |
|---|---|
| **Multi-Tab Sessions** | Run multiple agents side by side, each with its own independent process and context |
| **Session History** | Every session auto-saved and searchable; resume any conversation from where you left off |
| **Built-In File Explorer** | Browse your workspace, copy paths, drag references directly into your prompt |
| **Task Board** | Organize what you've asked the agent to do across To-Do / In Progress / Done |
| **Agent Installer** | One-click install of Claude Code, Codex, and more — no terminal required |
| **Remote Terminal** | SSH into remote machines and run agents on servers without leaving the app |
| **External Launch** | Open the app straight into a fresh agent tab at a chosen folder from scripts, launchers, and file-manager context menus |

**11 languages supported out of the box:** English · 简体中文 · 繁體中文 · Deutsch · Español · Français · 日本語 · 한국어 · Português · Русский · Tiếng Việt

### External Launch (CLI)

`sinos-cli launch --tool <id> [--cwd <dir>]` skips the launchpad and drops
you straight into a new agent tab — for launcher apps, context menus,
Raycast/Alfred actions, and shell aliases. `--tool` is any registered tool
id (`claude`, `codex`, `kimicode`, `hermes`, …); omit `--cwd` to reuse the
tool's last folder. Already running? The request is forwarded to the
running instance and opens a new tab — existing sessions are never
restarted or hijacked.

```bash
# macOS — call the binary directly (LaunchServices drops --args when the app is already running)
"/Applications/Sinos CLI.app/Contents/MacOS/sinos-cli" launch --tool kimicode --cwd /work/project
# Windows — pair with an Explorer right-click entry that passes the folder as %V
sinos-cli.exe launch --tool claude --cwd "C:\work\project"
# Linux
sinos-cli launch --tool codex --cwd ~/work/project
```

---

### Install

**Windows**
```powershell
irm https://raw.githubusercontent.com/Hopesy/sinos/main/install/install.ps1 | iex
```

**macOS** (Apple Silicon & Intel)
```bash
curl -fsSL https://raw.githubusercontent.com/Hopesy/sinos/main/install/install.sh | sh
```

**Linux** (Debian / Ubuntu / AppImage)
```bash
curl -fsSL https://raw.githubusercontent.com/Hopesy/sinos/main/install/install.sh | sh
```

Or download directly from [Releases](https://github.com/Hopesy/sinos/releases).

| Platform | Installer |
|---|---|
| Windows x64 | `.exe` setup |
| macOS Apple Silicon (M1+) | `.dmg` |
| Linux Debian/Ubuntu | `.deb` |
| Linux universal | `.AppImage` |

### Build from Source

```bash
# Prerequisites: Rust, Node.js
git clone https://github.com/Hopesy/sinos
cd sinos
cd src-ui && npm install && cd ..
cargo tauri build
```

---

## 简体中文

### Sinos CLI 是什么？

Sinos CLI 是专为 AI CLI Agent 打造的**原生桌面工作台**，支持 Claude Code、OpenAI Codex、Qwen、OpenCode 等主流 Agent。多 Tab 并行运行、Gambit 快捷操控、Hook 自动化——所有 AI CLI 工具在一个真正的桌面应用里井然有序，**原生支持 11 种界面语言**。

这不是网页应用，不是 Electron 壳，而是基于 Tauri（Rust 内核）构建的**真正原生桌面应用**，性能优异，资源占用极低。

### 为谁而生？

AI 编程 Agent 正在改变工作方式——但它们说英语、输出密集的终端文本，默认你熟悉命令行。这将大量有能力、有智识的专业人士拒之门外：

- **企业高管**：想用 AI 加速决策、自动化业务流程
- **设计师与创意人**：想构建和自动化，但不想学 bash
- **产品经理**：想直接对自己的产品跑 Agent
- **研究员、分析师、顾问**：各行各业的领域专家，不是开发者

Sinos CLI 同时消除两道门槛：**不需要终端经验，不需要懂英语**。

### 核心功能

**多 Tab 会话** · **Gambit 快捷命令** · **Hook 自动化** · **会话历史** · **内置文件浏览器** · **任务板** · **Agent 安装器** · **远程终端** · **外部唤起**

原生支持 11 种语言，开箱即用。

### 外部唤起（命令行）

`sinos-cli launch --tool <id> [--cwd <dir>]` 跳过启动台，直接新开一个指定 Agent、指定目录的标签页——适合启动器、资源管理器右键菜单、Raycast/Alfred、脚本别名。`--tool` 取注册表中的 id（`claude`、`codex`、`kimicode`、`hermes`……）；省略 `--cwd` 时沿用该工具上次使用的目录。应用已在运行时，请求会转发给运行中的实例新开标签页，不影响已有会话。

```bash
# macOS —— 建议直接调用二进制（应用已运行时，open -a 的 --args 会被系统丢弃）
"/Applications/Sinos CLI.app/Contents/MacOS/sinos-cli" launch --tool kimicode --cwd /work/project
# Windows —— 配合资源管理器右键菜单，用 %V 传入当前文件夹
sinos-cli.exe launch --tool claude --cwd "C:\work\project"
# Linux
sinos-cli launch --tool codex --cwd ~/work/project
```

### 安装

**Windows**
```powershell
irm https://raw.githubusercontent.com/Hopesy/sinos/main/install/install.ps1 | iex
```

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/Hopesy/sinos/main/install/install.sh | sh
```

也可以直接从 [Releases](https://github.com/Hopesy/sinos/releases) 下载对应平台的安装包。

---

## 繁體中文

### Sinos CLI 是什麼？

Sinos CLI 是專為 AI CLI Agent 打造的**原生桌面伴侶應用**，支援 Claude Code、OpenAI Codex 等主流 Agent。它將終端包裝進完整的圖形介面，並實現了其他任何工具都沒有的功能：**將整個 CLI Agent 介面即時翻譯成你的母語**。

這不是網頁應用，不是 Electron 殼，而是基於 Tauri（Rust 核心）構建的**真正原生桌面應用**，效能優異，資源佔用極低。

Sinos CLI 同時消除兩道門檻：**不需要終端經驗，不需要懂英語**。

**核心功能：** 即時終端翻譯 · 多 Tab 會話 · 會話歷史 · 內建檔案瀏覽器 · 任務板 · Agent 安裝器 · 遠端終端

原生支援 11 種語言，開箱即用。

---

## Deutsch

### Was ist Sinos CLI?

Sinos CLI ist eine **native Desktop-Begleit-App** für KI-CLI-Agenten — Claude Code, OpenAI Codex und mehr. Es bettet Ihr Terminal in eine vollständige GUI ein und tut etwas, das kein anderes Tool leistet: Es **übersetzt die gesamte CLI-Agent-Oberfläche in Ihre Muttersprache, in Echtzeit**.

Keine Web-App. Kein Electron-Wrapper. Eine **echte native Desktop-Anwendung**, gebaut mit Tauri (Rust-Kern).

Sinos CLI beseitigt beide Hürden gleichzeitig: **Keine Terminal-Kenntnisse erforderlich, kein Englisch erforderlich.**

**Hauptfunktionen:** Echtzeit-Terminal-Übersetzung · Multi-Tab-Sitzungen · Sitzungsverlauf · Datei-Explorer · Aufgaben-Board · Agent-Installer · Remote-Terminal

11 Sprachen werden nativ unterstützt.

---

## Español

### ¿Qué es Sinos CLI?

Sinos CLI es una **aplicación de escritorio nativa** diseñada para agentes de IA en CLI — Claude Code, OpenAI Codex y más. Envuelve tu terminal en una interfaz gráfica completa y hace algo que ninguna otra herramienta hace: **traduce toda la interfaz del agente CLI a tu idioma nativo, en tiempo real**.

No es una aplicación web. No es un envoltorio de Electron. Es una **aplicación de escritorio nativa real**, construida con Tauri (núcleo en Rust).

Sinos CLI elimina ambas barreras a la vez: **sin necesidad de experiencia en terminal, sin necesidad de saber inglés.**

**Funciones principales:** Traducción de terminal en tiempo real · Sesiones multi-pestaña · Historial de sesiones · Explorador de archivos · Tablero de tareas · Instalador de agentes · Terminal remota

10 idiomas compatibles de serie.

---

## Français

### Qu'est-ce que Sinos CLI ?

Sinos CLI est une **application de bureau native** conçue pour les agents IA en ligne de commande — Claude Code, OpenAI Codex et autres. Elle enveloppe votre terminal dans une interface graphique complète et fait quelque chose qu'aucun autre outil ne fait : **elle traduit toute l'interface de l'agent CLI dans votre langue maternelle, en temps réel**.

Ce n'est pas une application web. Pas un wrapper Electron. Une **vraie application de bureau native**, construite avec Tauri (cœur Rust).

Sinos CLI supprime les deux barrières à la fois : **aucune expertise terminal requise, aucune connaissance de l'anglais requise.**

**Fonctionnalités clés :** Traduction de terminal en temps réel · Sessions multi-onglets · Historique des sessions · Explorateur de fichiers · Tableau de tâches · Installeur d'agents · Terminal distant

10 langues prises en charge nativement.

---

## 日本語

### Sinos CLI とは？

Sinos CLI は、AI CLI エージェント（Claude Code、OpenAI Codex など）向けに作られた**ネイティブデスクトップコンパニオンアプリ**です。ターミナルを完全な GUI でラップし、他のどのツールも実現していない機能を提供します：**CLI エージェントのインターフェース全体をリアルタイムであなたの母国語に翻訳する**機能です。

ウェブアプリでも Electron ラッパーでもありません。Tauri（Rust コア）で構築された**真のネイティブデスクトップアプリ**です。

Sinos CLI はその2つのハードルを同時に取り除きます：**ターミナルの知識不要、英語不要**。

**主な機能：** リアルタイム翻訳 · マルチタブセッション · セッション履歴 · ファイルエクスプローラー · タスクボード · エージェントインストーラー · リモートターミナル

11言語をネイティブサポート。

---

## 한국어

### Sinos CLI란?

Sinos CLI는 AI CLI 에이전트(Claude Code, OpenAI Codex 등)를 위한 **네이티브 데스크톱 컴패니언 앱**입니다. 터미널을 완전한 GUI로 감싸고, 다른 어떤 도구도 하지 못하는 기능을 제공합니다: **CLI 에이전트 인터페이스 전체를 실시간으로 모국어로 번역**합니다.

웹 앱도 아니고 Electron 래퍼도 아닙니다. Tauri(Rust 코어)로 구축된 **진정한 네이티브 데스크톱 앱**입니다.

Sinos CLI는 두 가지 장벽을 동시에 제거합니다: **터미널 지식 불필요, 영어 불필요**.

**주요 기능:** 실시간 번역 · 멀티탭 세션 · 세션 히스토리 · 파일 탐색기 · 작업 보드 · 에이전트 설치 관리자 · 원격 터미널

11개 언어 기본 지원.

---

## Português

### O que é o Sinos CLI?

Sinos CLI é um **aplicativo de desktop nativo** projetado para agentes de IA em CLI — Claude Code, OpenAI Codex e outros. Ele envolve seu terminal em uma interface gráfica completa e faz algo que nenhuma outra ferramenta faz: **traduz toda a interface do agente CLI para seu idioma nativo, em tempo real**.

Não é um aplicativo web. Não é um wrapper Electron. É um **verdadeiro aplicativo de desktop nativo**, construído com Tauri (núcleo em Rust).

Sinos CLI elimina as duas barreiras ao mesmo tempo: **sem necessidade de experiência em terminal, sem necessidade de saber inglês.**

**Recursos principais:** Tradução de terminal em tempo real · Sessões multi-aba · Histórico de sessões · Explorador de arquivos · Quadro de tarefas · Instalador de agentes · Terminal remoto

10 idiomas suportados nativamente.

---

## Русский

### Что такое Sinos CLI?

Sinos CLI — это **нативное десктопное приложение-компаньон** для ИИ-агентов в CLI — Claude Code, OpenAI Codex и других. Оно оборачивает терминал в полноценный графический интерфейс и делает то, чего не умеет ни один другой инструмент: **переводит весь интерфейс CLI-агента на ваш родной язык в реальном времени**.

Это не веб-приложение. Не обёртка на Electron. Настоящее **нативное десктопное приложение**, построенное на Tauri (ядро на Rust).

Sinos CLI устраняет оба барьера одновременно: **не нужно знать терминал, не нужно знать английский**.

**Ключевые функции:** Перевод терминала в реальном времени · Мультивкладочные сессии · История сессий · Файловый проводник · Доска задач · Установщик агентов · Удалённый терминал

11 языков поддерживается нативно.

---

## Upstream and License

Sinos CLI is a rebranded fork of [Coffee CLI](https://github.com/edison7009/Coffee-CLI) by edison7009.
The application name, package metadata, distribution artifacts, and visual identity in this repository have been changed to Sinos CLI.

The code remains licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
The original Coffee CLI copyright, attribution, design notices, and trademark policy are preserved in [NOTICE](NOTICE) and [TRADEMARKS.md](TRADEMARKS.md).
Coffee CLI, Gambit, Pitch, VibeID, Vibetype, Coffee-CLI MCP, Sentinel Protocol, Hyper-Agent, and the other upstream marks named there remain the property of their respective upstream owner; this fork does not claim them as Sinos marks.

Sinos CLI uses a separate Sinos name and the distinct assets under [`branding/sinos`](branding/sinos).

---

上游与许可证：Sinos CLI 是 [Coffee CLI](https://github.com/edison7009/Coffee-CLI) 的重品牌分支。
本仓库已将应用名称、包元数据、发行产物和视觉标识切换为 Sinos CLI；代码继续遵循 [AGPL-3.0-or-later](LICENSE)。
Coffee CLI 的原始版权、设计署名和商标边界完整保留在 [NOTICE](NOTICE) 与 [TRADEMARKS.md](TRADEMARKS.md) 中，本分支不将这些上游标识主张为 Sinos 的权利。

Copyright © 2024-2026 edison7009 and Coffee CLI contributors.
Sinos CLI rebranding and subsequent modifications © 2026 Sinos CLI contributors.
