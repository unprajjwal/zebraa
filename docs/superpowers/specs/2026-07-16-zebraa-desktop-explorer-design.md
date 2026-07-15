# Zebraa Desktop DB Explorer — Initial Scaffold Design

**Date:** 2026-07-16  
**Scope:** Monorepo structure, Electron shell, DBAdapter interface, basic Postgres adapter, connection CRUD with encrypted credential storage, schema browser, and AI panel placeholder.  
**Deliverable:** User can add a Postgres connection, test it, save it, and browse its schema (tables + columns).

---

## Architecture

### Monorepo (pnpm workspaces, Node 22)

```
zebraa/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/              # Electron main (Node process)
│       │   │   ├── index.ts       # Entry point, window creation, IPC handlers
│       │   │   ├── ipc.ts         # IPC handler implementations
│       │   │   ├── db.ts          # better-sqlite3 instance + helpers
│       │   │   ├── migrations/    # Numbered .sql files (001-init.sql, etc.)
│       │   │   └── adapters/      # Postgres adapter instantiation
│       │   ├── preload/
│       │   │   └── index.ts       # contextBridge: typed IPC surface
│       │   └── renderer/          # React app
│       │       ├── App.tsx        # Main layout: sidebar / center / right panel
│       │       ├── components/    # Sidebar, schema browser, AI panel placeholder
│       │       └── styles/        # Tailwind config
│       ├── electron-builder.yml   # Build config
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── db-adapter.ts      # Interface definition
│   │   │   ├── postgres-adapter.ts # pg-based implementation
│   │   │   ├── registry.ts        # Factory + type mapping
│   │   │   └── types/             # Shared types (RowSet, SchemaInfo, etc.)
│   │   ├── package.json           # pg, typescript, zero Electron/React deps
│   │   └── tsconfig.json
│   ├── ui/
│   │   ├── src/components/        # Shared React components (placeholder)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── ai/
│       ├── src/
│       │   └── ai-client.ts       # Stub interface + not-implemented errors
│       ├── package.json           # Zero deps (Anthropic SDK added later)
│       └── tsconfig.json
├── pnpm-workspace.yaml
├── package.json                    # Root workspace config
├── docker-compose.yml              # Dev Postgres (version 16)
├── .env.example
├── .gitignore
└── README.md
```

### Why Electron over Tauri

`packages/core`'s Postgres adapter uses the `pg` driver, which needs raw TCP socket access — only available in a Node process. Tauri's webview environment (sandboxed browser context) has no socket APIs; a workaround would require bundling a Node sidecar process and IPC plumbing.

**Electron's main process is Node,** so `packages/core` runs there natively without friction. This also means `packages/core` is directly reusable by a future Next.js webapp (same Node environment, same adapter code, just a different host app). The tradeoff: Electron's binary is larger than Tauri's (~150MB vs ~50MB), but the architectural simplicity is worth it for a DB-centric app.

---

## Data Model & Credential Storage

### SQLite Schema (better-sqlite3, main process only)

**Migrations** in `apps/desktop/src/main/migrations/`:
- `001-init.sql`: Create `connections`, `schema_cache`, `saved_queries`, `chat_history` tables
- Future migrations numbered sequentially

**`connections` table:**
```sql
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'postgres', 'mysql' (enum-like)
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_encrypted BLOB NOT NULL,  -- Electron.safeStorage.encryptString(password) blob
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Credential storage:** passwords are encrypted via `Electron.safeStorage.encryptString()` (OS keychain-backed, built-in, zero extra dependencies) and stored as BLOB in SQLite. On retrieval, `safeStorage.decryptString(blob)` recovers the plaintext in memory only. Never stored plaintext, never sent over the network in this phase.

**Schema cache, saved queries, chat history tables:** created in `001-init.sql` but empty/unused until those features are implemented (reserve the schema, avoid migration churn).

---

## DBAdapter Interface & Postgres Adapter

### `packages/core/src/db-adapter.ts`

```typescript
export interface SchemaInfo {
  tables: TableInfo[];
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKeys?: string[];
  foreignKeys?: ForeignKeyInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
}

