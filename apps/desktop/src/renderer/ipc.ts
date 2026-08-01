import { invoke } from '@tauri-apps/api/core';
import type {
  ConnectionDTO,
  SchemaInfo,
  QueryOptions,
  RowSet,
  TableStats,
  AdapterType,
} from '@zebraa/core/types';
import { validateConnectionConfig } from '@zebraa/core/validation';

export interface NewConnectionInput {
  name: string;
  type?: AdapterType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  filepath?: string;
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
    explain(connectionId: string, sql: string): Promise<string>;
  };
  table: {
    sample(connectionId: string, table: string, limit?: number): Promise<RowSet>;
    stats(connectionId: string, table: string): Promise<TableStats>;
  };
}

export const tauriIpc: IpcApi = {
  connections: {
    list: () => invoke<ConnectionDTO[]>('connections_list'),
    create: (config) => invoke<ConnectionDTO>('connections_create', { config }),
    update: (id, updates) => invoke<ConnectionDTO>('connections_update', { id, updates }),
    delete: (id) => invoke<void>('connections_delete', { id }),
    test: (config) => invoke<{ ok: boolean; error?: string }>('connections_test', { config }),
  },
  schema: {
    get: (connectionId) => invoke<SchemaInfo>('schema_get', { connectionId }),
  },
  query: {
    execute: (connectionId, sql, opts) => invoke<RowSet>('query_execute', { connectionId, sql, opts }),
    explain: (connectionId, sql) => invoke<string>('query_explain', { connectionId, sql }),
  },
  table: {
    sample: (connectionId, table, limit) => invoke<RowSet>('table_sample', { connectionId, table, limit }),
    stats: (connectionId, table) => invoke<TableStats>('table_stats', { connectionId, table }),
  },
};

export const fallbackIpc: IpcApi = {
  connections: {
    list: async () => {
      try {
        return await tauriIpc.connections.list();
      } catch {
        return [];
      }
    },
    create: async (config) => {
      try {
        return await tauriIpc.connections.create(config);
      } catch {
        return {
          id: 'demo-1',
          name: config.name,
          type: config.type || 'postgres',
          host: config.host,
          port: config.port,
          database: config.database,
          username: config.username,
          created_at: Date.now(),
          updated_at: Date.now(),
        };
      }
    },
    update: async (id, config) => {
      try {
        return await tauriIpc.connections.update(id, config);
      } catch {
        return {
          id,
          name: config.name || 'Updated',
          type: config.type || 'postgres',
          host: config.host || 'localhost',
          port: config.port || 5432,
          database: config.database || 'zebraa',
          username: config.username || 'postgres',
          created_at: Date.now(),
          updated_at: Date.now(),
        };
      }
    },
    delete: async (id) => {
      try {
        return await tauriIpc.connections.delete(id);
      } catch {}
    },
    test: async (config) => {
      try {
        return await tauriIpc.connections.test(config);
      } catch (err) {
        // A real backend failure must not be disguised as "browser preview mode".
        if (isTauriEnvironment()) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const adapterType = config.type || 'postgres';
        const connConfig = {
          host: config.host,
          port: config.port,
          database: config.database || config.filepath,
          username: config.username,
          password: config.password,
          filepath: config.filepath || config.database,
        };

        const validation = validateConnectionConfig(adapterType, connConfig);
        if (!validation.valid) {
          return { ok: false, error: validation.error };
        }

        return {
          ok: false,
          error: 'Direct database TCP socket connection is unavailable in web browser preview mode. Please run the desktop application (`pnpm dev`).',
        };
      }
    },
  },
  schema: {
    get: async (connectionId) => {
      try {
        return await tauriIpc.schema.get(connectionId);
      } catch {
        return { tables: [] };
      }
    },
  },
  query: {
    execute: async (connectionId, sql, opts) => {
      try {
        return await tauriIpc.query.execute(connectionId, sql, opts);
      } catch {
        return { columns: [], rows: [], rowCount: 0 };
      }
    },
    explain: async (connectionId, sql) => {
      try {
        return await tauriIpc.query.explain(connectionId, sql);
      } catch {
        return 'Execution plan unavailable in browser preview';
      }
    },
  },
  table: {
    sample: async (connectionId, table, limit) => {
      try {
        return await tauriIpc.table.sample(connectionId, table, limit);
      } catch {
        return { columns: [], rows: [], rowCount: 0 };
      }
    },
    stats: async (connectionId, table) => {
      try {
        return await tauriIpc.table.stats(connectionId, table);
      } catch {
        return { estimatedRows: 0, sizeBytes: 0 };
      }
    },
  },
};

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    '__TAURI_INTERNALS__' in window ||
    '__TAURI_IPC__' in window ||
    '__TAURI__' in window ||
    '__TAURI_PATTERN__' in window ||
    Boolean((window as any).__TAURI_POST_MESSAGE__)
  );
}

export function getActiveIpc(): IpcApi {
  if (isTauriEnvironment()) {
    return tauriIpc;
  }
  return fallbackIpc;
}

// NOTE: do NOT use `window.ipc` — in a Tauri/WKWebView window that name is owned by
// Tauri's own IPC bridge (`window.ipc.postMessage`) and cannot be overridden.
// Application code should call getActiveIpc(); this global exists for debugging only.
if (typeof window !== 'undefined') {
  try {
    Object.defineProperty(window, 'zebraaIpc', {
      get() {
        return getActiveIpc();
      },
      configurable: true,
      enumerable: true,
    });
  } catch (_err) {
    console.warn('Could not expose window.zebraaIpc:', _err);
  }
}

declare global {
  interface Window {
    zebraaIpc: IpcApi;
  }
}
