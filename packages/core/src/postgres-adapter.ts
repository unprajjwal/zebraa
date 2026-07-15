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

export class PostgresAdapter extends DatabaseAdapter {
  private pool: Pool | null = null;
  private client: PoolClient | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
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
      await client.query('SELECT 1');
      client.release();
      await tempPool.end();

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  async getSchema(): Promise<SchemaInfo> {
    const client = await this.getOrCreateClient();
    try {
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
            default: row.column_default,
          });
        }
      }

      // Fetch PKs and FKs
      const constraintQuery = `
        SELECT
          kcu.table_name,
          kcu.column_name,
          tc.constraint_type,
          ccu.table_name as foreign_table,
          ccu.column_name as foreign_column
        FROM information_schema.key_column_usage kcu
        JOIN information_schema.table_constraints tc
          ON kcu.constraint_name = tc.constraint_name
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE kcu.table_schema NOT IN ('pg_catalog', 'information_schema')
      `;

      const constraintResult = await client.query(constraintQuery);

      for (const row of constraintResult.rows) {
        const table = tableMap.get(row.table_name);
        if (table) {
          if (row.constraint_type === 'PRIMARY KEY') {
            if (!table.primaryKeys) table.primaryKeys = [];
            table.primaryKeys.push(row.column_name);
          } else if (row.constraint_type === 'FOREIGN KEY') {
            if (!table.foreignKeys) table.foreignKeys = [];
            table.foreignKeys.push({
              column: row.column_name,
              refTable: row.foreign_table,
              refColumn: row.foreign_column,
            });
          }
        }
      }

      return { tables: Array.from(tableMap.values()) };
    } finally {
      if (client) client.release();
    }
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    const client = await this.getOrCreateClient();
    try {
      const query = `SELECT * FROM "${table}" LIMIT $1`;
      const result = await client.query(query, [limit]);

      const columns = result.fields.map((f) => f.name);
      const rows = result.rows.map((r) => Object.values(r));

      return {
        columns,
        rows,
        rowCount: result.rows.length,
      };
    } finally {
      if (client) client.release();
    }
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;

    const client = await this.getOrCreateClient();
    try {
      await client.query(`SET statement_timeout TO ${timeoutMs}`);

      const result = await client.query(sql);

      const columns = result.fields.map((f) => f.name);
      let rows = result.rows.map((r) => Object.values(r));

      if (rows.length > rowLimit) {
        rows = rows.slice(0, rowLimit);
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    } finally {
      if (client) client.release();
    }
  }

  async explainQuery(sql: string): Promise<string> {
    const client = await this.getOrCreateClient();
    try {
      const result = await client.query(`EXPLAIN ${sql}`);
      return result.rows.map((r) => Object.values(r).join(' ')).join('\n');
    } finally {
      if (client) client.release();
    }
  }

  async getTableStats(table: string): Promise<TableStats> {
    const client = await this.getOrCreateClient();
    try {
      const result = await client.query(`
        SELECT
          n_live_tup as row_count,
          pg_total_relation_size('${table}'::regclass) as size_bytes
        FROM pg_stat_user_tables
        WHERE relname = $1
      `, [table]);

      if (result.rows.length === 0) {
        return { estimatedRows: 0, sizeBytes: 0 };
      }

      const row = result.rows[0];
      return {
        estimatedRows: row.row_count || 0,
        sizeBytes: row.size_bytes || 0,
      };
    } finally {
      if (client) client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.client = null;
    }
  }

  private async getOrCreateClient(): Promise<PoolClient> {
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

    if (!this.client) {
      this.client = await this.pool.connect();
    }

    return this.client;
  }
}
