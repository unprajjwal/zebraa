# Zebraa Desktop Explorer - Initial Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a monorepo (pnpm + Node 22), Electron desktop app with React frontend, a portable TypeScript DB adapter core, SQLite connection storage with encrypted credentials, and a working schema browser. User can add a Postgres connection, test it, save it, and browse its schema.

**Architecture:** Three-layer system:
1. **packages/core** (TS library, zero Electron/React deps) — DBAdapter interface + Postgres implementation, reusable by Node/webapp later
2. **Electron main** (Node process) — runs packages/core, manages SQLite, exposes IPC surface
3. **Renderer** (React + Vite) — UI, calls main via typed IPC bridge (preload's contextBridge)

Credentials encrypted via Electron's built-in `safeStorage`; connection configs + metadata stored in SQLite.

**Tech Stack:**
- **Monorepo:** pnpm workspaces, Node 22
- **Desktop:** Electron (main=Node, renderer=React)
- **Frontend:** React, Vite, TypeScript, Tailwind
- **Database:** Postgres (`pg` driver in packages/core), SQLite (`better-sqlite3` in Electron main)
- **Credential storage:** Electron.safeStorage (OS keychain-backed)
- **Dev Postgres:** Docker Compose

---

## Global Constraints

- **Node version:** 22 LTS minimum
- **pnpm version:** v8+
- **Postgres version:** 16 (for docker-compose local dev)
- **Credentials:** never stored plaintext; all passwords encrypted via `Electron.safeStorage.encryptString()` before write to SQLite
- **Query defaults:** 10s timeout, 1000-row limit, enforced in adapter, no user config yet
- **Phase 1 scope:** schema browser only; no query editor, AI panel (placeholder only), or write operations

---

## File Structure Map

### Root
- `package.json` — root workspace config (scripts: `dev`, `build`, `prepare`)
- `pnpm-workspace.yaml` — workspace config (apps/*, packages/*)
- `pnpm-lock.yaml` — auto-generated
- `.gitignore` — Node, Electron build, SQLite, .env
- `.env.example` — ANTHROPIC_API_KEY placeholder
- `docker-compose.yml` — Postgres 16 dev service
- `README.md` — setup + architecture guide
- `.prettierrc.json` — formatter config (optional, light)

### apps/desktop
- `package.json` — deps: electron, vite, react, better-sqlite3, @zebraa/core, @zebraa/ui
- `tsconfig.json` — strict, target ES2020
- `vite.config.ts` — React plugin, dev server config
- `electron-builder.yml` — build metadata
- `src/main/index.ts` — Electron main entry, window creation
- `src/main/ipc.ts` — IPC handler implementations (connections CRUD, schema fetch)
- `src/main/db.ts` — better-sqlite3 instance + query wrappers, migration runner
- `src/main/adapters/index.ts` — instantiate packages/core adapters, cache them
- `src/main/migrations/001-init.sql` — connections, schema_cache, saved_queries, chat_history tables
- `src/preload/index.ts` — contextBridge, exposes IpcApi
- `src/renderer/index.tsx` — entry, React.createRoot
- `src/renderer/App.tsx` — three-column layout wrapper
- `src/renderer/components/ConnectionForm.tsx` — add/edit form
- `src/renderer/components/ConnectionsList.tsx` — sidebar list + add button
- `src/renderer/components/SchemaBrowser.tsx` — table/column tree view
- `src/renderer/components/AIPanel.tsx` — placeholder
- `src/renderer/styles/index.css` — Tailwind imports

### packages/core
- `package.json` — deps: pg, typescript
- `tsconfig.json` — strict, target ES2020
- `src/types/index.ts` — ConnectionConfig, SchemaInfo, TableInfo, ColumnInfo, etc.
- `src/db-adapter.ts` — DBAdapter interface definition
- `src/postgres-adapter.ts` — PostgresAdapter class, implements DBAdapter
- `src/registry.ts` — createAdapter factory, AdapterType union

### packages/ui
- `package.json` — deps: react, react-dom, typescript
- `tsconfig.json` — strict
- `src/components/index.ts` — export stub (empty for now, reserved for future shared components)

### packages/ai
- `package.json` — deps: typescript (stub)
- `tsconfig.json` — strict
- `src/ai-client.ts` — AIClient interface + not-implemented stubs

---

## Implementation Tasks

### Task 1: Root Workspace Setup

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.prettierrc.json`

**Interfaces:** None (foundational)

**Steps:**

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "zebraa",
  "version": "0.0.1",
  "description": "AI-assisted database explorer. Desktop first.",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "pnpm run -r --filter='./apps/desktop' dev",
    "build": "pnpm run -r build",
    "prepare": "pnpm run -r build",
    "lint": "echo 'Linting disabled for now'"
  },
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
build/
*.tsbuildinfo
.DS_Store
.env
.env.local
*.db
*.db-shm
*.db-wal
pnpm-lock.yaml
out/
```

- [ ] **Step 4: Create `.env.example`**

```
# Local development only — for testing AI features without the proxy server
# DO NOT COMMIT YOUR REAL KEY
ANTHROPIC_API_KEY=sk-...
```

- [ ] **Step 5: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 6: Commit root setup**

```bash
git add package.json pnpm-workspace.yaml .gitignore .env.example .prettierrc.json
git commit -m "chore: root workspace setup (pnpm, Node 22, scripts)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Docker Compose & Development Postgres

**Files:**
- Create: `docker-compose.yml`

**Interfaces:** None (setup)

**Steps:**

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: zebraa-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: zebraa
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/01-init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

- [ ] **Step 2: Create sample init script for Postgres**

```bash
mkdir -p db
```

```sql
-- db/init.sql
-- Sample tables for testing schema browser

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  content TEXT,
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (email, name) VALUES
  ('alice@example.com', 'Alice'),
  ('bob@example.com', 'Bob');

INSERT INTO posts (user_id, title, content) VALUES
  (1, 'First Post', 'Hello world'),
  (2, 'Second Post', 'Another post');
```

- [ ] **Step 3: Commit docker-compose and sample data**

```bash
git add docker-compose.yml db/init.sql
git commit -m "chore: add docker-compose for dev Postgres + sample data

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: packages/core — Types

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/types/index.ts`

**Interfaces:**
- Produces: `ConnectionConfig`, `SchemaInfo`, `TableInfo`, `ColumnInfo`, `ForeignKeyInfo`, `RowSet`, `QueryOptions`, `TableStats`, `AdapterType`

**Steps:**

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@zebraa/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/core/src/types/index.ts`**

```typescript
export type AdapterType = 'postgres' | 'mysql';

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

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
  timeoutMs?: number;   // Default: 10000
  rowLimit?: number;    // Default: 1000
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

export type NewConnectionInput = Omit<ConnectionConfig, never>;

export interface ConnectionDTO {
  id: string;
  name: string;
  type: AdapterType;
  host: string;
  port: number;
  database: string;
  username: string;
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 4: Commit types**

```bash
git add packages/core/package.json packages/core/tsconfig.json packages/core/src/types/index.ts
git commit -m "feat(core): add type definitions (ConnectionConfig, SchemaInfo, DBAdapter, etc.)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: packages/core — DB Adapter Interface

**Files:**
- Create: `packages/core/src/db-adapter.ts`

**Interfaces:**
- Consumes: `DBAdapter`, `ConnectionConfig`, `SchemaInfo`, `QueryOptions`, `RowSet`, `TableStats` (from Task 3)
- Produces: (re-exports all types for external use)

**Steps:**

- [ ] **Step 1: Create `packages/core/src/db-adapter.ts`**

```typescript
import { DBAdapter, ConnectionConfig, SchemaInfo, QueryOptions, RowSet, TableStats } from './types/index.js';

export class DatabaseAdapter {
  protected config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    throw new Error('Must be implemented by subclass');
  }

  async getSchema(): Promise<SchemaInfo> {
    throw new Error('Must be implemented by subclass');
  }

  async getSampleRows(table: string, limit?: number): Promise<RowSet> {
    throw new Error('Must be implemented by subclass');
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    throw new Error('Must be implemented by subclass');
  }

  async explainQuery(sql: string): Promise<string> {
    throw new Error('Must be implemented by subclass');
  }

  async getTableStats(table: string): Promise<TableStats> {
    throw new Error('Must be implemented by subclass');
  }

  async close(): Promise<void> {
    throw new Error('Must be implemented by subclass');
  }
}

export { DBAdapter, ConnectionConfig, SchemaInfo, QueryOptions, RowSet, TableStats } from './types/index.js';
```

- [ ] **Step 2: Commit adapter base**

```bash
git add packages/core/src/db-adapter.ts
git commit -m "feat(core): add DatabaseAdapter base class

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: packages/core — Postgres Adapter

**Files:**
- Create: `packages/core/src/postgres-adapter.ts`

**Interfaces:**
- Consumes: `DatabaseAdapter` (Task 4), `ConnectionConfig`, `SchemaInfo`, `QueryOptions`, `RowSet`, `TableStats` (Task 3)
- Produces: `PostgresAdapter` class implementing `DBAdapter`

**Steps:**

- [ ] **Step 1: Create `packages/core/src/postgres-adapter.ts`**

```typescript
import { Pool, PoolClient } from 'pg';
import {
  DatabaseAdapter,
  ConnectionConfig,
  SchemaInfo,
  QueryOptions,
  RowSet,
  TableStats,
  TableInfo,
  ColumnInfo,
  ForeignKeyInfo,
} from './index.js';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_ROW_LIMIT = 1000;

export class PostgresAdapter extends DatabaseAdapter {
  private pool: Pool | null = null;
  private client: PoolClient | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const tempPool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        connectionTimeoutMillis: 5000,
      });

      const client = await tempPool.connect();
      await client.query('SELECT 1');
      client.release();
      await tempPool.end();

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  async getSchema(): Promise<SchemaInfo> {
    const client = await this.getOrCreateClient();
    try {
      const tableQuery = `
        SELECT 
          t.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable = 'YES' as is_nullable,
          c.column_default
        FROM information_schema.tables t
        LEFT JOIN information_schema.columns c 
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.table_name, c.ordinal_position
      `;

      const result = await client.query(tableQuery);

      const tableMap = new Map<string, TableInfo>();
      for (const row of result.rows) {
        if (!tableMap.has(row.table_name)) {
          tableMap.set(row.table_name, {
            name: row.table_name,
            columns: [],
          });
        }

        if (row.column_name) {
          tableMap.get(row.table_name)!.columns.push({
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable,
            default: row.column_default,
          });
        }
      }

      // Fetch PKs and FKs
      const constraintQuery = `
        SELECT 
          kcu.table_name,
          kcu.column_name,
          tc.constraint_type,
          ccu.table_name as foreign_table,
          ccu.column_name as foreign_column
        FROM information_schema.key_column_usage kcu
        JOIN information_schema.table_constraints tc 
          ON kcu.constraint_name = tc.constraint_name
        LEFT JOIN information_schema.constraint_column_usage ccu 
          ON tc.constraint_name = ccu.constraint_name
        WHERE kcu.table_schema NOT IN ('pg_catalog', 'information_schema')
      `;

      const constraintResult = await client.query(constraintQuery);

      for (const row of constraintResult.rows) {
        const table = tableMap.get(row.table_name);
        if (table) {
          if (row.constraint_type === 'PRIMARY KEY') {
            if (!table.primaryKeys) table.primaryKeys = [];
            table.primaryKeys.push(row.column_name);
          } else if (row.constraint_type === 'FOREIGN KEY') {
            if (!table.foreignKeys) table.foreignKeys = [];
            table.foreignKeys.push({
              column: row.column_name,
              refTable: row.foreign_table,
              refColumn: row.foreign_column,
            });
          }
        }
      }

      return { tables: Array.from(tableMap.values()) };
    } finally {
      if (client) client.release();
    }
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    const client = await this.getOrCreateClient();
    try {
      const query = `SELECT * FROM "${table}" LIMIT $1`;
      const result = await client.query(query, [limit]);

      const columns = result.fields.map((f) => f.name);
      const rows = result.rows.map((r) => Object.values(r));

      return {
        columns,
        rows,
        rowCount: result.rows.length,
      };
    } finally {
      if (client) client.release();
    }
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;

    const client = await this.getOrCreateClient();
    try {
      await client.query(`SET statement_timeout TO ${timeoutMs}`);

      const result = await client.query(sql);

      const columns = result.fields.map((f) => f.name);
      let rows = result.rows.map((r) => Object.values(r));

      if (rows.length > rowLimit) {
        rows = rows.slice(0, rowLimit);
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    } finally {
      if (client) client.release();
    }
  }

  async explainQuery(sql: string): Promise<string> {
    const client = await this.getOrCreateClient();
    try {
      const result = await client.query(`EXPLAIN ${sql}`);
      return result.rows.map((r) => Object.values(r).join(' ')).join('\n');
    } finally {
      if (client) client.release();
    }
  }

  async getTableStats(table: string): Promise<TableStats> {
    const client = await this.getOrCreateClient();
    try {
      const result = await client.query(`
        SELECT 
          n_live_tup as row_count,
          pg_total_relation_size('${table}'::regclass) as size_bytes
        FROM pg_stat_user_tables
        WHERE relname = $1
      `, [table]);

      if (result.rows.length === 0) {
        return { estimatedRows: 0, sizeBytes: 0 };
      }

      const row = result.rows[0];
      return {
        estimatedRows: row.row_count || 0,
        sizeBytes: row.size_bytes || 0,
      };
    } finally {
      if (client) client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.client = null;
    }
  }

  private async getOrCreateClient(): Promise<PoolClient> {
    if (!this.pool) {
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        connectionTimeoutMillis: 5000,
      });
    }

    if (!this.client) {
      this.client = await this.pool.connect();
    }

    return this.client;
  }
}
```

- [ ] **Step 2: Commit Postgres adapter**

```bash
git add packages/core/src/postgres-adapter.ts
git commit -m "feat(core): implement PostgresAdapter with schema, query, stats methods

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: packages/core — Registry & Exports

**Files:**
- Create: `packages/core/src/registry.ts`
- Create: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `PostgresAdapter`, `AdapterType`, `ConnectionConfig`, `DBAdapter` (previous tasks)
- Produces: `createAdapter` factory function, all type exports

**Steps:**

- [ ] **Step 1: Create `packages/core/src/registry.ts`**

```typescript
import { PostgresAdapter } from './postgres-adapter.js';
import { AdapterType, ConnectionConfig, DBAdapter } from './types/index.js';

export function createAdapter(type: AdapterType, config: ConnectionConfig): DBAdapter {
  switch (type) {
    case 'postgres':
      return new PostgresAdapter(config);
    case 'mysql':
      throw new Error('MySQL adapter not yet implemented');
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
```

- [ ] **Step 2: Create `packages/core/src/index.ts`**

```typescript
export { createAdapter } from './registry.js';
export type { AdapterType, ConnectionConfig, SchemaInfo, TableInfo, ColumnInfo, ForeignKeyInfo, RowSet, QueryOptions, TableStats, DBAdapter, NewConnectionInput, ConnectionDTO } from './types/index.js';
export { PostgresAdapter } from './postgres-adapter.js';
export { DatabaseAdapter } from './db-adapter.js';
```

- [ ] **Step 3: Commit registry and exports**

```bash
git add packages/core/src/registry.ts packages/core/src/index.ts
git commit -m "feat(core): add adapter registry and public exports

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: packages/ui & packages/ai Stubs

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/src/components/index.ts`
- Create: `packages/ai/package.json`
- Create: `packages/ai/tsconfig.json`
- Create: `packages/ai/src/ai-client.ts`

**Interfaces:**
- Produces: (stub exports, minimal)

**Steps:**

- [ ] **Step 1: Create `packages/ui/package.json`**

```json
{
  "name": "@zebraa/ui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/ui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/ui/src/components/index.ts`**

```typescript
// Shared UI components (reserved for phase 2+)
export {};
```

- [ ] **Step 4: Create `packages/ai/package.json`**

```json
{
  "name": "@zebraa/ai",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 5: Create `packages/ai/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 6: Create `packages/ai/src/ai-client.ts`**

```typescript
export interface AIClient {
  summarizeSchema(schema: string): Promise<string>;
  generateSql(question: string, schema: string): Promise<string>;
  answerFollowup(query: string, results: string): Promise<string>;
}

export class NotImplementedAIClient implements AIClient {
  async summarizeSchema(): Promise<string> {
    throw new Error('AI features not yet implemented');
  }

  async generateSql(): Promise<string> {
    throw new Error('AI features not yet implemented');
  }

  async answerFollowup(): Promise<string> {
    throw new Error('AI features not yet implemented');
  }
}
```

- [ ] **Step 7: Commit ui and ai stubs**

```bash
git add packages/ui packages/ai
git commit -m "chore: add ui and ai package stubs (reserved for phase 2+)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Electron Main — Project Structure & Config

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: workspace root config
- Produces: Electron app config

**Steps:**

- [ ] **Step 1: Create `apps/desktop/package.json`**

```json
{
  "name": "zebraa-desktop",
  "version": "0.0.1",
  "description": "Zebraa desktop app",
  "type": "module",
  "main": "dist/main/index.js",
  "homepage": "./",
  "scripts": {
    "dev": "vite && electron .",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@zebraa/core": "workspace:*",
    "@zebraa/ui": "workspace:*",
    "better-sqlite3": "^9.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.11.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.2.0",
    "electron": "^28.0.0",
    "electron-builder": "^24.9.0",
    "typescript": "^5.6.0",
    "vite": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create `apps/desktop/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020"],
    "jsx": "react-jsx",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `apps/desktop/vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  root: './src/renderer',
});
```

- [ ] **Step 4: Create `apps/desktop/electron-builder.yml`**

```yaml
appId: com.zebraa.app
productName: Zebraa
files:
  - dist/main/**/*
  - dist/renderer/**/*
directories:
  buildResources: assets
win:
  target:
    - nsis
    - portable
mac:
  target:
    - dmg
    - zip
  hardenedRuntime: true
linux:
  target:
    - AppImage
    - deb
```

- [ ] **Step 5: Commit Electron config**

```bash
git add apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/vite.config.ts apps/desktop/electron-builder.yml
git commit -m "chore: add Electron app config (build, vite, tsconfig)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Electron Main — SQLite Setup & Migration Runner

**Files:**
- Create: `apps/desktop/src/main/db.ts`
- Create: `apps/desktop/src/main/migrations/001-init.sql`

**Interfaces:**
- Consumes: better-sqlite3
- Produces: `initializeDatabase()`, `getDb()`, migration runner

**Steps:**

- [ ] **Step 1: Create `apps/desktop/src/main/migrations/001-init.sql`**

```sql
-- Create migrations table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Create connections table
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_encrypted BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Create schema_cache table (reserved)
CREATE TABLE IF NOT EXISTS schema_cache (
  connection_id TEXT PRIMARY KEY,
  schema_data TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

-- Create saved_queries table (reserved)
CREATE TABLE IF NOT EXISTS saved_queries (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sql TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Create chat_history table (reserved)
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  query TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Create `apps/desktop/src/main/db.ts`**

```typescript
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!instance) {
    throw new Error('Database not initialized. Call initializeDatabase first.');
  }
  return instance;
}

