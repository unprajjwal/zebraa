import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!instance) {
    throw new Error('Database not initialized. Call initializeDatabase first.');
  }
  return instance;
}

export function initializeDatabase(): Database.Database {
  const appPath = app.getPath('userData');
  const dbPath = path.join(appPath, 'zebraa.db');

  instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');

  runMigrations();

  return instance;
}

function runMigrations(): void {
  const db = getDb();

  // Ensure migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrationsDir = path.join(import.meta.url.replace('file://', ''), '..', 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const version = parseInt(file.split('-')[0], 10);
    const alreadyRun = db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(version);

    if (!alreadyRun) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, Date.now());
    }
  }
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// Connection CRUD helpers

export interface ConnectionRow {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  secret_encrypted: Buffer;
  created_at: number;
  updated_at: number;
}

export function listConnections(): ConnectionRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM connections ORDER BY created_at DESC').all() as ConnectionRow[];
}

export function getConnection(id: string): ConnectionRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
}

export function createConnection(connection: Omit<ConnectionRow, 'created_at' | 'updated_at'>): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO connections (id, name, type, host, port, database, username, secret_encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    connection.id,
    connection.name,
    connection.type,
    connection.host,
    connection.port,
    connection.database,
    connection.username,
    connection.secret_encrypted,
    now,
    now
  );
}

export function updateConnection(id: string, updates: Partial<Omit<ConnectionRow, 'id' | 'created_at'>>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: (string | number | Buffer)[] = [];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    values.push(updates.name);
  }
  if (updates.type !== undefined) {
    setClauses.push('type = ?');
    values.push(updates.type);
  }
  if (updates.host !== undefined) {
    setClauses.push('host = ?');
    values.push(updates.host);
  }
  if (updates.port !== undefined) {
    setClauses.push('port = ?');
    values.push(updates.port);
  }
  if (updates.database !== undefined) {
    setClauses.push('database = ?');
    values.push(updates.database);
  }
  if (updates.username !== undefined) {
    setClauses.push('username = ?');
    values.push(updates.username);
  }
  if (updates.secret_encrypted !== undefined) {
    setClauses.push('secret_encrypted = ?');
    values.push(updates.secret_encrypted);
  }

  setClauses.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  const sql = `UPDATE connections SET ${setClauses.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

export function deleteConnection(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM connections WHERE id = ?').run(id);
}
