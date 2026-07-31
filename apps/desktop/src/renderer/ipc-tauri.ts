import { invoke } from '@tauri-apps/api/core';
import type { ConnectionDTO, SchemaInfo, QueryOptions, RowSet, TableStats, AdapterType } from '@zebraa/core';

interface NewConnectionInput {
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

// Bind window.ipc if running within Tauri runtime environment
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  window.ipc = tauriIpc;
}