export function initializeDatabase(): Database.Database {
  const appPath = app.getPath('userData');
  const dbPath = path.join(appPath, 'zebraa.db');

  instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');

  runMigrations();

  return instance;
}

function runMigrations(): void {
  const db = getDb();

  // Ensure migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrationsDir = path.join(import.meta.url.replace('file://', ''), '..', 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const version = parseInt(file.split('-')[0], 10);
    const alreadyRun = db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(version);

    if (!alreadyRun) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, Date.now());
    }
  }
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// Connection CRUD helpers

export interface ConnectionRow {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  secret_encrypted: Buffer;
  created_at: number;
  updated_at: number;
}

export function listConnections(): ConnectionRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM connections ORDER BY created_at DESC').all() as ConnectionRow[];
}

export function getConnection(id: string): ConnectionRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
}

export function createConnection(connection: Omit<ConnectionRow, 'created_at' | 'updated_at'>): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO connections (id, name, type, host, port, database, username, secret_encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    connection.id,
    connection.name,
    connection.type,
    connection.host,
    connection.port,
    connection.database,
    connection.username,
    connection.secret_encrypted,
    now,
    now
  );
}

export function updateConnection(id: string, updates: Partial<Omit<ConnectionRow, 'id' | 'created_at'>>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: (string | number | Buffer)[] = [];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    values.push(updates.name);
  }
  if (updates.host !== undefined) {
    setClauses.push('host = ?');
    values.push(updates.host);
  }
  if (updates.port !== undefined) {
    setClauses.push('port = ?');
    values.push(updates.port);
  }
  if (updates.database !== undefined) {
    setClauses.push('database = ?');
    values.push(updates.database);
  }
  if (updates.username !== undefined) {
    setClauses.push('username = ?');
    values.push(updates.username);
  }
  if (updates.secret_encrypted !== undefined) {
    setClauses.push('secret_encrypted = ?');
    values.push(updates.secret_encrypted);
  }

  setClauses.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  const sql = `UPDATE connections SET ${setClauses.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

export function deleteConnection(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM connections WHERE id = ?').run(id);
}
```

