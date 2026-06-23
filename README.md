# InkMigrate

Local-first, verifiable, resumable, auditable knowledge-migration toolkit. Pluggable source/target adapters move content from various knowledge platforms into long-term-controllable open files.

> **Data safety**: All data processing, databases, attachments and auth state stay on the user's machine. Telemetry is off by default; no external AI APIs. Users may only migrate data they are authorized to access and must comply with source platforms' ToS and applicable law.

## Status

Currently at v1.1 stage 5 (indexes + enhanced diagnostics). v1.0 stages 1-4 are complete (v1.0-rc1). Stage 5 delivers Obsidian sharded indexes, page selector diagnostics, sanitized HTML/screenshots, disk space estimation and backup warnings. Stage 6 (source cleanup) is a separate follow-up. Full spec: `docs/InkMigrate_Product_and_Technical_Requirements_v1.4_zh-CN.md`.

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