export interface ForeignKeyInfo {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface RowSet {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface QueryOptions {
  timeoutMs?: number;   // Defaults to 10000 (10s)
  rowLimit?: number;    // Defaults to 1000
}

export interface TableStats {
  estimatedRows: number;
  sizeBytes: number;
}

export interface DBAdapter {
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  getSchema(): Promise<SchemaInfo>;
  getSampleRows(table: string, limit?: number): Promise<RowSet>;
  executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet>;
  explainQuery(sql: string): Promise<string>;
  getTableStats(table: string): Promise<TableStats>;
  close(): Promise<void>;
}
```

### `packages/core/src/postgres-adapter.ts`

Uses `pg` (node-postgres) to connect and query. Enforces:
- **Connection timeout:** 5s (fail fast on bad host/port)
- **Query timeout:** default 10s (configurable via `QueryOptions`), enforced via `statement_timeout` on the connection
- **Row limit:** default 1000, enforced via `LIMIT` clause injection or a JS guard on returned rows
- **Read-only recommendation:** Connection UI encourages a read-only role; adapter does not parse/rewrite SQL (app-level validation only, v1 constraint)

### `packages/core/src/registry.ts`

```typescript
export type AdapterType = 'postgres' | 'mysql';

export function createAdapter(
  type: AdapterType,
  config: ConnectionConfig
): DBAdapter {
  switch (type) {
    case 'postgres': return new PostgresAdapter(config);
    case 'mysql': return new MysqlAdapter(config); // stub for now
    default: throw new Error(`Unknown adapter type: ${type}`);
  }
}
```

Adding a new adapter (e.g., MySQL) requires one new file + one `case` in the registry; no changes to calling code.

---

## Electron IPC Surface

### `apps/desktop/src/preload/index.ts`

Exposes a typed context bridge to the renderer (React):

```typescript
export interface IpcApi {
  connections: {
    list(): Promise<ConnectionDTO[]>;
    create(config: NewConnectionInput): Promise<ConnectionDTO>;
    update(id: string, config: Partial<NewConnectionInput>): Promise<ConnectionDTO>;
    delete(id: string): Promise<void>;
    test(config: NewConnectionInput): Promise<{ ok: boolean; error?: string }>;
  };
  schema: {
    get(connectionId: string): Promise<SchemaInfo>;
  };
  query: {
    execute(connectionId: string, sql: string, opts?: QueryOptions): Promise<RowSet>;
  };
}

contextBridge.exposeInMainWorld('ipc', {
  // ... implementation (delegate to ipcMain handlers)
});
```

React renderer calls `window.ipc.connections.test(formData)` → preload forwards to main process → main constructs a temporary `PgAdapter` → returns result.

---

## Main Process Flow: Test Connection & Save

### Test Connection (no persistence)
1. User fills form: host, port, database, username, password
2. Clicks "Test Connection"
3. Renderer calls `ipc.connections.test(config)`
4. Main process receives IPC event
5. Creates a temporary `PgAdapter` instance with the config
6. Calls `adapter.testConnection()`
7. Returns `{ ok: true }` or `{ ok: false, error: "..." }`
8. Renderer shows success/error in UI
9. Temporary adapter is discarded (no persistence yet)

### Save Connection
1. After successful test, user clicks "Save"
2. Renderer calls `ipc.connections.create(config)`
3. Main process:
   a. Generates a UUID for the connection
   b. Encrypts password via `safeStorage.encryptString(config.password)`
   c. Writes `(id, name, type, host, port, database, username, secret_encrypted)` to SQLite
   d. Returns the saved connection (without password) to renderer
4. Renderer updates sidebar list via `ipc.connections.list()`

---

## Renderer: Layout & Components

### Main Layout (`apps/desktop/src/renderer/App.tsx`)

Three-column layout:
- **Left sidebar (150–200px):** connections list, add/edit/delete buttons, visual indicator (green = connected, gray = untested)
- **Center panel (flex grow):** tabs — "Schema Browser" (default), "Query Editor" (later phase)
  - Schema browser: tree-view or table list showing tables, columns on click
- **Right panel (300px, placeholder):** "AI Assistant — coming soon", stub component

### Key Components
- `ConnectionForm.tsx` — add/edit connection UI (host, port, db, user, password)
- `ConnectionsList.tsx` — sidebar, list + add button
- `SchemaBrowser.tsx` — table/column tree view
- `AIPanel.tsx` — placeholder div

---

## Development Setup

### `.env.example`
```
ANTHROPIC_API_KEY=sk-...
# For local dev only. In production, calls route through a proxy server.
```

### `docker-compose.yml`

Single Postgres 16 service, default user `postgres`, password `postgres`, database `zebraa`.

### `README.md` (at repo root)

Sections:
1. **Architecture overview** — monorepo structure, Electron + Node main + React renderer
2. **Prerequisites** — Node 22, pnpm, Docker (for local Postgres)
3. **Getting started:**
   - `pnpm install`
   - `docker-compose up -d` (starts Postgres)
   - `pnpm dev` (runs Electron dev server)
4. **Project structure** — brief walkthrough of each package
5. **Development guide** — how to add a new adapter, how IPC surface works, migration workflow

---

## Phase 1 Deliverable: Done When

User can:
1. Launch the app
2. Click "Add Connection" in sidebar
3. Fill form (host, port, db, username, password)
4. Click "Test Connection" → see success or error
5. Click "Save" → connection persists in SQLite (password encrypted via safeStorage)
6. See connection listed in sidebar with a status indicator
7. Click connection in sidebar
8. See schema browser in center panel: list of tables
9. Click a table → see columns (name, type, nullable, default)

Query editor, AI panel, and query execution are **not** in scope for phase 1.

---

## Scope Exclusions (Phase 1)

- Query execution and editor (phase 2)
- AI logic and prompts (phase 2+)
- MySQL/other adapters (phase 2)
- Write-query protection (defer, connection setup UI recommends read-only user for now)
- User-configurable timeouts (hard-coded sensible defaults)
- Schema caching strategy (seed schema_cache table, populate manually if needed, auto-cache comes later)
- Chat history (table exists, unused)

---

## Dependencies Added

### `apps/desktop/package.json`
- `electron`
- `vite`, `@vitejs/plugin-react`
- `react`, `react-dom`
- `typescript`
- `better-sqlite3`
- `@zebraa/core` (workspace:*)

### `packages/core/package.json`
- `pg`
- `typescript`

### `packages/ui/package.json`
- `react`, `react-dom`
- `typescript`
- `tailwindcss` (if building shared components; can defer)

### `packages/ai/package.json`
- `typescript` (stub, no Anthropic SDK yet)

---

## Next Steps

After phase 1 completion and user review:
1. **Phase 2:** Query editor, executeQuery, result grid
2. **Phase 3:** AI panel logic, schema summarization, SQL generation
3. **Phase 4:** Add MySQL adapter (one new file + registry entry)
4. **Webapp:** Reuse `packages/core` in a Next.js API route, Supabase/managed DB backend
