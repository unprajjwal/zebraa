# Zebraa — AI-Assisted Database Explorer

Desktop-first, AI-assisted database viewer/explorer. Connect to Postgres, MySQL, MariaDB, MSSQL, MongoDB, Redis, SQLite, or ClickHouse, browse schema, run queries, get AI-powered insights.

## Architecture

1. **Tauri 2 / Rust backend (`crates/`)** — Pure Rust implementation of database adapters (`crates/core`) and desktop app shell (`crates/app`), with OS keyring storage and SQLite metastore.
2. **React UI (`apps/desktop/src/renderer`, `packages/ui`)** — React + Vite UI, communicates with the Rust backend via a typed IPC interface.
3. **`packages/core`** — Pure TypeScript database adapter library preserved for potential future Node/webapp reuse.

Credentials encrypted via OS keychain (keyring-rs / Stronghold fallback); connection configs stored in SQLite metastore (`crates/app/migrations/001-init.sql`).

## Prerequisites

- **Node.js** 22 LTS or later
- **pnpm** v8 or later (install via `npm install -g pnpm`)
- **Rust** (stable toolchain) + Cargo
- **Docker** (for local Postgres dev database)

## Getting Started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start local Postgres (optional, for testing)

```bash
docker-compose up -d
```

This starts a Postgres 16 instance on `localhost:5432`, user `postgres`, password `postgres`, database `zebraa` with sample tables.

### 3. Build packages

```bash
pnpm build
```

### 4. Run dev app (Tauri + React)

```bash
pnpm dev
```

This starts the Vite dev server and launches the Tauri desktop application.

## Project Structure

```
zebraa/
├── apps/desktop/              # React frontend (Vite)
│   ├── src/
│   │   └── renderer/          # React app UI & IPC bridge
│   └── vite.config.ts
├── packages/
│   ├── core/                  # DB adapter library (TypeScript)
│   ├── ui/                    # Shared React components (reserved)
│   └── ai/                    # AI client stub (reserved)
├── crates/                    # Rust workspace (Tauri backend)
│   ├── core/                  # zebraa-core: DbAdapter trait + all 8 adapters (Rust)
│   └── app/                   # zebraa-app: Tauri 2 shell, commands, metastore, keyring
├── docker-compose.yml         # Dev Postgres
├── pnpm-workspace.yaml
├── Cargo.toml                 # Rust workspace root
└── README.md
```

## Development Guide

### Adding a New Database Adapter

1. Implement `DbAdapter` trait in `crates/core/src/`
2. Update `crates/core/src/adapter.rs` factory function
3. If TypeScript adapter reuse is needed for web, add to `packages/core/src/`

### IPC Surface

React renderer calls IPC methods which map to Tauri commands:

**Connections:**
- `window.ipc.connections.list()` — fetch all saved connections
- `window.ipc.connections.test(config)` — test a connection (temp, no save)
- `window.ipc.connections.create(config)` — save a connection (password encrypted in OS keychain)
- `window.ipc.connections.update(id, config)` — update connection
- `window.ipc.connections.delete(id)` — delete connection

**Schema:**
- `window.ipc.schema.get(connectionId)` — fetch schema for connection

**Query:**
- `window.ipc.query.execute(connectionId, sql, opts)` — run query
- `window.ipc.query.explain(connectionId, sql)` — explain plan

### Migrations

SQLite metastore migrations live in `crates/app/migrations/` as numbered `.sql` files (e.g., `001-init.sql`). Migrations are auto-applied on app startup by the Rust backend.

### Testing

```bash
pnpm test               # Run Vitest UI/frontend tests
cargo test --workspace # Run Rust core & app tests
```

## License

Proprietary (Zebraa)

