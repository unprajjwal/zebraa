import mysql from 'mysql2/promise';
import { DatabaseAdapter } from './db-adapter.js';
import type {
  ConnectionConfig,
  SchemaInfo,
  QueryOptions,
  RowSet,
  TableStats,
  TableInfo,
} from './types/index.js';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_ROW_LIMIT = 1000;

export class MySQLAdapter extends DatabaseAdapter {
  private pool: mysql.Pool | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const connection = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        connectTimeout: 5000,
      });

      try {
        await connection.query('SELECT 1');
      } finally {
        await connection.end();
      }

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  private getPool(): mysql.Pool {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        connectTimeout: 5000,
        waitForConnections: true,
        connectionLimit: 10,
        multipleStatements: true,
      });
    }
    return this.pool;
  }

  async getSchema(): Promise<SchemaInfo> {
    const pool = this.getPool();

    // 1. Fetch tables and columns
    const tableQuery = `
      SELECT
        t.TABLE_NAME as table_name,
        c.COLUMN_NAME as column_name,
        c.DATA_TYPE as data_type,
        c.IS_NULLABLE as is_nullable,
        c.COLUMN_DEFAULT as column_default
      FROM information_schema.tables t
      LEFT JOIN information_schema.columns c
        ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ?
        AND t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
    `;

    const [tableRows] = await pool.query<mysql.RowDataPacket[]>(tableQuery, [
      this.config.database,
    ]);

    const tableMap = new Map<string, TableInfo>();
    for (const row of tableRows) {
      const tableName = row.table_name as string;
      if (!tableMap.has(tableName)) {
        tableMap.set(tableName, {
          name: tableName,
          columns: [],
        });
      }

      if (row.column_name) {
        tableMap.get(tableName)!.columns.push({
          name: row.column_name as string,
          type: row.data_type as string,
          nullable: row.is_nullable === 'YES',
          default: row.column_default !== null ? String(row.column_default) : undefined,
        });
      }
    }

    // 2. Fetch Primary Keys
    const pkQuery = `
      SELECT
        kcu.TABLE_NAME as table_name,
        kcu.COLUMN_NAME as column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       AND tc.TABLE_NAME = kcu.TABLE_NAME
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.TABLE_SCHEMA = ?
      ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION
    `;

    const [pkRows] = await pool.query<mysql.RowDataPacket[]>(pkQuery, [this.config.database]);
    for (const row of pkRows) {
      const table = tableMap.get(row.table_name as string);
      if (table) {
        if (!table.primaryKeys) table.primaryKeys = [];
        if (!table.primaryKeys.includes(row.column_name as string)) {
          table.primaryKeys.push(row.column_name as string);
        }
      }
    }

    // 3. Fetch Foreign Keys
    const fkQuery = `
      SELECT
        kcu.TABLE_NAME as table_name,
        kcu.COLUMN_NAME as column_name,
        kcu.REFERENCED_TABLE_NAME as foreign_table,
        kcu.REFERENCED_COLUMN_NAME as foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       AND tc.TABLE_NAME = kcu.TABLE_NAME
      WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND tc.TABLE_SCHEMA = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
    `;

    const [fkRows] = await pool.query<mysql.RowDataPacket[]>(fkQuery, [this.config.database]);
    for (const row of fkRows) {
      const table = tableMap.get(row.table_name as string);
      if (table) {
        if (!table.foreignKeys) table.foreignKeys = [];
        const exists = table.foreignKeys.some(
          (fk) =>
            fk.column === row.column_name &&
            fk.refTable === row.foreign_table &&
            fk.refColumn === row.foreign_column
        );
        if (!exists) {
          table.foreignKeys.push({
            column: row.column_name as string,
            refTable: row.foreign_table as string,
            refColumn: row.foreign_column as string,
          });
        }
      }
    }

    return { tables: Array.from(tableMap.values()) };
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    const pool = this.getPool();
    const safeTable = `\`${table.replace(/`/g, '``')}\``;
    const query = `SELECT * FROM ${safeTable} LIMIT ?`;

    const [rows, fields] = await pool.query<mysql.RowDataPacket[]>(query, [limit]);

    const columns = fields ? fields.map((f) => f.name) : [];
    const formattedRows = Array.isArray(rows)
      ? rows.map((r) => Object.values(r))
      : [];

    return {
      columns,
      rows: formattedRows,
      rowCount: formattedRows.length,
    };
  }

  private normalizeSqlParameters(sql: string): string {
    // Converts Postgres-style $1, $2 parameters to MySQL ? if present
    return sql.replace(/\$(\d+)/g, '?');
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;
    const pool = this.getPool();

    const normalizedSql = this.normalizeSqlParameters(sql);
    const params = opts?.params ?? [];

    const [result, fields] = await pool.query({
      sql: normalizedSql,
      values: params,
      timeout: timeoutMs,
    });

    if (fields && Array.isArray(fields) && fields.length > 0) {
      // It's a SELECT query returning rows
      const columns = fields.map((f) => f.name);
      let rows = Array.isArray(result)
        ? (result as mysql.RowDataPacket[]).map((r) => Object.values(r))
        : [];

      if (rows.length > rowLimit) {
        rows = rows.slice(0, rowLimit);
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    } else {
      // DML or query returning result header
      const header = result as mysql.ResultSetHeader;
      const affectedRows = header?.affectedRows ?? 0;

      return {
        columns: [],
        rows: [],
        rowCount: affectedRows,
      };
    }
  }

  async explainQuery(sql: string): Promise<string> {
    const pool = this.getPool();
    const normalizedSql = this.normalizeSqlParameters(sql);

    const [rows] = await pool.query<mysql.RowDataPacket[]>(`EXPLAIN ${normalizedSql}`);

    if (Array.isArray(rows)) {
      return rows
        .map((r) =>
          Object.entries(r)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' | ')
        )
        .join('\n');
    }
    return String(rows);
  }

  async getTableStats(table: string): Promise<TableStats> {
    const pool = this.getPool();

    const statQuery = `
      SELECT
        TABLE_ROWS as row_count,
        (DATA_LENGTH + INDEX_LENGTH) as size_bytes
      FROM information_schema.tables
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `;

    const [rows] = await pool.query<mysql.RowDataPacket[]>(statQuery, [
      this.config.database,
      table,
    ]);

    let estimatedRows = 0;
    let sizeBytes = 0;

    if (Array.isArray(rows) && rows.length > 0) {
      estimatedRows = parseInt(String(rows[0].row_count ?? '0'), 10);
      sizeBytes = parseInt(String(rows[0].size_bytes ?? '0'), 10);
    }

    if (estimatedRows === 0) {
      try {
        const safeTable = `\`${table.replace(/`/g, '``')}\``;
        const [countRows] = await pool.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) as count FROM ${safeTable}`
        );
        if (Array.isArray(countRows) && countRows.length > 0) {
          estimatedRows = parseInt(String(countRows[0].count ?? '0'), 10);
        }
      } catch {
        // Ignore count error if table doesn't exist
      }
    }

    return {
      estimatedRows,
      sizeBytes,
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
