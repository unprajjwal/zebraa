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
