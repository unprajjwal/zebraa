import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoDBAdapter } from '../mongodb-adapter.js';
import { createAdapter } from '../registry.js';
import type { ConnectionConfig } from '../types/index.js';

const mongoConfig: ConnectionConfig = {
  host: process.env.MONGO_HOST || 'localhost',
  port: parseInt(process.env.MONGO_PORT || '27017', 10),
  database: 'zebraa_test',
};

describe('MongoDBAdapter Unit & Integration Tests', () => {
  let adapter: MongoDBAdapter;

  beforeAll(async () => {
    adapter = new MongoDBAdapter(mongoConfig);

    // Seed test collections
    await adapter.executeQuery(
      JSON.stringify({
        delete: 'users',
        filter: {},
      })
    ).catch(() => {});

    await adapter.executeQuery(
      JSON.stringify({
        insert: 'users',
        documents: [
          { name: 'Alice', age: 25, role: 'admin', email: 'alice@test.com' },
          { name: 'Bob', age: 30, role: 'user', email: 'bob@test.com' },
        ],
      })
    );

    await adapter.executeQuery(
      JSON.stringify({
        delete: 'products',
        filter: {},
      })
    ).catch(() => {});

    await adapter.executeQuery(
      JSON.stringify({
        insert: 'products',
        documents: [
          { title: 'Laptop', price: 999, tags: ['electronics', 'computers'] },
          { title: 'Mouse', price: 29, tags: ['electronics'] },
        ],
      })
    );
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('should create adapter via registry factory', () => {
    const regAdapter = createAdapter('mongodb', mongoConfig);
    expect(regAdapter).toBeInstanceOf(MongoDBAdapter);
  });

  it('should test connection successfully', async () => {
    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('should return error for invalid connection host/port', async () => {
    const badAdapter = new MongoDBAdapter({
      host: '127.0.0.1',
      port: 59999, // Unreachable port
      database: 'zebraa_test',
    });
    const res = await badAdapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    await badAdapter.close();
  }, 10000);

  it('should fetch schema info and infer column types from sampled docs', async () => {
    const schema = await adapter.getSchema();
    expect(schema).toBeDefined();
    expect(schema.tables.length).toBeGreaterThanOrEqual(2);

    const tableNames = schema.tables.map((t) => t.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('products');

    const usersTable = schema.tables.find((t) => t.name === 'users')!;
    expect(usersTable).toBeDefined();
    expect(usersTable.primaryKeys).toEqual(['_id']);

    const colNames = usersTable.columns.map((c) => c.name);
    expect(colNames).toContain('name');
    expect(colNames).toContain('age');
    expect(colNames).toContain('role');
    expect(colNames).toContain('email');

    const ageCol = usersTable.columns.find((c) => c.name === 'age')!;
    expect(ageCol.type).toBe('number');
  });

  it('should fetch sample rows from a collection', async () => {
    const sample = await adapter.getSampleRows('users', 5);
    expect(sample.columns).toContain('name');
    expect(sample.columns).toContain('age');
    expect(sample.rowCount).toBe(2);
    expect(sample.rows.length).toBe(2);
  });

  it('should execute JSON find queries', async () => {
    const jsonQuery = JSON.stringify({
      collection: 'users',
      filter: { age: { $gte: 28 } },
    });
    const res = await adapter.executeQuery(jsonQuery);
    expect(res.rowCount).toBe(1);
    const nameIdx = res.columns.indexOf('name');
    expect(res.rows[0][nameIdx]).toBe('Bob');
  });

  it('should execute JSON aggregate queries', async () => {
    const aggQuery = JSON.stringify({
      aggregate: 'users',
      pipeline: [{ $match: { role: 'admin' } }],
    });
    const res = await adapter.executeQuery(aggQuery);
    expect(res.rowCount).toBe(1);
    const nameIdx = res.columns.indexOf('name');
    expect(res.rows[0][nameIdx]).toBe('Alice');
  });

  it('should execute SQL SELECT query translation', async () => {
    const res = await adapter.executeQuery('SELECT name, age FROM users WHERE age >= 25 ORDER BY age DESC');
    expect(res.columns).toEqual(['name', 'age']);
    expect(res.rowCount).toBe(2);
    expect(res.rows[0][0]).toBe('Bob');
    expect(res.rows[1][0]).toBe('Alice');
  });

  it('should execute SQL INSERT and DELETE query translation', async () => {
    const insertRes = await adapter.executeQuery("INSERT INTO users (name, age, role) VALUES ('Charlie', 35, 'user')");
    expect(insertRes.columns).toContain('insertedCount');
    expect(insertRes.rows[0][0]).toBe(1);

    const deleteRes = await adapter.executeQuery("DELETE FROM users WHERE name = 'Charlie'");
    expect(deleteRes.columns).toContain('deletedCount');
    expect(deleteRes.rows[0][0]).toBe(1);
  });

  it('should explain query execution plan', async () => {
    const plan = await adapter.explainQuery('SELECT * FROM users WHERE age > 20');
    expect(typeof plan).toBe('string');
    expect(plan.length).toBeGreaterThan(0);
  });

  it('should fetch table stats', async () => {
    const stats = await adapter.getTableStats('users');
    expect(stats.estimatedRows).toBeGreaterThanOrEqual(2);
  });
});
