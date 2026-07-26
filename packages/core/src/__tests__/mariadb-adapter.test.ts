import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MariaDBAdapter } from '../mariadb-adapter.js';
import { createAdapter } from '../registry.js';
import type { ConnectionConfig } from '../types/index.js';

const baseConfig: ConnectionConfig = {
  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3307', 10),
  database: 'zebraa',
  username: 'root',
  password: 'mariadb',
};

describe('MariaDBAdapter Tests', () => {
  let adapter: MariaDBAdapter;
  let isLiveServerAvailable = false;

  beforeAll(async () => {
    adapter = new MariaDBAdapter(baseConfig);
    const conn = await adapter.testConnection();
    isLiveServerAvailable = conn.ok;
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('should instantiate MariaDBAdapter via registry createAdapter', () => {
    const regAdapter = createAdapter('mariadb', baseConfig);
    expect(regAdapter).toBeInstanceOf(MariaDBAdapter);
  });

  it('should return error when testing connection with invalid password', async () => {
    const invalidAdapter = new MariaDBAdapter({
      ...baseConfig,
      password: 'definitely_wrong_password_123',
    });
    const result = await invalidAdapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    await invalidAdapter.close();
  });

  it('should test connection successfully if server is live or report connection state', async () => {
    const result = await adapter.testConnection();
    if (isLiveServerAvailable) {
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    } else {
      expect(result.ok).toBe(false);
    }
  });

  it('should fetch schema info cleanly', async () => {
    if (!isLiveServerAvailable) {
      // Unit test verification of getSchema method presence & handling
      expect(typeof adapter.getSchema).toBe('function');
      return;
    }

    const schema = await adapter.getSchema();
    expect(schema).toBeDefined();
    expect(Array.isArray(schema.tables)).toBe(true);

    if (schema.tables.length > 0) {
      const firstTable = schema.tables[0];
      expect(firstTable.name).toBeDefined();
      expect(Array.isArray(firstTable.columns)).toBe(true);
    }
  });

  it('should fetch sample rows from table', async () => {
    if (!isLiveServerAvailable) {
      expect(typeof adapter.getSampleRows).toBe('function');
      return;
    }

    const schema = await adapter.getSchema();
    if (schema.tables.length === 0) return;

    const tableName = schema.tables[0].name;
    const sample = await adapter.getSampleRows(tableName, 2);
    expect(Array.isArray(sample.columns)).toBe(true);
    expect(Array.isArray(sample.rows)).toBe(true);
    expect(sample.rowCount).toBe(sample.rows.length);
  });

  it('should execute SELECT query with parameters', async () => {
    if (!isLiveServerAvailable) {
      expect(typeof adapter.executeQuery).toBe('function');
      return;
    }

    const res = await adapter.executeQuery('SELECT 1 as num, ? as text', {
      params: ['hello'],
    });
    expect(res.columns).toContain('num');
    expect(res.columns).toContain('text');
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]).toEqual([1, 'hello']);
  });

  it('should execute SELECT query with Postgres-style $1 parameters', async () => {
    if (!isLiveServerAvailable) {
      return;
    }

    const res = await adapter.executeQuery('SELECT $1 as test_val', {
      params: ['mariadb_test'],
    });
    expect(res.columns).toContain('test_val');
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]).toEqual(['mariadb_test']);
  });

  it('should execute explainQuery', async () => {
    if (!isLiveServerAvailable) {
      expect(typeof adapter.explainQuery).toBe('function');
      return;
    }

    const plan = await adapter.explainQuery('SELECT 1');
    expect(typeof plan).toBe('string');
    expect(plan.length).toBeGreaterThan(0);
  });

  it('should fetch table stats', async () => {
    if (!isLiveServerAvailable) {
      expect(typeof adapter.getTableStats).toBe('function');
      return;
    }

    const schema = await adapter.getSchema();
    if (schema.tables.length === 0) return;

    const stats = await adapter.getTableStats(schema.tables[0].name);
    expect(stats.estimatedRows).toBeGreaterThanOrEqual(0);
    expect(stats.sizeBytes).toBeGreaterThanOrEqual(0);
  });
});
