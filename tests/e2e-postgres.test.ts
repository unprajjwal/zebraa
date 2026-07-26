import { describe, it, expect } from 'vitest';
import { PostgresAdapter, createAdapter } from '@zebraa/core';

const HOST = process.env.POSTGRES_HOST || 'localhost';
const PORT = parseInt(process.env.POSTGRES_PORT || '5432', 10);
const USERNAME = 'postgres';
const PASSWORD = 'postgres';

describe('End-to-End Postgres Flow Validation', () => {
  describe('Zebraa Main Database Flow', () => {
    it('should complete full postgres lifecycle: test -> schema -> query -> dml -> explain -> stats', async () => {
      const adapter = createAdapter('postgres', {
        host: HOST,
        port: PORT,
        database: 'zebraa',
        username: USERNAME,
        password: PASSWORD,
      }) as PostgresAdapter;

      try {
        // 1. Test Connection
        const conn = await adapter.testConnection();
        expect(conn.ok).toBe(true);

        // 2. Schema Discovery
        const schema = await adapter.getSchema();
        expect(schema.tables.length).toBeGreaterThanOrEqual(5);

        const usersTable = schema.tables.find((t) => t.name === 'users');
        expect(usersTable).toBeDefined();
        expect(usersTable?.primaryKeys).toEqual(['id']);

        // 3. Sample Rows
        const samples = await adapter.getSampleRows('posts', 3);
        expect(samples.rowCount).toBeGreaterThan(0);
        expect(samples.columns).toContain('title');

        // 4. Parameterized Query Execution
        const queryRes = await adapter.executeQuery(
          'SELECT p.title, u.name as author FROM posts p JOIN users u ON p.user_id = u.id WHERE u.email = $1',
          { params: ['alice@zebraa.io'] }
        );
        expect(queryRes.rowCount).toBeGreaterThan(0);
        expect(queryRes.columns).toEqual(['title', 'author']);

        // 5. DML Execution (Insert -> Query -> Delete)
        const userRes = await adapter.executeQuery('SELECT id FROM users LIMIT 1');
        expect(userRes.rowCount).toBeGreaterThan(0);
        const validUserId = userRes.rows[0][0] as number;

        const newSlug = `test-post-${Date.now()}`;
        const insertRes = await adapter.executeQuery(
          'INSERT INTO posts (user_id, title, slug, content) VALUES ($1, $2, $3, $4)',
          { params: [validUserId, 'E2E Test Post', newSlug, 'E2E Content'] }
        );
        expect(insertRes.rowCount).toBe(1);

        const verifyRes = await adapter.executeQuery('SELECT * FROM posts WHERE slug = $1', {
          params: [newSlug],
        });
        expect(verifyRes.rowCount).toBe(1);

        const deleteRes = await adapter.executeQuery('DELETE FROM posts WHERE slug = $1', {
          params: [newSlug],
        });
        expect(deleteRes.rowCount).toBe(1);

        // 6. Explain Query
        const explain = await adapter.explainQuery('SELECT * FROM comments WHERE post_id = 1');
        expect(explain.toLowerCase()).toContain('scan');

        // 7. Table Stats
        const stats = await adapter.getTableStats('users');
        expect(stats.estimatedRows).toBeGreaterThan(0);
        expect(stats.sizeBytes).toBeGreaterThan(0);
      } finally {
        await adapter.close();
      }
    });
  });

  describe('Dummy E-Commerce Database Flow', () => {
    it('should query relational structure (customers, products, orders)', async () => {
      const adapter = createAdapter('postgres', {
        host: HOST,
        port: PORT,
        database: 'dummy_ecommerce',
        username: USERNAME,
        password: PASSWORD,
      }) as PostgresAdapter;

      try {
        const schema = await adapter.getSchema();
        const names = schema.tables.map((t) => t.name);
        expect(names).toContain('customers');
        expect(names).toContain('products');
        expect(names).toContain('orders');
        expect(names).toContain('order_items');

        // Complex relational join query
        const joinQuery = `
          SELECT
            c.first_name || ' ' || c.last_name as customer_name,
            o.id as order_id,
            o.total_amount,
            p.name as product_name,
            oi.quantity,
            oi.unit_price
          FROM orders o
          JOIN customers c ON o.customer_id = c.id
          JOIN order_items oi ON o.id = oi.order_id
          JOIN products p ON oi.product_id = p.id
          ORDER BY o.id
        `;

        const res = await adapter.executeQuery(joinQuery);
        expect(res.rowCount).toBeGreaterThan(0);
        expect(res.columns).toContain('customer_name');
        expect(res.columns).toContain('product_name');
      } finally {
        await adapter.close();
      }
    });
  });

  describe('Dummy Analytics Database Flow', () => {
    it('should query JSONB fields and aggregate data', async () => {
      const adapter = createAdapter('postgres', {
        host: HOST,
        port: PORT,
        database: 'dummy_analytics',
        username: USERNAME,
        password: PASSWORD,
      }) as PostgresAdapter;

      try {
        // Query JSONB payload field
        const jsonQuery = `
          SELECT event_name, payload->>'path' as path
          FROM events
          WHERE payload ? 'path'
        `;
        const jsonRes = await adapter.executeQuery(jsonQuery);
        expect(jsonRes.rowCount).toBeGreaterThan(0);

        // Aggregate metrics query
        const aggQuery = `
          SELECT
            SUM(page_views) as total_views,
            AVG(active_users) as avg_users
          FROM daily_metrics
        `;
        const aggRes = await adapter.executeQuery(aggQuery);
        expect(aggRes.rowCount).toBe(1);
      } finally {
        await adapter.close();
      }
    });
  });

  describe('Error Handling and Safety Validations', () => {
    it('should gracefully return error message on invalid SQL syntax', async () => {
      const adapter = createAdapter('postgres', {
        host: HOST,
        port: PORT,
        database: 'zebraa',
        username: USERNAME,
        password: PASSWORD,
      }) as PostgresAdapter;

      try {
        await expect(adapter.executeQuery('SELECT * FROM non_existent_table_xyz')).rejects.toThrow();
      } finally {
        await adapter.close();
      }
    });

    it('should enforce statement timeout when query takes too long', async () => {
      const adapter = createAdapter('postgres', {
        host: HOST,
        port: PORT,
        database: 'zebraa',
        username: USERNAME,
        password: PASSWORD,
      }) as PostgresAdapter;

      try {
        // 100ms statement timeout for a 1 second pg_sleep
        await expect(
          adapter.executeQuery('SELECT pg_sleep(1)', { timeoutMs: 100 })
        ).rejects.toThrow(/canceling statement due to statement timeout/i);
      } finally {
        await adapter.close();
      }
    });
  });
});
