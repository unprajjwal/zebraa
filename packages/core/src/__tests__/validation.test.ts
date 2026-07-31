import { describe, it, expect } from 'vitest';
import {
  validateConnectionConfig,
  assertValidConnectionConfig,
  createAdapter,
  PostgresAdapter,
  MySQLAdapter,
  SQLiteAdapter,
  MariaDBAdapter,
  MSSQLAdapter,
  MongoDBAdapter,
  RedisAdapter,
} from '../index.js';
import { ClickHouseAdapter } from '../clickhouse-adapter.js';
import type { AdapterType, DBAdapter } from '../types/index.js';

const allAdapters: AdapterType[] = [
  'postgres',
  'mysql',
  'sqlite',
  'mariadb',
  'mssql',
  'mongodb',
  'redis',
  'clickhouse',
];

describe('End-to-End Database Connection Validation', () => {
  it('should reject invalid or missing database type', () => {
    const res = validateConnectionConfig('invalid_type' as AdapterType, {});
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Invalid or unsupported database type');
  });

  it('should reject missing or non-object config', () => {
    for (const type of allAdapters) {
      const res = validateConnectionConfig(type, null);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('Connection configuration is required');
    }
  });

  it('should reject empty host for socket-based databases', () => {
    const hostDbs: AdapterType[] = ['postgres', 'mysql', 'mariadb', 'mssql', 'mongodb', 'redis', 'clickhouse'];
    for (const type of hostDbs) {
      const res = validateConnectionConfig(type, { host: '', port: 5432, database: 'db' });
      expect(res.valid).toBe(false);
      expect(res.error).toBe('Host is required');
    }
  });

  it('should reject invalid, missing, or NaN port for socket-based databases', () => {
    const hostDbs: AdapterType[] = ['postgres', 'mysql', 'mariadb', 'mssql', 'mongodb', 'redis', 'clickhouse'];
    for (const type of hostDbs) {
      // missing port
      const resMissing = validateConnectionConfig(type, { host: 'localhost', database: 'db' });
      expect(resMissing.valid).toBe(false);
      expect(resMissing.error).toBe('Port is required');

      // NaN port
      const resNaN = validateConnectionConfig(type, { host: 'localhost', port: NaN, database: 'db' });
      expect(resNaN.valid).toBe(false);
      expect(resNaN.error).toBe('Port must be a valid integer between 1 and 65535');

      // Out of range port
      const resOutOfRange = validateConnectionConfig(type, { host: 'localhost', port: 99999, database: 'db' });
      expect(resOutOfRange.valid).toBe(false);
      expect(resOutOfRange.error).toBe('Port must be a valid integer between 1 and 65535');
    }
  });

  it('should reject missing database name for databases requiring it', () => {
    const dbNameDbs: AdapterType[] = ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse'];
    for (const type of dbNameDbs) {
      const res = validateConnectionConfig(type, { host: 'localhost', port: 5432, database: '', username: 'user' });
      expect(res.valid).toBe(false);
      expect(res.error).toBe('Database name is required');
    }
  });

  it('should reject missing username for databases strictly requiring username', () => {
    const usernameDbs: AdapterType[] = ['postgres', 'mysql', 'mariadb', 'mssql'];
    for (const type of usernameDbs) {
      const res = validateConnectionConfig(type, { host: 'localhost', port: 5432, database: 'testdb', username: '' });
      expect(res.valid).toBe(false);
      expect(res.error).toBe('Username is required');
    }
  });

  it('should validate SQLite database file path', () => {
    const resEmpty = validateConnectionConfig('sqlite', { filepath: '', database: '' });
    expect(resEmpty.valid).toBe(false);
    expect(resEmpty.error).toBe('Database file path is required for SQLite');

    const resValid = validateConnectionConfig('sqlite', { database: ':memory:' });
    expect(resValid.valid).toBe(true);
  });

  it('should validate all adapters via createAdapter and throw Error (not TypeError) when invalid', () => {
    for (const type of allAdapters) {
      expect(() => {
        createAdapter(type, { host: '', port: NaN } as any);
      }).toThrowError();
    }
  });

  it('should return ok: false with clear error message (not TypeError) when testConnection is called with incomplete details for all 8 databases', async () => {
    const adapterInstances: DBAdapter[] = [
      new PostgresAdapter({ host: '', port: NaN, database: '' }),
      new MySQLAdapter({ host: '', port: NaN, database: '' }),
      new SQLiteAdapter({ host: '', database: '' }),
      new MariaDBAdapter({ host: '', port: NaN, database: '' }),
      new MSSQLAdapter({ host: '', port: NaN, database: '' }),
      new MongoDBAdapter({ host: '', port: NaN, database: '' }),
      new RedisAdapter({ host: '', port: NaN }),
      new ClickHouseAdapter({ host: '', port: NaN, database: '' }),
    ];

    for (const adapter of adapterInstances) {
      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();
      expect(typeof res.error).toBe('string');
      expect(res.error).not.toContain('TypeError');
      await adapter.close();
    }
  });
});