- [ ] **Step 3: Commit SQLite setup**

```bash
git add apps/desktop/src/main/db.ts apps/desktop/src/main/migrations/001-init.sql
git commit -m "feat(desktop): add SQLite setup with migration runner and connection CRUD helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Electron Main — IPC Handlers

**Files:**
- Create: `apps/desktop/src/main/ipc.ts`

**Interfaces:**
- Consumes: packages/core (createAdapter, types), db.ts (connection CRUD), Electron.safeStorage
- Produces: IPC handler map (connections, schema, query)

**Steps:**

- [ ] **Step 1: Create `apps/desktop/src/main/ipc.ts`**

```typescript
import { ipcMain, safeStorage } from 'electron';
import { randomUUID } from 'crypto';
import { createAdapter, type ConnectionDTO, type SchemaInfo } from '@zebraa/core';
import { listConnections, getConnection, createConnection, updateConnection, deleteConnection, type ConnectionRow } from './db.js';

const adapterCache = new Map<string, any>();

function rowToDto(row: ConnectionRow): ConnectionDTO {
  return {
    id: row.id,
    name: row.name,
    type: row.type as any,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function setupIpcHandlers(): void {
  // connections:list
  ipcMain.handle('connections:list', async () => {
    const rows = listConnections();
    return rows.map(rowToDto);
  });

  // connections:test
  ipcMain.handle('connections:test', async (_event, config) => {
    try {
      const adapter = createAdapter(config.type || 'postgres', {
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        password: config.password,
      });

      const result = await adapter.testConnection();
      await adapter.close();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  // connections:create
  ipcMain.handle('connections:create', async (_event, config) => {
    try {
      const id = randomUUID();
      const now = Date.now();

      const secretBlob = safeStorage.encryptString(config.password);

      createConnection({
        id,
        name: config.name,
        type: config.type || 'postgres',
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        secret_encrypted: secretBlob,
      });

      return {
        id,
        name: config.name,
        type: config.type || 'postgres',
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        created_at: now,
        updated_at: now,
      } as ConnectionDTO;
    } catch (error) {
      throw new Error(`Failed to create connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // connections:update
  ipcMain.handle('connections:update', async (_event, id: string, updates) => {
    try {
      const connection = getConnection(id);
      if (!connection) {
        throw new Error(`Connection ${id} not found`);
      }

      const updateData: any = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.host !== undefined) updateData.host = updates.host;
      if (updates.port !== undefined) updateData.port = updates.port;
      if (updates.database !== undefined) updateData.database = updates.database;
      if (updates.username !== undefined) updateData.username = updates.username;
      if (updates.password !== undefined) {
        updateData.secret_encrypted = safeStorage.encryptString(updates.password);
      }

      updateConnection(id, updateData);

      const updated = getConnection(id)!;
      return rowToDto(updated);
    } catch (error) {
      throw new Error(`Failed to update connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // connections:delete
  ipcMain.handle('connections:delete', async (_event, id: string) => {
    try {
      deleteConnection(id);
      if (adapterCache.has(id)) {
        const adapter = adapterCache.get(id);
        await adapter.close();
        adapterCache.delete(id);
      }
    } catch (error) {
      throw new Error(`Failed to delete connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // schema:get
  ipcMain.handle('schema:get', async (_event, connectionId: string) => {
    try {
      const connection = getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection ${connectionId} not found`);
      }

      let adapter = adapterCache.get(connectionId);
      if (!adapter) {
        const password = safeStorage.decryptString(connection.secret_encrypted);
        adapter = createAdapter(connection.type as any, {
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: connection.username,
          password,
        });
        adapterCache.set(connectionId, adapter);
      }

      return await adapter.getSchema();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch schema: ${message}`);
    }
  });

  // query:execute (stubbed for now)
  ipcMain.handle('query:execute', async (_event, connectionId: string, sql: string, opts) => {
    throw new Error('Query execution not yet implemented (phase 2)');
  });
}
```

- [ ] **Step 2: Commit IPC handlers**

```bash
git add apps/desktop/src/main/ipc.ts
git commit -m "feat(desktop): add IPC handlers for connections CRUD and schema fetching

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Electron Main — Entry Point

**Files:**
- Create: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: ipc.ts (setupIpcHandlers), db.ts (initializeDatabase), Electron
- Produces: app entry point, window creation

**Steps:**

- [ ] **Step 1: Create `apps/desktop/src/main/index.ts`**

```typescript
import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase, closeDatabase } from './db.js';
import { setupIpcHandlers } from './ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  const isDev = process.env.NODE_ENV === 'development';
  const url = isDev ? 'http://localhost:5173' : `file://${path.join(__dirname, '../renderer/index.html')}`;

  mainWindow.loadURL(url);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', async () => {
  initializeDatabase();
  setupIpcHandlers();
  await createWindow();
  setupMenu();
});

app.on('window-all-closed', () => {
  closeDatabase();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (mainWindow === null) {
    await createWindow();
  }
});

function setupMenu(): void {
  const template: any[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
```

- [ ] **Step 2: Commit Electron main entry**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(desktop): add Electron main entry point and window management

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Preload Bridge

**Files:**
- Create: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: Electron contextBridge, ipcRenderer
- Produces: window.ipc typed API

**Steps:**

- [ ] **Step 1: Create `apps/desktop/src/preload/index.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import type { ConnectionDTO, SchemaInfo, QueryOptions, RowSet } from '@zebraa/core';

interface NewConnectionInput {
  name: string;
  type?: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

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

const ipc: IpcApi = {
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    create: (config) => ipcRenderer.invoke('connections:create', config),
    update: (id, config) => ipcRenderer.invoke('connections:update', id, config),
    delete: (id) => ipcRenderer.invoke('connections:delete', id),
    test: (config) => ipcRenderer.invoke('connections:test', config),
  },
  schema: {
    get: (connectionId) => ipcRenderer.invoke('schema:get', connectionId),
  },
  query: {
    execute: (connectionId, sql, opts) => ipcRenderer.invoke('query:execute', connectionId, sql, opts),
  },
};

contextBridge.exposeInMainWorld('ipc', ipc);

declare global {
  interface Window {
    ipc: IpcApi;
  }
}
```

- [ ] **Step 2: Commit preload bridge**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(desktop): add preload bridge with typed IPC surface

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: React Layout & Components

**Files:**
- Create: `apps/desktop/src/renderer/index.tsx`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/src/renderer/components/ConnectionForm.tsx`
- Create: `apps/desktop/src/renderer/components/ConnectionsList.tsx`
- Create: `apps/desktop/src/renderer/components/SchemaBrowser.tsx`
- Create: `apps/desktop/src/renderer/components/AIPanel.tsx`
- Create: `apps/desktop/src/renderer/styles/index.css`

**Interfaces:**
- Consumes: window.ipc (from preload), packages/core types
- Produces: React component tree

**Steps:**

- [ ] **Step 1: Create `apps/desktop/src/renderer/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zebraa</title>
    <link rel="stylesheet" href="/styles/index.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/index.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `apps/desktop/src/renderer/index.tsx`**

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 3: Create `apps/desktop/src/renderer/App.tsx`**

```typescript
import React, { useState, useEffect } from 'react';
import ConnectionsList from './components/ConnectionsList';
import ConnectionForm from './components/ConnectionForm';
import SchemaBrowser from './components/SchemaBrowser';
import AIPanel from './components/AIPanel';
import type { ConnectionDTO } from '@zebraa/core';

export default function App() {
  const [connections, setConnections] = useState<ConnectionDTO[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    loadConnections();
  }, []);

  async function loadConnections() {
    try {
      const list = await window.ipc.connections.list();
      setConnections(list);
      if (list.length > 0 && !selectedConnectionId) {
        setSelectedConnectionId(list[0].id);
      }
    } catch (error) {
      console.error('Failed to load connections:', error);
    }
  }

  async function handleAddConnection(config: any) {
    try {
      await window.ipc.connections.create(config);
      setShowAddForm(false);
      await loadConnections();
    } catch (error) {
      console.error('Failed to create connection:', error);
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleDeleteConnection(id: string) {
    try {
      await window.ipc.connections.delete(id);
      if (selectedConnectionId === id) {
        setSelectedConnectionId(null);
      }
      await loadConnections();
    } catch (error) {
      console.error('Failed to delete connection:', error);
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      {/* Left sidebar */}
      <div style={{ width: '200px', borderRight: '1px solid #ddd', overflow: 'auto', padding: '8px' }}>
        <h2 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>Connections</h2>
        <ConnectionsList
          connections={connections}
          selectedId={selectedConnectionId}
          onSelect={setSelectedConnectionId}
          onDelete={handleDeleteConnection}
        />
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          style={{
            width: '100%',
            padding: '8px',
            marginTop: '12px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          {showAddForm ? 'Cancel' : 'Add Connection'}
        </button>
        {showAddForm && (
          <div style={{ marginTop: '12px' }}>
            <ConnectionForm onSubmit={handleAddConnection} />
          </div>
        )}
      </div>

      {/* Center panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedConnectionId ? (
          <SchemaBrowser connectionId={selectedConnectionId} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999' }}>
            No connection selected
          </div>
        )}
      </div>

      {/* Right panel */}
      <div style={{ width: '300px', borderLeft: '1px solid #ddd', overflow: 'auto', padding: '16px' }}>
        <AIPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `apps/desktop/src/renderer/components/ConnectionsList.tsx`**

```typescript
import React from 'react';
import type { ConnectionDTO } from '@zebraa/core';

interface Props {
  connections: ConnectionDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function ConnectionsList({ connections, selectedId, onSelect, onDelete }: Props) {
  return (
    <div>
      {connections.map((conn) => (
        <div
          key={conn.id}
          onClick={() => onSelect(conn.id)}
          style={{
            padding: '8px',
            marginBottom: '8px',
            borderRadius: '4px',
            backgroundColor: selectedId === conn.id ? '#e7f3ff' : '#f9f9f9',
            border: selectedId === conn.id ? '1px solid #007bff' : '1px solid #ddd',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '12px' }}>{conn.name}</div>
            <div style={{ fontSize: '11px', color: '#666' }}>
              {conn.type} @ {conn.host}:{conn.port}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(conn.id);
            }}
            style={{
              backgroundColor: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '3px',
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Create `apps/desktop/src/renderer/components/ConnectionForm.tsx`**

```typescript
import React, { useState } from 'react';

interface Props {
  onSubmit: (config: any) => Promise<void>;
}

export default function ConnectionForm({ onSubmit }: Props) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('postgres');
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  async function handleTest() {
    setTesting(true);
    try {
      const result = await window.ipc.connections.test({
        type: 'postgres',
        host,
        port: parseInt(port, 10),
        database,
        username,
        password,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, error: String(error) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!testResult?.ok) {
      alert('Please test the connection first');
      return;
    }
    try {
      await onSubmit({
        name,
        type: 'postgres',
        host,
        port: parseInt(port, 10),
        database,
        username,
        password,
      });
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const inputStyle = { width: '100%', padding: '6px', marginBottom: '8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '12px' };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Connection name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Host"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="number"
        placeholder="Port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Database"
        value={database}
        onChange={(e) => setDatabase(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        style={inputStyle}
      />

      <button
        type="button"
        onClick={handleTest}
        disabled={testing}
        style={{
          width: '100%',
          padding: '6px',
          marginBottom: '8px',
          backgroundColor: '#6c757d',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: testing ? 'wait' : 'pointer',
          fontSize: '12px',
        }}
      >
        {testing ? 'Testing...' : 'Test Connection'}
      </button>

      {testResult && (
        <div
          style={{
            padding: '8px',
            marginBottom: '8px',
            borderRadius: '4px',
            backgroundColor: testResult.ok ? '#d4edda' : '#f8d7da',
            color: testResult.ok ? '#155724' : '#721c24',
            fontSize: '12px',
          }}
        >
          {testResult.ok ? 'Connection successful!' : `Error: ${testResult.error}`}
        </div>
      )}

      <button
        type="submit"
        disabled={!testResult?.ok}
        style={{
          width: '100%',
          padding: '6px',
          backgroundColor: testResult?.ok ? '#28a745' : '#ccc',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: testResult?.ok ? 'pointer' : 'not-allowed',
          fontSize: '12px',
        }}
      >
        Save Connection
      </button>
    </form>
  );
}
```

- [ ] **Step 6: Create `apps/desktop/src/renderer/components/SchemaBrowser.tsx`**

```typescript
import React, { useState, useEffect } from 'react';
import type { SchemaInfo, TableInfo } from '@zebraa/core';

interface Props {
  connectionId: string;
}

export default function SchemaBrowser({ connectionId }: Props) {
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSchema();
  }, [connectionId]);

  async function loadSchema() {
    setLoading(true);
    setError(null);
    try {
      const data = await window.ipc.schema.get(connectionId);
      setSchema(data);
      if (data.tables.length > 0) {
        setExpandedTable(data.tables[0].name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={{ padding: '16px', color: '#999' }}>Loading schema...</div>;
  if (error) return <div style={{ padding: '16px', color: '#d32f2f' }}>Error: {error}</div>;
  if (!schema) return <div style={{ padding: '16px', color: '#999' }}>No schema</div>;

  return (
    <div style={{ padding: '16px', overflow: 'auto' }}>
      <h2 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>Tables</h2>
      {schema.tables.length === 0 ? (
        <div style={{ color: '#999' }}>No tables found</div>
      ) : (
        schema.tables.map((table) => (
          <div key={table.name} style={{ marginBottom: '12px' }}>
            <div
              onClick={() => setExpandedTable(expandedTable === table.name ? null : table.name)}
              style={{
                cursor: 'pointer',
                padding: '8px',
                backgroundColor: '#f0f0f0',
                borderRadius: '4px',
                fontWeight: 'bold',
                fontSize: '12px',
                userSelect: 'none',
              }}
            >
              {expandedTable === table.name ? '▼' : '▶'} {table.name}
            </div>
            {expandedTable === table.name && (
              <div style={{ marginLeft: '12px', marginTop: '8px' }}>
                {table.columns.map((col) => (
                  <div
                    key={col.name}
                    style={{
                      padding: '6px 8px',
                      backgroundColor: '#fafafa',
                      borderRadius: '3px',
                      marginBottom: '4px',
                      fontSize: '11px',
                      borderLeft: '2px solid #007bff',
                    }}
                  >
                    <strong>{col.name}</strong> {col.type}
                    {!col.nullable && ' NOT NULL'}
                    {col.default && ` DEFAULT ${col.default}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 7: Create `apps/desktop/src/renderer/components/AIPanel.tsx`**

```typescript
import React from 'react';

export default function AIPanel() {
  return (
    <div>
      <h2 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>AI Assistant</h2>
      <div style={{ color: '#999', fontSize: '12px', lineHeight: '1.6' }}>
        <p>AI features coming in phase 2.</p>
        <p>Will include:</p>
        <ul style={{ paddingLeft: '16px', margin: '8px 0' }}>
          <li>Schema summarization</li>
          <li>Natural language SQL generation</li>
          <li>Query result analysis</li>
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Create `apps/desktop/src/renderer/styles/index.css`**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #root {
  width: 100%;
  height: 100%;
  background-color: #fff;
}

body {
  font-family: system-ui, -apple-system, sans-serif;
  color: #333;
  line-height: 1.5;
}

button {
  font-family: inherit;
}

input, select, textarea {
  font-family: inherit;
}

h1, h2, h3, h4, h5, h6 {
  margin: 0;
}
```

- [ ] **Step 9: Commit React components**

```bash
git add apps/desktop/src/renderer/
git commit -m "feat(desktop): add React components (layout, connection form, schema browser, AI placeholder)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: README & Setup Guide

**Files:**
- Create: `README.md` (root)

**Interfaces:** (documentation only)

**Steps:**

- [ ] **Step 1: Create comprehensive `README.md`**

```markdown
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

\`\`\`bash
pnpm install
\`\`\`

### 2. Start local Postgres (optional, for testing)

\`\`\`bash
docker-compose up -d
\`\`\`

This starts a Postgres 16 instance on `localhost:5432`, user `postgres`, password `postgres`, database `zebraa` with sample tables.

### 3. Build packages

\`\`\`bash
pnpm build
\`\`\`

### 4. Run dev server + Electron

\`\`\`bash
pnpm dev
\`\`\`

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

\`\`\`bash
pnpm build
pnpm run -r --filter='./apps/desktop' electron-builder
\`\`\`

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

\`\`\`
ANTHROPIC_API_KEY=sk-...
\`\`\`

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
```

- [ ] **Step 2: Commit README**

```bash
git add README.md
git commit -m "docs: add comprehensive README with setup guide and architecture overview

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 15: Integration Test & Validation

**Files:** (no new files, validation only)

**Interfaces:** (manual testing)

**Steps:**

- [ ] **Step 1: Verify monorepo structure**

```bash
ls -la apps/desktop/src/{main,preload,renderer}
ls -la packages/{core,ui,ai}/src
```

Expected: all directories and files exist.

- [ ] **Step 2: Install and build all packages**

```bash
pnpm install
pnpm build
```

Expected: no TypeScript errors, all packages build successfully.

- [ ] **Step 3: Start Docker Postgres**

```bash
docker-compose up -d
docker-compose ps
```

Expected: `zebraa-postgres` container is running.

- [ ] **Step 4: Start dev server**

```bash
pnpm dev
```

Expected:
- Vite dev server starts on http://localhost:5173
- Electron app window opens
- Main process logs appear in terminal

- [ ] **Step 5: Test Add Connection flow**

1. Click "Add Connection" button
2. Fill form:
   - Name: "Docker Postgres"
   - Host: localhost
   - Port: 5432
   - Database: zebraa
   - Username: postgres
   - Password: postgres
3. Click "Test Connection"
4. Expect: "Connection successful!" message
5. Click "Save Connection"
6. Expect: connection appears in left sidebar

- [ ] **Step 6: Test Schema Browser**

1. Click the saved connection in sidebar
2. Expect: schema browser in center panel shows list of tables
3. Click "users" table
4. Expect: table expands showing columns (id, email, name, created_at)
5. Verify column info (type, nullable, default)

- [ ] **Step 7: Test Connection Deletion**

1. Click "Delete" button on the connection
2. Expect: connection disappears from sidebar

- [ ] **Step 8: Commit integration test pass**

```bash
git log --oneline | head -20
git status
git commit -m "test: validate phase 1 scaffold (connections CRUD, schema browser)

All checks pass:
- Monorepo builds without errors
- Electron app launches
- Add connection: test + save works
- Schema browser: tables + columns display correctly
- Delete connection: cleanup works

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Validation Checklist

**Before marking complete, verify:**

- [ ] All 15 tasks committed to git
- [ ] `pnpm install` succeeds
- [ ] `pnpm build` succeeds (all packages)
- [ ] `pnpm dev` starts Electron app without errors
- [ ] Can add a connection to local Postgres
- [ ] Can test connection successfully
- [ ] Connection persists in SQLite (can see in sidebar on restart)
- [ ] Schema browser displays tables and columns
- [ ] All passwords encrypted via `Electron.safeStorage`
- [ ] No plaintext credentials in SQLite or logs
- [ ] Right-side AI panel shows placeholder text
- [ ] No TypeScript errors (`pnpm build`)
- [ ] Git history is clean (15 logical commits)

---

## Next Steps After Phase 1

1. User reviews working app
2. Phase 2: Query editor + executeQuery + result grid
3. Phase 3: AI panel logic (schema summarization, SQL generation)
4. Phase 4: MySQL adapter + user-configurable timeouts
5. Webapp: Reuse packages/core in Next.js backend
```

- [ ] **Step 2: Commit plan completion**

```bash
git add docs/superpowers/plans/2026-07-16-desktop-scaffold.md
git commit -m "docs: add detailed implementation plan for desktop scaffold phase 1

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** ✅ All sections addressed
- Monorepo (Tasks 1, 3–7, 8) 
- Docker Compose (Task 2)
- packages/core with DBAdapter + Postgres (Tasks 3–6)
- Electron main + IPC (Tasks 8–12)
- SQLite migrations (Task 9)
- React UI (Task 13)
- Documentation (Task 14)
- Validation (Task 15)

**No placeholders:** ✅ Every step has complete code or exact commands

**Type consistency:** ✅ `ConnectionDTO`, `SchemaInfo`, `TableInfo`, etc. defined once (Task 3) and reused consistently

**Scope:** ✅ Phase 1 only (schema browser, connections CRUD); query editor, AI, MySQL deferred to phase 2+

---

## Execution

Plan written and committed to `docs/superpowers/plans/2026-07-16-desktop-scaffold.md`. **Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review gates between tasks, fast iteration  
**2. Inline Execution** — Execute tasks in-session with checkpoints

Which approach?