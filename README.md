# Zebraa — AI-Assisted Database Explorer

Desktop-first, AI-assisted database viewer/explorer. Connect to Postgres, MySQL, MariaDB, MSSQL, MongoDB, Redis, SQLite, or ClickHouse, browse schema, run queries, get AI-powered insights.

## Architecture

The app has two coexisting backends behind the same React UI while it migrates off Electron:

**Electron backend (current default, `apps/desktop/`):**
1. **`packages/core`** — Pure TypeScript database adapter library (zero Electron/React deps), implementing the `DBAdapter` interface for all 8 supported databases.
2. **Electron Main** — Node.js process managing SQLite (connection configs + metadata), database adapters, IPC server.
3. **Renderer** — React + Vite UI, communicates with main via a typed `window.ipc.*` bridge.

Credentials encrypted via `Electron.safeStorage` (OS keychain-backed); connection configs stored in SQLite.

**Tauri/Rust backend (in progress, `crates/`):** a pure-Rust reimplementation of the same adapters and IPC surface — no Node.js child process or sidecar — that the same React UI can run against unchanged. See [Tauri / Rust backend](#tauri--rust-backend) below for status and how to run it. It does not yet replace the Electron backend; both currently ship side by side.

## Prerequisites

- **Node.js** 22 LTS or later
- **pnpm** v8 or later (install via `npm install -g pnpm`)
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

### 4. Run dev server + Electron

```bash
pnpm dev
```

This starts the Vite dev server (renderer) and launches Electron.

## Project Structure

```
zebraa/
├── apps/desktop/              # Electron app shell
│   ├── src/
│   │   ├── main/              # Electron main process (Node)
│   │   │   ├── index.ts       # App entry, window creation
│   │   │   ├── ipc.ts         # IPC handlers (connections, schema, query)
│   │   │   ├── db.ts          # SQLite setup, migration runner, connection CRUD
│   │   │   ├── adapters/      # (reserved for adapter caching)
│   │   │   └── migrations/    # SQL migration files
│   │   ├── preload/           # contextBridge (IPC types)
│   │   └── renderer/          # React app (Vite)
│   └── vite.config.ts, electron-builder.yml, etc.
├── packages/
│   ├── core/                  # DB adapter library (TypeScript, Electron backend)
│   │   └── src/
│   │       ├── db-adapter.ts        # Base class
│   │       ├── postgres-adapter.ts  # + mysql/mariadb/mssql/mongodb/redis/sqlite/clickhouse
│   │       ├── registry.ts          # Adapter factory
│   │       ├── validation.ts        # Connection config validation
│   │       └── types/                # Shared types
│   ├── ui/                    # Shared React components (reserved)
│   └── ai/                    # AI client stub (reserved)
├── crates/                    # Rust workspace (Tauri backend, in progress)
│   ├── core/                  # zebraa-core: DbAdapter trait + all 8 adapters (Rust)
│   └── app/                   # zebraa-app: Tauri 2 shell, commands, metastore, keyring
├── docker-compose.yml         # Dev Postgres
├── pnpm-workspace.yaml
├── Cargo.toml                 # Rust workspace root
└── README.md
```

## Development Guide

### Adding a New Database Adapter (e.g., MySQL)

1. Create `packages/core/src/mysql-adapter.ts` implementing `DBAdapter` interface
2. Update `packages/core/src/registry.ts`: add case for 'mysql'
3. Update `packages/core/src/types/index.ts`: add 'mysql' to `AdapterType` union
4. No caller code changes needed

### IPC Surface

React renderer calls `window.ipc.*` methods, which delegate to Electron main via IPC:

**Connections:**
- `window.ipc.connections.list()` — fetch all saved connections
- `window.ipc.connections.test(config)` — test a connection (temp, no save)
- `window.ipc.connections.create(config)` — save a connection (password encrypted)
- `window.ipc.connections.update(id, config)` — update connection
- `window.ipc.connections.delete(id)` — delete connection

**Schema:**
- `window.ipc.schema.get(connectionId)` — fetch schema for connection

**Query (phase 2):**
- `window.ipc.query.execute(connectionId, sql, opts)` — run query

### Migrations

SQLite migrations live in `apps/desktop/src/main/migrations/` as numbered `.sql` files (e.g., `001-init.sql`). Migrations are auto-applied on app startup.

To add a new migration:
1. Create `apps/desktop/src/main/migrations/002-your-migration.sql`
2. Restart the app (migrations auto-run)

### Building for Release

```bash
pnpm build
pnpm run -r --filter='./apps/desktop' electron-builder
```

## Current Status

✅ Monorepo structure (pnpm workspaces)
✅ Electron shell + React renderer
✅ SQLite connection storage (credentials encrypted)
✅ Connection CRUD (add/edit/delete/test)
✅ Schema browser (tables + columns)
✅ Adapters: Postgres, MySQL, MariaDB, MSSQL, MongoDB, Redis, SQLite, ClickHouse
✅ IPC bridge (typed, secure)
🚧 Tauri/Rust backend (`crates/`) — full adapter + IPC parity implemented, packaging/CI in progress (see below)

## Future Phases

**Query editor & AI panel:** result grid wired to `query.execute`, AI-powered summarization/SQL generation/result analysis
**Webapp:** reuse `packages/core` in Next.js API routes + Supabase backend
**Tauri cutover:** once the Rust backend is verified across all three OSes in CI, retire the Electron backend

## Tauri / Rust backend (`crates/`)

A parallel, in-progress port of the Electron backend to pure Rust + Tauri 2 — no Node.js child process or sidecar. The React UI in `apps/desktop/src/renderer` is unchanged; only the IPC transport differs (`window.ipc.*` backed by Tauri's `invoke()` via `apps/desktop/src/renderer/ipc-tauri.ts` instead of Electron's `ipcRenderer`).

**Status:** all 8 database adapters and the full 10-command IPC surface are implemented in Rust (`crates/core`, `crates/app`), including the Mongo/Redis SQL-translation logic ported from the TypeScript adapters. Linux keychain fallback (`tauri-plugin-stronghold`, for hosts without a Secret Service daemon) is wired in. Packaging targets (`dmg`/`app`, `nsis`, `appimage`/`deb`) are configured; cross-platform CI (`.github/workflows/tauri-build.yml`) builds all three OSes on push. This backend is not yet the default — the Electron app keeps working unmodified alongside it during the migration.

### Prerequisites

- Rust (stable toolchain) + Cargo
- Tauri CLI: `cargo install tauri-cli --version "^2.0.0"`
- Same Node/pnpm prerequisites as above (the frontend build is still Vite/React)

### Running the Tauri app

```bash
pnpm install && pnpm build   # build the shared frontend first
cargo tauri dev --manifest-path crates/app/Cargo.toml
```

Or run the pre-built binary directly after `cargo build --workspace`:

```bash
./target/debug/zebraa-app
```

### Rust workspace layout

```
crates/
├── core/                 # zebraa-core: adapter trait + all 8 DB adapters
│   └── src/
│       ├── adapter.rs     # DbAdapter async trait + create_adapter() factory
│       ├── config.rs      # serde wire types shared with the TS frontend
│       ├── validation.rs  # connection config validation (ported from validation.ts)
│       └── {postgres,mysql,mariadb,mssql,mongodb,redis,sqlite,clickhouse}.rs
└── app/                   # zebraa-app: Tauri 2 shell
    └── src/
        ├── main.rs         # app entry, window/menu setup
        ├── commands.rs     # #[tauri::command] handlers (mirrors apps/desktop/src/main/ipc.ts)
        ├── state.rs        # AppState: adapter cache + metastore connection
        ├── metastore.rs    # rusqlite metadata store (ports db.ts + 001-init.sql)
        └── crypto.rs       # keyring-rs credential storage, Stronghold fallback on Linux
```

### Testing

```bash
cargo test --workspace
```

Adapter test suites are ported 1:1 from `packages/core/src/__tests__/*.test.ts` where they don't require a live database connection; live-DB cases are marked `#[ignore]` with a comment explaining why.

## Configuration

### Environment Variables

Create a `.env` file (or copy from `.env.example`):

```
ANTHROPIC_API_KEY=sk-...
```

This is dev-only; in production, API calls will route through a proxy server.

## Troubleshooting

**"Database not initialized"**
- Ensure `initializeDatabase()` is called in Electron main before IPC handlers are set up

**"Connection refused" when testing**
- Check host, port, database name, username, password
- If using Docker Postgres: run `docker-compose up -d`

**"Migration X already applied"**
- Migrations track themselves in SQLite; they're idempotent

## License

Proprietary (Zebraa)
