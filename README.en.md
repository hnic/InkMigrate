# InkMigrate

<div align="center">
  <img src="./docs/assets/logo.png" alt="InkMigrate Logo" width="100" height="100" />
  <p><strong>Reclaim your knowledge. Own your thoughts.</strong></p>
  <p>A Local-First, Verifiable, Resumable, and Auditable Knowledge Migration Engine.</p>

  <p>
    <a href="./README.md"><strong>简体中文文档 (Main)</strong></a> ·
    <a href="https://github.com/hnic/InkMigrate/releases">Releases</a> ·
    <a href="#quick-start">Quick Start</a> ·
    <a href="#features">Features</a> ·
    <a href="#architecture">Architecture</a>
  </p>
</div>

---

## Overview

**InkMigrate** is an enterprise-grade, local-first knowledge migration engine designed to liberate your digital assets from closed, proprietary platforms (such as Toutiao, Evernote, and Yinxiang) into open, future-proof formats like Obsidian Vaults (Markdown + attachments + Wikilinks).

> **Data Sovereignty & Privacy First**: All data processing, SQLite state storage, attachments, and session tokens remain strictly on your local machine. Zero telemetry, zero cloud relays, and zero external AI API integrations.

---

## ✨ Features

- **Modern Desktop GUI (Tauri 2 + React 19)**:
  - Clean, slate/blue dark mode meeting WCAG AA contrast standards.
  - Native OS file & directory pickers (macOS AppleScript / Windows PowerShell UTF-8 / Linux Zenity) with async path validity checks.
  - Collapsible 36px console drawer freeing 180px+ viewport, with log-level filtering (Error/Warn), search, and clipboard copy.
  - Decoupled offline source workflows (Evernote migration works completely offline without login requirements).
  - Searchable scan table with real-time fuzzy filtering and external article openers.
- **Pluggable Source Adapters**:
  - **Toutiao (今日头条)**: Browser-automated session management via Playwright, rate-limited extraction, and automated unfavoriting.
  - **Evernote & Yinxiang (印象笔记)**: Supports both international `.enex` exports and China-edition HTML export directories. Automatic GUID-to-Wikilink resolution across notebook hierarchies.
- **Obsidian Target Adapter**:
  - Rich YAML Frontmatter injection, callout metadata headers, and hierarchical notebook folder structure (`Stack/Notebook-<hash>/`).
  - Strict idempotent asset deduplication and automatic title-collision resolution (`Title-2.md`).
- **Engineered Reliability**:
  - **Deterministic Idempotency**: Safe interruptions and instant resumption (`inkmigrate resume --job <id>`).
  - **Two-Way Reconciliation & Audit**: SQLite WAL transactional state with detailed JSON and Markdown audit reports (`summary`, `details`, `failures`).
  - **Process Isolation**: High-performance JSON-RPC over stdio sidecar architecture.

---

## ⚡️ Quick Start

### Requirements

- **Node.js**: ≥ 24.15.0
- **pnpm**: ≥ 11
- **C/C++ Build Tools**: Xcode CLI Tools (macOS) or Visual Studio Build Tools (Windows) for `better-sqlite3` native bindings.

### Installation

```bash
# Clone the repository
git clone https://github.com/hnic/InkMigrate.git
cd InkMigrate

# Install dependencies and setup Playwright Chromium
pnpm install
pnpm --filter @inkmigrate/source-toutiao exec playwright install chromium

# Build all workspace packages
pnpm -r build
```

### Desktop GUI

```bash
pnpm --filter @inkmigrate/gui run tauri dev
```

### CLI Workflow

```bash
# 1. Initialize workspace
inkmigrate init

# 2. Authenticate (for cloud sources like Toutiao)
inkmigrate auth login --source toutiao-main --state-dir .inkmigrate

# 3. Scan remote or local favorites
inkmigrate scan --source toutiao-main --state-dir .inkmigrate --favorites-url "<FAVORITES_URL>"

# 4. Migrate to Obsidian Vault
inkmigrate migrate \
  --source toutiao-main \
  --target obsidian-main \
  --state-dir .inkmigrate \
  --vault-path "/path/to/your/Obsidian/Vault" \
  --favorites-url "<FAVORITES_URL>"

# 5. Resume an interrupted job
inkmigrate resume --job <JOB_ID> --state-dir .inkmigrate --vault-path "/path/to/your/Obsidian/Vault"
```

---

## 🛠 Desktop App Packaging (macOS .app / .dmg)

InkMigrate packages a self-contained desktop bundle with **Tauri 2 + Node.js Sidecar + Embedded Chromium**. The resulting `.app` and `.dmg` bundles require no pre-installed Node.js or system dependencies on target machines.

### 1. Prerequisites
- **Node.js**: ≥ 24.15.0
- **pnpm**: ≥ 11
- **Rust / Cargo**: Latest stable (`rustup`)
- **Xcode Command Line Tools**: `xcode-select --install`

### 2. Build the Bundle
Run the single top-level packaging command:

```bash
# Compiles monorepo + builds self-contained sidecar (Node + Chromium) + bundles macOS .app & .dmg
pnpm bundle
```

### 3. Artifact Locations
- **macOS Application**: `apps/gui/src-tauri/target/release/bundle/macos/InkMigrate.app`
- **macOS Disk Image (DMG)**: `apps/gui/src-tauri/target/release/bundle/dmg/InkMigrate_1.0.0_aarch64.dmg` (or `x64`)

### 4. macOS Gatekeeper Note
For locally built, unsigned apps, macOS may show *"InkMigrate is damaged and can't be opened"*. Strip the quarantine flag using:

```bash
xattr -cr /Applications/InkMigrate.app
```
*(Or navigate to **System Settings -> Privacy & Security** and click **Open Anyway**).*

---

## 🏛 Architecture

Monorepo powered by `pnpm workspace`:

- `packages/core`: Core state machine, SQLite schema & WAL persistence, security guards, reconciliation.
- `packages/target-obsidian`: Markdown generator, Frontmatter injector, wikilink builder, index creator.
- `packages/source-toutiao`: Playwright browser session driver, incremental crawler, unfavorite automation.
- `packages/source-evernote`: ENEX and HTML export parser, attachment hash verification.
- `packages/protocol`: Shared JSON-RPC TypeScript types and contracts.
- `apps/cli`: Command-line executable (`inkmigrate`).
- `apps/engine`: Node.js sidecar service communicating via JSON-RPC over stdio.
- `apps/gui`: Tauri 2 + React 19 cross-platform desktop application.

---

## 🧪 Testing

```bash
# Run full unit & contract test suite (600+ tests)
pnpm test

# Run browser automated test suite
pnpm --filter @inkmigrate/source-toutiao test:browser

# Run strict TypeScript typecheck
pnpm -r typecheck
```

---

## 📄 License

See [LICENSE](./LICENSE).
