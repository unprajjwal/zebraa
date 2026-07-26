import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

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

describe('Desktop Main IPC ClickHouse Handlers Integration', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    setupIpcHandlers();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should handle connections:test IPC for ClickHouse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ meta: [{ name: '1', type: 'UInt8' }], data: [{ '1': 1 }] }),
    } as any);

    const invoke = (ipcMain as any)._invoke;
    const res = await invoke('connections:test', {
      type: 'clickhouse',
      host: 'localhost',
      port: 8123,
      database: 'default',
      username: 'default',
      password: '',
    });
    expect(res.ok).toBe(true);
  });

  it('should handle connections:create, connections:list, schema:get, query:execute, and table:stats IPC for ClickHouse', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = opts.body || '';
      if (body.includes('total_rows') || body.includes('SELECT count()')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: [{ total_rows: '100', total_bytes: '4096' }] }),
        };
      }
      if (body.includes('system.tables')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              meta: [{ name: 'name', type: 'String' }],
              data: [{ name: 'logs' }],
            }),
        };
      }
      if (body.includes('system.columns')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              meta: [],
              data: [
                {
                  table: 'logs',
                  name: 'id',
                  type: 'UInt64',
                  default_expression: '',
                  is_in_primary_key: 1,
                },
                {
                  table: 'logs',
                  name: 'message',
                  type: 'String',
                  default_expression: '',
                  is_in_primary_key: 0,
                },
              ],
            }),
        };
      }
      if (body.includes('EXPLAIN')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: [{ explain: 'ReadFromSystemNumbers' }] }),
        };
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            meta: [{ name: 'id', type: 'UInt64' }],
            data: [{ id: 1 }],
          }),
      };
    }) as any;

    const invoke = (ipcMain as any)._invoke;

    // 1. Create ClickHouse connection
    const conn = await invoke('connections:create', {
      name: 'Test ClickHouse IPC',
      type: 'clickhouse',
      host: 'localhost',
      port: 8123,
      database: 'default',
      username: 'default',
      password: '',
    });
    expect(conn.id).toBeDefined();
    expect(conn.name).toBe('Test ClickHouse IPC');
    expect(conn.type).toBe('clickhouse');

    // 2. List connections
    const list = await invoke('connections:list');
    expect(list.some((c: any) => c.id === conn.id)).toBe(true);

    // 3. Fetch schema via IPC
    const schema = await invoke('schema:get', conn.id);
    expect(schema.tables.length).toBe(1);
    expect(schema.tables[0].name).toBe('logs');

    // 4. Query execute via IPC
    const queryRes = await invoke('query:execute', conn.id, 'SELECT id FROM logs');
    expect(queryRes.rowCount).toBe(1);

    // 5. Query explain via IPC
    const explainRes = await invoke('query:explain', conn.id, 'SELECT id FROM logs');
    expect(typeof explainRes).toBe('string');
    expect(explainRes).toContain('ReadFromSystemNumbers');

    // 6. Table sample via IPC
    const sampleRes = await invoke('table:sample', conn.id, 'logs', 2);
    expect(sampleRes.rowCount).toBe(1);

    // 7. Table stats via IPC
    const statsRes = await invoke('table:stats', conn.id, 'logs');
    expect(statsRes.estimatedRows).toBe(100);

    // 8. Delete connection
    await invoke('connections:delete', conn.id);
    const updatedList = await invoke('connections:list');
    expect(updatedList.some((c: any) => c.id === conn.id)).toBe(false);
  });
});
