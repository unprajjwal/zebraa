# Zebraa — AI-Assisted Database Explorer

Desktop-first, AI-assisted database viewer/explorer. Connect to any relational database (Postgres first), browse schema, run queries, get AI-powered insights.

## Architecture

**Three-layer system:**
1. **`packages/core`** — Pure TypeScript database adapter library (zero Electron/React deps). Implements `DBAdapter` interface. Reusable by Node.js / Next.js apps later.
2. **Electron Main** — Node.js process managing SQLite (connection configs + metadata), database adapters, IPC server.
3. **Renderer** — React + Vite UI, communicates with main via typed IPC bridge.

Credentials encrypted via `Electron.safeStorage` (OS keychain-backed); connection configs stored in SQLite.

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
│   ├── core/                  # DB adapter library
│   │   └── src/
│   │       ├── db-adapter.ts  # Base class
│   │       ├── postgres-adapter.ts  # Postgres implementation
│   │       ├── registry.ts    # Adapter factory
│   │       └── types/         # Shared types
│   ├── ui/                    # Shared React components (reserved)
│   └── ai/                    # AI client stub (reserved)
├── docker-compose.yml         # Dev Postgres
├── pnpm-workspace.yaml
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

## Phase 1 Scope (Current)

✅ Monorepo structure (pnpm workspaces)
✅ Electron shell + React renderer
✅ SQLite connection storage (credentials encrypted)
✅ Connection CRUD (add/edit/delete/test)
✅ Schema browser (tables + columns)
✅ Postgres adapter (pg driver)
✅ IPC bridge (typed, secure)

## Future Phases

**Phase 2:** Query editor, executeQuery, result grid
**Phase 3:** AI panel (summarization, SQL generation, result analysis)
**Phase 4:** MySQL adapter, user-configurable query timeout/row limits
**Webapp:** Reuse packages/core in Next.js API routes + Supabase backend

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
