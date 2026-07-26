import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresAdapter } from '../postgres-adapter.js';
import type { ConnectionConfig } from '../types/index.js';

const baseConfig: ConnectionConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: 'zebraa',
  username: 'postgres',
  password: 'postgres',
};

describe('PostgresAdapter Integration Tests', () => {
  let adapter: PostgresAdapter;

  beforeAll(() => {
    adapter = new PostgresAdapter(baseConfig);
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('should test connection successfully with valid credentials', async () => {
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return error when testing connection with invalid password', async () => {
    const invalidAdapter = new PostgresAdapter({
      ...baseConfig,
      password: 'wrong_password_123',
    });
    const result = await invalidAdapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    await invalidAdapter.close();
  });

  it('should fetch complete schema info for zebraa database', async () => {
    const schema = await adapter.getSchema();
    expect(schema).toBeDefined();
    expect(schema.tables.length).toBeGreaterThanOrEqual(5);

    const tableNames = schema.tables.map((t) => t.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('posts');
    expect(tableNames).toContain('comments');
    expect(tableNames).toContain('tags');
    expect(tableNames).toContain('post_tags');

    // Check users table columns & PK
    const usersTable = schema.tables.find((t) => t.name === 'users')!;
    expect(usersTable).toBeDefined();
    const colNames = usersTable.columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('email');
    expect(colNames).toContain('name');
    expect(colNames).toContain('role');
    expect(usersTable.primaryKeys).toEqual(['id']);

    // Check composite primary key in post_tags
    const postTagsTable = schema.tables.find((t) => t.name === 'post_tags')!;
    expect(postTagsTable.primaryKeys).toEqual(['post_id', 'tag_id']);

    // Check foreign keys in posts table
    const postsTable = schema.tables.find((t) => t.name === 'posts')!;
    expect(postsTable.foreignKeys).toBeDefined();
    const fkUser = postsTable.foreignKeys?.find((fk) => fk.column === 'user_id');
    expect(fkUser).toEqual({
      column: 'user_id',
      refTable: 'users',
      refColumn: 'id',
    });
  });

  it('should connect to dummy_ecommerce database and fetch schema', async () => {
    const ecomAdapter = new PostgresAdapter({
      ...baseConfig,
      database: 'dummy_ecommerce',
    });

    try {
      const connTest = await ecomAdapter.testConnection();
      expect(connTest.ok).toBe(true);

      const schema = await ecomAdapter.getSchema();
      const tableNames = schema.tables.map((t) => t.name);
      expect(tableNames).toContain('customers');
      expect(tableNames).toContain('categories');
      expect(tableNames).toContain('products');
      expect(tableNames).toContain('orders');
      expect(tableNames).toContain('order_items');
    } finally {
      await ecomAdapter.close();
    }
  });

  it('should connect to dummy_analytics database and fetch schema', async () => {
    const analyticsAdapter = new PostgresAdapter({
      ...baseConfig,
      database: 'dummy_analytics',
    });

    try {
      const connTest = await analyticsAdapter.testConnection();
      expect(connTest.ok).toBe(true);

      const schema = await analyticsAdapter.getSchema();
      const tableNames = schema.tables.map((t) => t.name);
      expect(tableNames).toContain('events');
      expect(tableNames).toContain('daily_metrics');
      expect(tableNames).toContain('page_views');
    } finally {
      await analyticsAdapter.close();
    }
  });

  it('should fetch sample rows from a table', async () => {
    const sample = await adapter.getSampleRows('users', 2);
    expect(sample.columns).toContain('email');
    expect(sample.columns).toContain('name');
    expect(sample.rowCount).toBeLessThanOrEqual(2);
    expect(sample.rows.length).toBe(sample.rowCount);
  });

  it('should execute SELECT query with parameters', async () => {
    const res = await adapter.executeQuery('SELECT id, title FROM posts WHERE view_count >= $1', {
      params: [50],
      rowLimit: 100,
    });
    expect(res.columns).toEqual(['id', 'title']);
    expect(res.rowCount).toBeGreaterThan(0);
  });

  it('should execute DML write query (INSERT / DELETE) safely', async () => {
    const insertRes = await adapter.executeQuery(
      "INSERT INTO tags (name, slug) VALUES ('TestTag', 'test-tag') ON CONFLICT DO NOTHING"
    );
    expect(insertRes.columns).toEqual([]);
    expect(insertRes.rows).toEqual([]);

    const deleteRes = await adapter.executeQuery("DELETE FROM tags WHERE slug = 'test-tag'");
    expect(deleteRes.columns).toEqual([]);
    expect(deleteRes.rows).toEqual([]);
  });

  it('should enforce row limit option in executeQuery', async () => {
    const res = await adapter.executeQuery('SELECT * FROM users', { rowLimit: 1 });
    expect(res.rowCount).toBe(1);
    expect(res.rows.length).toBe(1);
  });

  it('should execute explainQuery and return plan text', async () => {
    const plan = await adapter.explainQuery("SELECT * FROM users WHERE email = 'alice@zebraa.io'");
    expect(typeof plan).toBe('string');
    expect(plan.length).toBeGreaterThan(0);
  });

  it('should fetch table stats including row count and size', async () => {
    const stats = await adapter.getTableStats('users');
    expect(stats.estimatedRows).toBeGreaterThanOrEqual(3);
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });
});
