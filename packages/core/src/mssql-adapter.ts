import mssql from 'mssql';
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

export class MSSQLAdapter extends DatabaseAdapter {
  private pool: mssql.ConnectionPool | null = null;

  constructor(config: ConnectionConfig) {
    super({
      ...config,
      port: config.port || 1433,
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const validation = validateConnectionConfig('mssql', this.config);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    let tempPool: mssql.ConnectionPool | null = null;
    try {
      const sqlConfig: mssql.config = {
        server: this.config.host || 'localhost',
        port: this.config.port || 1433,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        options: {
          encrypt: this.config.ssl ?? false,
          trustServerCertificate: true,
          connectTimeout: 5000,
          requestTimeout: 5000,
        },
      };

      tempPool = new mssql.ConnectionPool(sqlConfig);
      await tempPool.connect();
      await tempPool.request().query('SELECT 1');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    } finally {
      if (tempPool) {
        try {
          await tempPool.close();
        } catch {}
      }
    }
  }

  private async getPool(): Promise<mssql.ConnectionPool> {
    if (!this.pool || !this.pool.connected) {
      const sqlConfig: mssql.config = {
        server: this.config.host || 'localhost',
        port: this.config.port || 1433,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        options: {
          encrypt: this.config.ssl ?? false,
          trustServerCertificate: true,
          connectTimeout: 5000,
          requestTimeout: 10000,
        },
        pool: {
          max: 10,
          min: 0,
          idleTimeoutMillis: 30000,
        },
      };

      this.pool = new mssql.ConnectionPool(sqlConfig);
      await this.pool.connect();
    }
    return this.pool;
  }

  async getSchema(): Promise<SchemaInfo> {
    const pool = await this.getPool();

    // 1. Fetch tables and columns querying INFORMATION_SCHEMA.TABLES and INFORMATION_SCHEMA.COLUMNS
    const tableQuery = `
      SELECT
        t.TABLE_NAME as table_name,
        c.COLUMN_NAME as column_name,
        c.DATA_TYPE as data_type,
        c.IS_NULLABLE as is_nullable,
        c.COLUMN_DEFAULT as column_default
      FROM INFORMATION_SCHEMA.TABLES t
      LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
        ON t.TABLE_CATALOG = c.TABLE_CATALOG
       AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
       AND t.TABLE_NAME = c.TABLE_NAME
      WHERE t.TABLE_TYPE = 'BASE TABLE'
      ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
    `;

    const tableResult = await pool.request().query(tableQuery);

    const tableMap = new Map<string, TableInfo>();
    for (const row of tableResult.recordset) {
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
          default: row.column_default !== null && row.column_default !== undefined ? String(row.column_default) : undefined,
        });
      }
    }

    // 2. Fetch Primary Keys querying sys.indexes, sys.index_columns, sys.columns, sys.tables
    const pkQuery = `
      SELECT
        t.name AS table_name,
        c.name AS column_name
      FROM sys.indexes i
      JOIN sys.tables t ON i.object_id = t.object_id
      JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE i.is_primary_key = 1
        AND t.is_ms_shipped = 0
      ORDER BY t.name, ic.key_ordinal
    `;

    const pkResult = await pool.request().query(pkQuery);
    for (const row of pkResult.recordset) {
      const table = tableMap.get(row.table_name as string);
      if (table) {
        if (!table.primaryKeys) table.primaryKeys = [];
        if (!table.primaryKeys.includes(row.column_name as string)) {
          table.primaryKeys.push(row.column_name as string);
        }
      }
    }

    // 3. Fetch Foreign Keys querying sys.foreign_keys, sys.foreign_key_columns, sys.tables, sys.columns
    const fkQuery = `
      SELECT
        parent_t.name AS table_name,
        parent_c.name AS column_name,
        ref_t.name AS foreign_table,
        ref_c.name AS foreign_column
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      JOIN sys.tables parent_t ON fkc.parent_object_id = parent_t.object_id
      JOIN sys.columns parent_c ON fkc.parent_object_id = parent_c.object_id AND fkc.parent_column_id = parent_c.column_id
      JOIN sys.tables ref_t ON fkc.referenced_object_id = ref_t.object_id
      JOIN sys.columns ref_c ON fkc.referenced_object_id = ref_c.object_id AND fkc.referenced_column_id = ref_c.column_id
      WHERE parent_t.is_ms_shipped = 0
      ORDER BY parent_t.name, fkc.constraint_column_id
    `;

