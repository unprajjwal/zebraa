import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { createAdapter } from '../registry.js';
import type { ConnectionConfig } from '../types/index.js';

let isSqliteAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
  isSqliteAvailable = true;
} catch {
  isSqliteAvailable = false;
}

describe.skipIf(!isSqliteAvailable)('SQLiteAdapter Tests', () => {
  let tempDir: string;
  let dbPath: string;
  let adapter: SQLiteAdapter;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zebraa-sqlite-test-'));
    dbPath = path.join(tempDir, 'test.db');

    adapter = new SQLiteAdapter({ filepath: dbPath });

    // Seed database with tables, foreign keys, defaults, and sample data
    await adapter.executeQuery(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'user'
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT,
        user_id INTEGER,
        view_count INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL
      );

      CREATE TABLE post_tags (
        post_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (post_id, tag_id),
        FOREIGN KEY (post_id) REFERENCES posts(id),
        FOREIGN KEY (tag_id) REFERENCES tags(id)
      );

      CREATE TABLE empty_table (
        id INTEGER PRIMARY KEY,
        val TEXT
      );
    `);

    // Insert test data
    await adapter.executeQuery(
      "INSERT INTO users (name, email, role) VALUES ('Alice', 'alice@zebraa.io', 'admin'), ('Bob', 'bob@zebraa.io', 'user');"
    );
    await adapter.executeQuery(
      "INSERT INTO posts (title, content, user_id, view_count) VALUES ('First Post', 'Hello World', 1, 100), ('Second Post', 'Testing', 1, 50);"
    );
    await adapter.executeQuery(
      "INSERT INTO tags (name, slug) VALUES ('Tech', 'tech'), ('News', 'news');"
    );
    await adapter.executeQuery("INSERT INTO post_tags (post_id, tag_id) VALUES (1, 1), (1, 2);");
  });

  afterAll(async () => {
    await adapter.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should test connection successfully with valid filepath', async () => {
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should test connection successfully with in-memory database', async () => {
    const memAdapter = new SQLiteAdapter({ filepath: ':memory:' });
    const result = await memAdapter.testConnection();
    expect(result.ok).toBe(true);
    await memAdapter.close();
  });

  it('should return error when testing connection with invalid file path', async () => {
    const invalidPath = path.join(tempDir, 'non_existent_folder', 'deep', 'invalid.db');
    const invalidAdapter = new SQLiteAdapter({ filepath: invalidPath });
    const result = await invalidAdapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    await invalidAdapter.close();
  });

  it('should fetch complete schema info including tables, columns, primary keys, and foreign keys', async () => {
    const schema = await adapter.getSchema();
    expect(schema).toBeDefined();
    expect(schema.tables.length).toBeGreaterThanOrEqual(5);

    const tableNames = schema.tables.map((t) => t.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('posts');
    expect(tableNames).toContain('tags');
    expect(tableNames).toContain('post_tags');

    // Check users table columns & PK & default value
    const usersTable = schema.tables.find((t) => t.name === 'users')!;
    expect(usersTable).toBeDefined();
    const colNames = usersTable.columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('email');
    expect(colNames).toContain('role');
    expect(usersTable.primaryKeys).toEqual(['id']);

    const roleCol = usersTable.columns.find((c) => c.name === 'role')!;
    expect(roleCol.default).toBe("'user'");

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

  it('should fetch sample rows from a table', async () => {
    const sample = await adapter.getSampleRows('users', 1);
    expect(sample.columns).toContain('id');
    expect(sample.columns).toContain('email');
    expect(sample.rowCount).toBe(1);
    expect(sample.rows.length).toBe(1);
  });

  it('should return column names even when fetching sample rows from an empty table', async () => {
    const sample = await adapter.getSampleRows('empty_table', 10);
    expect(sample.columns).toEqual(['id', 'val']);
    expect(sample.rowCount).toBe(0);
    expect(sample.rows).toEqual([]);
  });

  it('should execute SELECT query with $1, $2 parameter binding', async () => {
    const res = await adapter.executeQuery(
      'SELECT id, title FROM posts WHERE user_id = $1 AND view_count >= $2',
      {
        params: [1, 50],
      }
    );
    expect(res.columns).toEqual(['id', 'title']);
    expect(res.rowCount).toBe(2);
    expect(res.rows.length).toBe(2);
  });

  it('should execute SELECT query with ? parameter binding', async () => {
    const res = await adapter.executeQuery(
      'SELECT id, name FROM users WHERE role = ? AND email = ?',
      {
        params: ['admin', 'alice@zebraa.io'],
      }
    );
    expect(res.columns).toEqual(['id', 'name']);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0][1]).toBe('Alice');
  });

  it('should execute SELECT query with out-of-order $2, $1 parameter binding', async () => {
    const res = await adapter.executeQuery(
      'SELECT name FROM users WHERE email = $2 AND role = $1',
      {
        params: ['admin', 'alice@zebraa.io'],
      }
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0][0]).toBe('Alice');
  });

  it('should execute DML write query (INSERT / UPDATE / DELETE) and return affected row count', async () => {
    const insertRes = await adapter.executeQuery(
      "INSERT INTO tags (name, slug) VALUES ('Design', 'design')"
    );
    expect(insertRes.columns).toEqual([]);
    expect(insertRes.rows).toEqual([]);
    expect(insertRes.rowCount).toBe(1);

    const updateRes = await adapter.executeQuery(
      "UPDATE tags SET name = 'Graphic Design' WHERE slug = 'design'"
    );
    expect(updateRes.rowCount).toBe(1);

    const deleteRes = await adapter.executeQuery("DELETE FROM tags WHERE slug = 'design'");
    expect(deleteRes.rowCount).toBe(1);
  });

  it('should enforce row limit option in executeQuery', async () => {
    const res = await adapter.executeQuery('SELECT * FROM posts', { rowLimit: 1 });
    expect(res.rowCount).toBe(1);
    expect(res.rows.length).toBe(1);
  });

  it('should execute explainQuery and return plan text', async () => {
    const plan = await adapter.explainQuery("SELECT * FROM users WHERE email = 'alice@zebraa.io'");
    expect(typeof plan).toBe('string');
    expect(plan.length).toBeGreaterThan(0);
    expect(plan).toContain('users');
  });

  it('should fetch table stats including estimated row count and size in bytes', async () => {
    const stats = await adapter.getTableStats('users');
    expect(stats.estimatedRows).toBe(2);
    expect(stats.sizeBytes).toBeGreaterThan(0);

    const emptyStats = await adapter.getTableStats('empty_table');
    expect(emptyStats.estimatedRows).toBe(0);
    expect(emptyStats.sizeBytes).toBe(0);
  });

  it('should instantiate SQLiteAdapter via registry createAdapter', () => {
    const regAdapter = createAdapter('sqlite', { filepath: dbPath });
    expect(regAdapter).toBeInstanceOf(SQLiteAdapter);
  });
});
