import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClickHouseAdapter } from '../clickhouse-adapter.js';
import { createAdapter } from '../registry.js';
import type { ConnectionConfig } from '../types/index.js';

const baseConfig: ConnectionConfig = {
  host: 'localhost',
  port: 8123,
  database: 'default',
  username: 'default',
  password: '',
};

describe('ClickHouseAdapter Unit Tests', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should instantiate ClickHouseAdapter directly and via createAdapter registry', () => {
    const adapter = new ClickHouseAdapter(baseConfig);
    expect(adapter).toBeInstanceOf(ClickHouseAdapter);

    const registryAdapter = createAdapter('clickhouse', baseConfig);
    expect(registryAdapter).toBeInstanceOf(ClickHouseAdapter);
  });

  it('should test connection successfully when ClickHouse returns 200 OK', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ meta: [{ name: '1', type: 'UInt8' }], data: [{ '1': 1 }] }),
    } as any);

    const adapter = new ClickHouseAdapter(baseConfig);
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return error on failed connection test', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'DB::Exception: Authentication failed',
    } as any);

    const adapter = new ClickHouseAdapter(baseConfig);
    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Authentication failed');
  });

  it('should fetch schema info by querying system.tables and system.columns', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = opts.body;
      if (body.includes('system.tables')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              meta: [{ name: 'name', type: 'String' }],
              data: [{ name: 'events' }, { name: 'users' }],
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
                  table: 'users',
                  name: 'id',
                  type: 'UInt64',
                  default_expression: '',
                  is_in_primary_key: 1,
                },
                {
                  table: 'users',
                  name: 'email',
                  type: 'String',
                  default_expression: '',
                  is_in_primary_key: 0,
                },
                {
                  table: 'users',
                  name: 'nickname',
                  type: 'Nullable(String)',
                  default_expression: "'anonymous'",
                  is_in_primary_key: 0,
                },
                {
                  table: 'events',
                  name: 'event_id',
                  type: 'UUID',
                  default_expression: '',
                  is_in_primary_key: 1,
                },
              ],
            }),
        };
      }
      return { ok: true, text: async () => '{}' };
    }) as any;

    const adapter = new ClickHouseAdapter(baseConfig);
    const schema = await adapter.getSchema();

    expect(schema.tables.length).toBe(2);
    const usersTable = schema.tables.find((t) => t.name === 'users');
    expect(usersTable).toBeDefined();
    expect(usersTable?.primaryKeys).toEqual(['id']);
    expect(usersTable?.columns.length).toBe(3);

    const nicknameCol = usersTable?.columns.find((c) => c.name === 'nickname');
    expect(nicknameCol?.nullable).toBe(true);
    expect(nicknameCol?.default).toBe("'anonymous'");

    const emailCol = usersTable?.columns.find((c) => c.name === 'email');
    expect(emailCol?.nullable).toBe(false);
  });

  it('should fetch sample rows correctly', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          meta: [
            { name: 'id', type: 'UInt64' },
            { name: 'name', type: 'String' },
          ],
          data: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        }),
    } as any);

    const adapter = new ClickHouseAdapter(baseConfig);
    const sample = await adapter.getSampleRows('users', 2);

    expect(sample.columns).toEqual(['id', 'name']);
    expect(sample.rowCount).toBe(2);
    expect(sample.rows).toEqual([
      [1, 'Alice'],
      [2, 'Bob'],
    ]);
  });

  it('should execute SELECT query with parameters and row limit', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = opts.body;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            meta: [
              { name: 'id', type: 'UInt64' },
              { name: 'val', type: 'String' },
            ],
            data: [
              { id: 10, val: 'test1' },
              { id: 20, val: 'test2' },
            ],
          }),
      };
    }) as any;

    const adapter = new ClickHouseAdapter(baseConfig);
    const res = await adapter.executeQuery('SELECT id, val FROM items WHERE id >= $1 AND val = $2', {
      params: [10, 'test1'],
      rowLimit: 1,
    });

    expect(capturedBody).toContain("WHERE id >= 10 AND val = 'test1'");
    expect(capturedBody).toContain('FORMAT JSON');
    expect(res.columns).toEqual(['id', 'val']);
    expect(res.rowCount).toBe(1);
    expect(res.rows).toEqual([[10, 'test1']]);
  });

  it('should handle non-SELECT/DML queries gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ rows: 5 }),
    } as any);

    const adapter = new ClickHouseAdapter(baseConfig);
    const res = await adapter.executeQuery('OPTIMIZE TABLE users FINAL');

    expect(res.columns).toEqual([]);
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(5);
  });

  it('should execute explainQuery and return formatted plan', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [
            { explain: 'Expression (Projection)' },
            { explain: '  Filter (WHERE id = 1)' },
            { explain: '    ReadFromMergeTree' },
          ],
        }),
    } as any);

    const adapter = new ClickHouseAdapter(baseConfig);
    const plan = await adapter.explainQuery('SELECT * FROM users WHERE id = 1');

    expect(plan).toContain('Expression (Projection)');
    expect(plan).toContain('ReadFromMergeTree');
  });

  it('should fetch table stats using system.tables and fallback to count() if necessary', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = opts.body;
      if (body.includes('system.tables')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: [{ total_rows: '1500', total_bytes: '8192000' }],
            }),
        };
      }
      return { ok: true, text: async () => '{}' };
    }) as any;

    const adapter = new ClickHouseAdapter(baseConfig);
    const stats = await adapter.getTableStats('events');

    expect(stats.estimatedRows).toBe(1500);
    expect(stats.sizeBytes).toBe(8192000);
  });

  it('should close connection gracefully', async () => {
    const adapter = new ClickHouseAdapter(baseConfig);
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
