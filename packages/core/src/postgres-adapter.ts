import { Pool, PoolClient } from 'pg';
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

import { validateConnectionConfig } from './validation.js';

export class PostgresAdapter extends DatabaseAdapter {
  private pool: Pool | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const validation = validateConnectionConfig('postgres', this.config);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    try {
      const tempPool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        connectionTimeoutMillis: 5000,
      });

      const client = await tempPool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
        await tempPool.end();
      }

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        connectionTimeoutMillis: 5000,
      });
    }
    return this.pool;
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async getSchema(): Promise<SchemaInfo> {
    return this.withClient(async (client) => {
      // 1. Fetch tables
      const tableQuery = `
        SELECT
          t.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable = 'YES' as is_nullable,
          c.column_default
        FROM information_schema.tables t
        LEFT JOIN information_schema.columns c
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name, c.ordinal_position
      `;

      const result = await client.query(tableQuery);

      const tableMap = new Map<string, TableInfo>();
      for (const row of result.rows) {
        if (!tableMap.has(row.table_name)) {
          tableMap.set(row.table_name, {
            name: row.table_name,
            columns: [],
          });
        }

        if (row.column_name) {
          tableMap.get(row.table_name)!.columns.push({
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable,
            default: row.column_default ?? undefined,
          });
        }
      }

      // 2. Fetch Primary Keys cleanly
      const pkQuery = `
        SELECT
          kcu.table_name,
          kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY kcu.table_name, kcu.ordinal_position
      `;

      const pkResult = await client.query(pkQuery);
      for (const row of pkResult.rows) {
        const table = tableMap.get(row.table_name);
        if (table) {
          if (!table.primaryKeys) table.primaryKeys = [];
          if (!table.primaryKeys.includes(row.column_name)) {
            table.primaryKeys.push(row.column_name);
          }
        }
      }

      // 3. Fetch Foreign Keys cleanly
      const fkQuery = `
        SELECT
          kcu.table_name,
          kcu.column_name,
          ccu.table_name as foreign_table,
          ccu.column_name as foreign_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
      `;

      const fkResult = await client.query(fkQuery);
      for (const row of fkResult.rows) {
        const table = tableMap.get(row.table_name);
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
              column: row.column_name,
              refTable: row.foreign_table,
              refColumn: row.foreign_column,
            });
          }
        }
      }

      return { tables: Array.from(tableMap.values()) };
    });
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    return this.withClient(async (client) => {
      const safeTable = `"${table.replace(/"/g, '""')}"`;
      const query = `SELECT * FROM ${safeTable} LIMIT $1`;
      const result = await client.query(query, [limit]);

      const columns = result.fields ? result.fields.map((f: { name: string }) => f.name) : [];
      const rows = result.rows ? result.rows.map((r: Record<string, unknown>) => Object.values(r)) : [];

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    });
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;

    return this.withClient(async (client) => {
      await client.query(`SET statement_timeout TO ${timeoutMs}`);

      const result = await client.query(sql, opts?.params);

      // Handle multi-statement results if array returned, pick last
      const queryResult = Array.isArray(result) ? result[result.length - 1] : result;

      const isSelect = queryResult.command === 'SELECT';
      const columns = queryResult.fields ? queryResult.fields.map((f: { name: string }) => f.name) : [];
      let rows = queryResult.rows ? queryResult.rows.map((r: Record<string, unknown>) => Object.values(r)) : [];

      if (isSelect && rows.length > rowLimit) {
        rows = rows.slice(0, rowLimit);
      }

      const rowCount = isSelect ? rows.length : (queryResult.rowCount ?? rows.length);

      return {
        columns,
        rows,
        rowCount,
      };
    });
  }

  async explainQuery(sql: string): Promise<string> {
    return this.withClient(async (client) => {
      const result = await client.query(`EXPLAIN ${sql}`);
      return result.rows.map((r: Record<string, unknown>) => Object.values(r).join(' ')).join('\n');
    });
  }

  async getTableStats(table: string): Promise<TableStats> {
    return this.withClient(async (client) => {
      const safeTable = table.replace(/'/g, "''");
      const statResult = await client.query(
        `
        SELECT
          n_live_tup as row_count,
          pg_total_relation_size('${safeTable}'::regclass) as size_bytes
        FROM pg_stat_user_tables
        WHERE relname = $1
      `,
        [table]
      );

      let estimatedRows = 0;
      let sizeBytes = 0;

      if (statResult.rows.length > 0) {
        estimatedRows = parseInt(statResult.rows[0].row_count ?? '0', 10);
        sizeBytes = parseInt(statResult.rows[0].size_bytes ?? '0', 10);
      }

      // If pg_stat_user_tables hasn't updated row count yet, fall back to exact COUNT(*)
      if (estimatedRows === 0) {
        try {
          const safeIdentifier = `"${table.replace(/"/g, '""')}"`;
          const countResult = await client.query(`SELECT COUNT(*) as count FROM ${safeIdentifier}`);
          if (countResult.rows.length > 0) {
            estimatedRows = parseInt(countResult.rows[0].count ?? '0', 10);
          }
        } catch {
          // Ignore count failure if table does not exist
        }
      }

      return {
        estimatedRows,
        sizeBytes,
      };
    });
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
