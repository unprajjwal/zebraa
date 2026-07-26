import { describe, it, expect } from 'vitest';
import { MySQLAdapter, createAdapter } from '@zebraa/core';

const HOST = process.env.MYSQL_HOST || 'localhost';
const PORT = parseInt(process.env.MYSQL_PORT || '3306', 10);
const USERNAME = 'root';
const PASSWORD = 'mysql';

describe('End-to-End MySQL Flow Validation', () => {
  describe('Zebraa Main Database Flow', () => {
    it('should complete full mysql lifecycle: test -> schema -> query -> dml -> explain -> stats', async () => {
      const adapter = createAdapter('mysql', {
        host: HOST,
        port: PORT,
        database: 'zebraa',
        username: USERNAME,
        password: PASSWORD,
      }) as MySQLAdapter;

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
          'SELECT p.title, u.name as author FROM posts p JOIN users u ON p.user_id = u.id WHERE u.email = ?',
          { params: ['alice@zebraa.io'] }
        );
        expect(queryRes.rowCount).toBeGreaterThan(0);
        expect(queryRes.columns).toEqual(['title', 'author']);

        // 5. DML Execution (Insert -> Query -> Delete)
        const userRes = await adapter.executeQuery('SELECT id FROM users LIMIT 1');
        expect(userRes.rowCount).toBeGreaterThan(0);
        const validUserId = userRes.rows[0][0] as number;

        const newSlug = `test-post-mysql-${Date.now()}`;
        const insertRes = await adapter.executeQuery(
          'INSERT INTO posts (user_id, title, slug, content) VALUES (?, ?, ?, ?)',
          { params: [validUserId, 'E2E MySQL Test Post', newSlug, 'E2E MySQL Content'] }
        );
        expect(insertRes.rowCount).toBe(1);

        const verifyRes = await adapter.executeQuery('SELECT * FROM posts WHERE slug = ?', {
          params: [newSlug],
        });
        expect(verifyRes.rowCount).toBe(1);

        const deleteRes = await adapter.executeQuery('DELETE FROM posts WHERE slug = ?', {
          params: [newSlug],
        });
        expect(deleteRes.rowCount).toBe(1);

        // 6. Explain Query
        const explain = await adapter.explainQuery('SELECT * FROM comments WHERE post_id = 1');
        expect(explain.length).toBeGreaterThan(0);

        // 7. Table Stats
        const stats = await adapter.getTableStats('users');
        expect(stats.estimatedRows).toBeGreaterThan(0);
        expect(stats.sizeBytes).toBeGreaterThanOrEqual(0);
      } finally {
        await adapter.close();
      }
    });
  });

  describe('Dummy E-Commerce Database Flow', () => {
    it('should query relational structure (customers, products, orders)', async () => {
      const adapter = createAdapter('mysql', {
        host: HOST,
        port: PORT,
        database: 'dummy_ecommerce',
        username: USERNAME,
        password: PASSWORD,
      }) as MySQLAdapter;

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
            CONCAT(c.first_name, ' ', c.last_name) as customer_name,
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
    it('should query JSON fields and aggregate data', async () => {
      const adapter = createAdapter('mysql', {
        host: HOST,
        port: PORT,
        database: 'dummy_analytics',
        username: USERNAME,
        password: PASSWORD,
      }) as MySQLAdapter;

      try {
        // Query JSON payload field in MySQL
        const jsonQuery = `
          SELECT event_name, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.path')) as path
          FROM events
          WHERE JSON_EXTRACT(payload, '$.path') IS NOT NULL
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
      const adapter = createAdapter('mysql', {
        host: HOST,
        port: PORT,
        database: 'zebraa',
        username: USERNAME,
        password: PASSWORD,
      }) as MySQLAdapter;

      try {
        await expect(adapter.executeQuery('SELECT * FROM non_existent_table_xyz')).rejects.toThrow();
      } finally {
        await adapter.close();
      }
    });
  });
});
