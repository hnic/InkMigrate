# InkMigrate

Local-first, verifiable, resumable, auditable knowledge-migration toolkit. Pluggable source/target adapters move content from various knowledge platforms into long-term-controllable open files.

> **Data safety**: All data processing, databases, attachments and auth state stay on the user's machine. Telemetry is off by default; no external AI APIs. Users may only migrate data they are authorized to access and must comply with source platforms' ToS and applicable law.

> **中文文档**：见 `README.zh-CN.md`（canonical README in Chinese）。

## Status

v1.0 has passed end-to-end verification: login → scan → migrate → unfavorite → resume, all working. Full spec: `docs/InkMigrate_Product_and_Technical_Requirements_v1.4_zh-CN.md`.

## Requirements

- Node.js ≥ 24 (requires `node:sqlite` support)
- pnpm ≥ 11
- On macOS / Linux: Xcode Command Line Tools (required for `better-sqlite3` native build)
- On Windows: Visual Studio Build Tools

## Installation

```bash
git clone <repo-url> InkMigrate
cd InkMigrate
pnpm install
pnpm --filter @inkmigrate/source-toutiao exec playwright install chromium
pnpm -r build

# Optional: register global command
ln -sf $(pwd)/apps/cli/dist/index.js ~/.local/bin/inkmigrate
```

## Usage

See `README.zh-CN.md` for complete usage instructions (Chinese is the canonical language for this project).

Quick reference:

```bash
inkmigrate init                                    # initialize workspace
inkmigrate auth login --source <id> --state-dir .inkmigrate    # login
inkmigrate scan --source <id> --state-dir .inkmigrate          # scan favorites
inkmigrate migrate --source <id> --target <id> --state-dir .inkmigrate --vault-path <path>  # migrate
inkmigrate resume --job <id> --state-dir .inkmigrate --vault-path <path>  # resume interrupted job
inkmigrate cleanup unfavorite --source <id> --state-dir .inkmigrate       # unfavorite
```

## Architecture

pnpm monorepo:

- `packages/core` — Migration core: domain models, state machine, SQLite persistence (WAL + FK + CHECK + partial unique indexes), adapter registry, API version gating, security (3-hash, log redaction, path guards), config schema, runtime locks, retry + rate control.
- `packages/target-obsidian` — Obsidian target adapter.
- `packages/source-toutiao` — Toutiao source adapter: Playwright browser login, incremental favorites scan, detail extraction, 9-stage HTML→Markdown safety pipeline, unfavorite.
- `packages/testkit` — Adapter contract test suite.
- `apps/cli` — CLI entry point.

## Testing

```bash
pnpm test                                                    # 457 tests
pnpm --filter @inkmigrate/source-toutiao test:browser        # 10 browser tests
pnpm -r typecheck
```

## License

See `LICENSE`.
