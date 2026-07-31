import Database from 'better-sqlite3';
import { DatabaseAdapter } from './db-adapter.js';
import type {
  ConnectionConfig,
  SchemaInfo,
  QueryOptions,
  RowSet,
  TableStats,
  TableInfo,
  ColumnInfo,
  ForeignKeyInfo,
} from './types/index.js';

const DEFAULT_ROW_LIMIT = 1000;

import { validateConnectionConfig } from './validation.js';

export class SQLiteAdapter extends DatabaseAdapter {
  private db: Database.Database | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  private getFilename(): string {
    return this.config.filepath || this.config.database || ':memory:';
  }

  private getDb(): Database.Database {
    if (!this.db) {
      const filename = this.getFilename();
      this.db = new Database(filename);
    }
    return this.db;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const validation = validateConnectionConfig('sqlite', this.config);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    try {
      if (this.db) {
        this.db.prepare('SELECT 1').get();
        return { ok: true };
      }

      const filename = this.getFilename();
      const tempDb = new Database(filename, { readonly: false });
      try {
        tempDb.prepare('SELECT 1').get();
      } finally {
        tempDb.close();
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  async getSchema(): Promise<SchemaInfo> {
    const db = this.getDb();

    // 1. Query sqlite_master to find base tables (excluding internal sqlite_% tables)
    const tablesQuery = `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;
    const tableRows = db.prepare(tablesQuery).all() as { name: string }[];

    const tables: TableInfo[] = [];

    for (const { name: tableName } of tableRows) {
      const safeTableName = `"${tableName.replace(/"/g, '""')}"`;

      // 2. Query PRAGMA table_info(tableName) for column specs and primary keys
      const columnsInfo = db
        .prepare(`PRAGMA table_info(${safeTableName})`)
        .all() as {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];

      const columns: ColumnInfo[] = [];
      const pkCandidates: { name: string; pkRank: number }[] = [];

      for (const col of columnsInfo) {
        columns.push({
          name: col.name,
          type: col.type,
          nullable: col.notnull === 0,
          default: col.dflt_value !== null && col.dflt_value !== undefined ? String(col.dflt_value) : undefined,
        });

        if (col.pk > 0) {
          pkCandidates.push({ name: col.name, pkRank: col.pk });
        }
      }

      // Sort primary key columns by rank (for composite PK ordering)
      pkCandidates.sort((a, b) => a.pkRank - b.pkRank);
      const primaryKeys = pkCandidates.length > 0 ? pkCandidates.map((p) => p.name) : undefined;

      // 3. Query PRAGMA foreign_key_list(tableName) for foreign keys
      const fkList = db
        .prepare(`PRAGMA foreign_key_list(${safeTableName})`)
        .all() as {
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }[];

      const foreignKeys: ForeignKeyInfo[] = fkList.map((fk) => ({
        column: fk.from,
        refTable: fk.table,
        refColumn: fk.to,
      }));

      const tableInfo: TableInfo = {
        name: tableName,
        columns,
      };

      if (primaryKeys && primaryKeys.length > 0) {
        tableInfo.primaryKeys = primaryKeys;
      }

      if (foreignKeys.length > 0) {
        tableInfo.foreignKeys = foreignKeys;
      }

      tables.push(tableInfo);
    }

    return { tables };
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    const db = this.getDb();
    const safeTable = `"${table.replace(/"/g, '""')}"`;
    const stmt = db.prepare(`SELECT * FROM ${safeTable} LIMIT ?`);

    const columns = stmt.columns().map((c) => c.name);
    const rawRows = stmt.all(limit) as Record<string, unknown>[];
    const rows = rawRows.map((r) => Object.values(r));

    return {
      columns,
      rows,
      rowCount: rows.length,
    };
  }

  private transformSqlAndParams(
    sql: string,
    params?: unknown[]
  ): { sql: string; params: unknown[] } {
    if (!params || params.length === 0) {
      return { sql, params: [] };
    }

    const dollarRegex = /\$(\d+)/g;
    const matches = [...sql.matchAll(dollarRegex)];

    if (matches.length > 0) {
      const reorderedParams: unknown[] = [];
      for (const match of matches) {
        const index = parseInt(match[1], 10) - 1;
        reorderedParams.push(params[index]);
      }
      const normalizedSql = sql.replace(dollarRegex, '?');
      return { sql: normalizedSql, params: reorderedParams };
    }

    return { sql, params: [...params] };
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;
    const db = this.getDb();

    const { sql: finalSql, params } = this.transformSqlAndParams(sql, opts?.params);

    let stmt: Database.Statement;
    try {
      stmt = db.prepare(finalSql);
    } catch (err) {
      // Fallback for multi-statement scripts if params are empty
      if (params.length === 0) {
        db.exec(finalSql);
        return {
          columns: [],
          rows: [],
          rowCount: 0,
        };
      }
      throw err;
    }

    if (stmt.reader) {
      // SELECT or other data-returning query
      const columns = stmt.columns().map((c) => c.name);
      const rawRows = stmt.all(...params) as Record<string, unknown>[];
      let rows = rawRows.map((r) => Object.values(r));

      if (rows.length > rowLimit) {
        rows = rows.slice(0, rowLimit);
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    } else {
      // DML statement (INSERT, UPDATE, DELETE, etc.)
      const result = stmt.run(...params);
      return {
        columns: [],
        rows: [],
        rowCount: result.changes,
      };
    }
  }

  async explainQuery(sql: string): Promise<string> {
    const db = this.getDb();
    const { sql: finalSql } = this.transformSqlAndParams(sql);
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${finalSql}`).all() as Record<string, unknown>[];

    return rows
      .map((r) =>
        Object.entries(r)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' | ')
      )
      .join('\n');
  }

  async getTableStats(table: string): Promise<TableStats> {
    const db = this.getDb();
    const safeTable = `"${table.replace(/"/g, '""')}"`;

    let estimatedRows = 0;
    try {
      const countRow = db.prepare(`SELECT COUNT(*) as count FROM ${safeTable}`).get() as {
        count: number;
      };
      estimatedRows = countRow ? countRow.count : 0;
    } catch {
      // Table may not exist
    }

    let sizeBytes = 0;
    try {
      const row = db
        .prepare('SELECT SUM(pgsize) as size FROM dbstat WHERE name = ?')
        .get(table) as { size: number | null };
      if (row && row.size !== null) {
        sizeBytes = Number(row.size);
      }
    } catch {
      // Fallback: estimate based on sample row sizes if dbstat is unavailable
      if (estimatedRows > 0) {
        const sample = db
          .prepare(`SELECT * FROM ${safeTable} LIMIT 100`)
          .all() as Record<string, unknown>[];
        if (sample.length > 0) {
          let totalSampleBytes = 0;
          for (const r of sample) {
            for (const val of Object.values(r)) {
              if (val === null || val === undefined) {
                totalSampleBytes += 1;
              } else if (typeof val === 'number') {
                totalSampleBytes += 8;
              } else if (typeof val === 'string') {
                totalSampleBytes += Buffer.byteLength(val, 'utf8');
              } else if (Buffer.isBuffer(val)) {
                totalSampleBytes += val.length;
              } else {
                totalSampleBytes += Buffer.byteLength(JSON.stringify(val), 'utf8');
              }
            }
          }
          const avgRowBytes = totalSampleBytes / sample.length;
          sizeBytes = Math.round(avgRowBytes * estimatedRows);
        }
      }
    }

    return {
      estimatedRows,
      sizeBytes,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
