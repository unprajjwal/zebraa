import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock electron before importing ipc.ts
vi.mock('electron', () => {
  const handlers = new Map<string, Function>();
  return {
    ipcMain: {
      handle: (channel: string, listener: Function) => {
        handlers.set(channel, listener);
      },
      _invoke: async (channel: string, ...args: any[]) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
        return await handler({} as any, ...args);
      },
    },
    safeStorage: {
      encryptString: (plain: string) => Buffer.from(`enc_${plain}`),
      decryptString: (buf: Buffer) => buf.toString('utf-8').replace(/^enc_/, ''),
    },
  };
});

// Mock db.ts to avoid requiring compiled native sqlite bindings during unit tests
vi.mock('../main/db.js', () => {
  const store = new Map<string, any>();
  return {
    initializeDatabase: () => {},
    closeDatabase: () => {},
    listConnections: () => Array.from(store.values()),
    getConnection: (id: string) => store.get(id),
    createConnection: (conn: any) => {
      const row = { ...conn, created_at: Date.now(), updated_at: Date.now() };
      store.set(conn.id, row);
    },
    updateConnection: (id: string, updates: any) => {
      const existing = store.get(id);
      if (existing) {
        Object.assign(existing, updates, { updated_at: Date.now() });
      }
    },
    deleteConnection: (id: string) => {
      store.delete(id);
    },
  };
});

import { ipcMain } from 'electron';
import { setupIpcHandlers } from '../main/ipc.js';

describe('Desktop Main IPC MySQL Handlers Integration', () => {
  beforeAll(() => {
    setupIpcHandlers();
  });

  it('should handle connections:test IPC for MySQL', async () => {
    const invoke = (ipcMain as any)._invoke;
    const res = await invoke('connections:test', {
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      database: 'zebraa',
      username: 'root',
      password: 'mysql',
    });
    expect(res.ok).toBe(true);
  });

  it('should handle connections:create, connections:list, schema:get, query:execute, and table:stats IPC for MySQL', async () => {
    const invoke = (ipcMain as any)._invoke;

    // 1. Create MySQL connection
    const conn = await invoke('connections:create', {
      name: 'Test MySQL IPC',
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      database: 'zebraa',
      username: 'root',
      password: 'mysql',
    });
    expect(conn.id).toBeDefined();
    expect(conn.name).toBe('Test MySQL IPC');
    expect(conn.type).toBe('mysql');

    // 2. List connections
    const list = await invoke('connections:list');
    expect(list.some((c: any) => c.id === conn.id)).toBe(true);

    // 3. Fetch schema via IPC
    const schema = await invoke('schema:get', conn.id);
    expect(schema.tables.length).toBeGreaterThanOrEqual(5);

    // 4. Query execute via IPC
    const queryRes = await invoke('query:execute', conn.id, 'SELECT COUNT(*) as cnt FROM users');
    expect(queryRes.rowCount).toBe(1);

    // 5. Query explain via IPC
    const explainRes = await invoke('query:explain', conn.id, 'SELECT * FROM users');
    expect(typeof explainRes).toBe('string');

    // 6. Table sample via IPC
    const sampleRes = await invoke('table:sample', conn.id, 'users', 2);
    expect(sampleRes.rowCount).toBeLessThanOrEqual(2);

    // 7. Table stats via IPC
    const statsRes = await invoke('table:stats', conn.id, 'users');
    expect(statsRes.estimatedRows).toBeGreaterThan(0);

    // 8. Delete connection
    await invoke('connections:delete', conn.id);
    const updatedList = await invoke('connections:list');
    expect(updatedList.some((c: any) => c.id === conn.id)).toBe(false);
  });
});