    const fkResult = await pool.request().query(fkQuery);
    for (const row of fkResult.recordset) {
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
    const pool = await this.getPool();
    const safeTable = `[${table.replace(/\]/g, ']]')}]`;
    const query = `SELECT TOP (${limit}) * FROM ${safeTable}`;

    const request = pool.request();
    const result = await request.query(query);

    const recordset = result.recordset || [];
    const columns = recordset.columns ? Object.keys(recordset.columns) : recordset.length > 0 ? Object.keys(recordset[0]) : [];
    const rows = recordset.map((r: Record<string, unknown>) => Object.values(r));

    return {
      columns,
      rows,
      rowCount: rows.length,
    };
  }

  private prepareSqlAndRequest(
    pool: mssql.ConnectionPool,
    sql: string,
    params?: unknown[]
  ): { normalizedSql: string; request: mssql.Request } {
    const request = pool.request();
    if (!params || params.length === 0) {
      return { normalizedSql: sql, request };
    }

    let paramIndex = 1;
    let normalizedSql = sql;

    if (/\$(\d+)/.test(sql)) {
      normalizedSql = sql.replace(/\$(\d+)/g, (_, num) => `@p${num}`);
      for (let i = 0; i < params.length; i++) {
        request.input(`p${i + 1}`, params[i]);
      }
    } else if (/\?/.test(sql)) {
      normalizedSql = sql.replace(/\?/g, () => {
        const name = `p${paramIndex}`;
        paramIndex++;
        return `@${name}`;
      });
      for (let i = 0; i < params.length; i++) {
        request.input(`p${i + 1}`, params[i]);
      }
    } else {
      for (let i = 0; i < params.length; i++) {
        request.input(`p${i + 1}`, params[i]);
      }
    }

    return { normalizedSql, request };
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;
    const pool = await this.getPool();

    const { normalizedSql, request } = this.prepareSqlAndRequest(pool, sql, opts?.params);
    (request as any).setTimeout?.(timeoutMs);

    const result = await request.query(normalizedSql);

    if (result.recordset) {
      const recordset = result.recordset;
      const columns = recordset.columns ? Object.keys(recordset.columns) : recordset.length > 0 ? Object.keys(recordset[0]) : [];
      let rows = recordset.map((r: Record<string, unknown>) => Object.values(r));

      if (rows.length > rowLimit) {
        rows = rows.slice(0, rowLimit);
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    } else {
      const affectedRows = result.rowsAffected ? result.rowsAffected.reduce((a, b) => a + b, 0) : 0;
      return {
        columns: [],
        rows: [],
        rowCount: affectedRows,
      };
    }
  }

  async explainQuery(sql: string): Promise<string> {
    const pool = await this.getPool();
    const request = pool.request();

    try {
      await request.query('SET SHOWPLAN_TEXT ON');
      const result = await request.query(sql);
      await request.query('SET SHOWPLAN_TEXT OFF');

      if (result.recordset && result.recordset.length > 0) {
        return result.recordset
          .map((r: Record<string, unknown>) => String(r.StmtText || Object.values(r).join(' ')))
          .join('\n');
      }
      return 'Query executed plan generated.';
    } catch (err) {
      try {
        await request.query('SET SHOWPLAN_TEXT OFF');
      } catch {}
      const message = err instanceof Error ? err.message : String(err);
      return `Explain Plan Error: ${message}`;
    }
  }

  async getTableStats(table: string): Promise<TableStats> {
    const pool = await this.getPool();
    const request = pool.request();
    request.input('tableName', table);

    const statQuery = `
      SELECT
        SUM(sp.rows) AS row_count,
        SUM(sa.total_pages) * 8 * 1024 AS size_bytes
      FROM sys.tables st
      JOIN sys.partitions sp ON st.object_id = sp.object_id
      JOIN sys.allocation_units sa ON sp.partition_id = sa.container_id
      WHERE st.name = @tableName AND sp.index_id IN (0, 1)
      GROUP BY st.name
    `;

    const result = await request.query(statQuery);

    let estimatedRows = 0;
    let sizeBytes = 0;

    if (result.recordset && result.recordset.length > 0) {
      estimatedRows = parseInt(String(result.recordset[0].row_count ?? '0'), 10);
      sizeBytes = parseInt(String(result.recordset[0].size_bytes ?? '0'), 10);
    }

    if (estimatedRows === 0) {
      try {
        const safeTable = `[${table.replace(/\]/g, ']]')}]`;
        const countRes = await pool.request().query(`SELECT COUNT(*) as count FROM ${safeTable}`);
        if (countRes.recordset && countRes.recordset.length > 0) {
          estimatedRows = parseInt(String(countRes.recordset[0].count ?? '0'), 10);
        }
      } catch {}
    }

    return {
      estimatedRows,
      sizeBytes,
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }
}
