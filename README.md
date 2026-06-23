# InkMigrate

Local-first, verifiable, resumable, auditable knowledge-migration toolkit. Pluggable source/target adapters move content from various knowledge platforms into long-term-controllable open files.

> **Data safety**: All data processing, databases, attachments and auth state stay on the user's machine. Telemetry is off by default; no external AI APIs. Users may only migrate data they are authorized to access and must comply with source platforms' ToS and applicable law.

## Status

Currently at v1.0 stage 4 (v1.0 migration closure). Stages 1-4 are all complete. Pre-release requires passing the §24.6 manual real-account E2E acceptance checklist (`docs/e2e-v1.0-acceptance-checklist.md`). Full spec: `docs/InkMigrate_Product_and_Technical_Requirements_v1.4_zh-CN.md`.

## Requirements

- Node.js ≥ 24
- pnpm ≥ 11
- On macOS / Linux: Xcode Command Line Tools (required for `better-sqlite3` native build)
- On Windows: Visual Studio Build Tools

## Quickstart

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
pnpm -r run build
pnpm inkmigrate --help
```

See `README.zh-CN.md` for the canonical (Chinese) README.

## License

See `LICENSE`.
