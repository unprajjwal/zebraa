import { invoke } from '@tauri-apps/api/core';
import type { ConnectionDTO, SchemaInfo, QueryOptions, RowSet, TableStats, AdapterType } from '@zebraa/core';

export interface NewConnectionInput {
  name: string;
  type?: AdapterType;
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
    list: async () => [],
    create: async (config) => ({
      id: 'demo-1',
      name: config.name,
      type: config.type || 'postgres',
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      created_at: Date.now(),
      updated_at: Date.now(),
    }),
    update: async (id, config) => ({
      id,
      name: config.name || 'Updated',
      type: config.type || 'postgres',
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'zebraa',
      username: config.username || 'postgres',
      created_at: Date.now(),
      updated_at: Date.now(),
    }),
    delete: async () => {},
    test: async () => ({
      ok: false,
      error: 'IPC bridge is unavailable. Please run the app inside Desktop runtime.',
    }),
  },
  schema: {
    get: async () => ({ tables: [] }),
  },
  query: {
    execute: async () => ({ columns: [], rows: [], rowCount: 0 }),
    explain: async () => 'Execution plan unavailable in browser preview',
  },
  table: {
    sample: async () => ({ columns: [], rows: [], rowCount: 0 }),
    stats: async () => ({ estimatedRows: 0, sizeBytes: 0 }),
  },
};

export function getActiveIpc(): IpcApi {
  if (typeof window === 'undefined') {
    return fallbackIpc;
  }

  // 1. Check if running inside Tauri environment
  if ('__TAURI_INTERNALS__' in window || '__TAURI_IPC__' in window || '__TAURI__' in window) {
    return tauriIpc;
  }

  // 2. Check if running inside Electron environment (window.ipc pre-exposed by preload script)
  if (window.ipc) {
    return window.ipc;
  }

  // 3. Fallback for browser environment
  return fallbackIpc;
}

// Bind window.ipc safely once without re-assignment errors
if (typeof window !== 'undefined') {
  const activeIpc = getActiveIpc();
  try {
    if (window.ipc !== activeIpc) {
      Object.defineProperty(window, 'ipc', {
        value: activeIpc,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  } catch (_err) {
    try {
      (window as any).ipc = activeIpc;
    } catch (_err2) {
      console.warn('Could not assign window.ipc directly:', _err2);
    }
  }
}

declare global {
  interface Window {
    ipc: IpcApi;
  }
}
