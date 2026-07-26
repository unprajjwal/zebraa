import { DatabaseAdapter } from './db-adapter.js';
import type {
  ConnectionConfig,
  SchemaInfo,
  QueryOptions,
  RowSet,
  TableStats,
  TableInfo,
  ColumnInfo,
} from './types/index.js';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_ROW_LIMIT = 1000;

export class ClickHouseAdapter extends DatabaseAdapter {
  constructor(config: ConnectionConfig) {
    super(config);
  }

  private getBaseUrl(): string {
    const protocol = this.config.ssl ? 'https' : 'http';
    const host = this.config.host || 'localhost';
    const port = this.config.port || 8123;
    const database = this.config.database || 'default';
    return `${protocol}://${host}:${port}/?database=${encodeURIComponent(database)}`;
  }

  private async request(
    sql: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<any> {
    const url = this.getBaseUrl();
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain',
    };

    if (this.config.username) {
      headers['X-ClickHouse-User'] = this.config.username;
    }
    if (this.config.password !== undefined && this.config.password !== '') {
      headers['X-ClickHouse-Key'] = this.config.password;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: sql,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText.trim() || `HTTP error ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      if (!text || text.trim() === '') {
        return {};
      }

      try {
        return JSON.parse(text);
      } catch {
        return { rawText: text };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ClickHouse request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('SELECT 1 FORMAT JSON', 5000);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  private escapeIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '\\`')}\``;
  }

  private escapeStringLiteral(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  private escapeParam(val: unknown): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? '1' : '0';
    if (typeof val === 'string') {
      return `'${this.escapeStringLiteral(val)}'`;
    }
    return `'${this.escapeStringLiteral(String(val))}'`;
  }

  private formatSqlWithParams(sql: string, params?: unknown[]): string {
    if (!params || params.length === 0) return sql;

    let index = 0;
    if (/\$\d+/.test(sql)) {
      return sql.replace(/\$(\d+)/g, (_, numStr) => {
        const idx = parseInt(numStr, 10) - 1;
        return this.escapeParam(params[idx]);
      });
    } else {
      return sql.replace(/\?/g, () => {
        const val = params[index];
        index++;
        return this.escapeParam(val);
      });
    }
  }

  async getSchema(): Promise<SchemaInfo> {
    const db = this.config.database || 'default';
    const escapedDb = this.escapeStringLiteral(db);

    // 1. Fetch tables
    const tableQuery = `SELECT name FROM system.tables WHERE database = '${escapedDb}' AND is_temporary = 0 FORMAT JSON`;
    const tableRes = await this.request(tableQuery);
    const tableRows = tableRes.data || [];

    const tableMap = new Map<string, TableInfo>();
    for (const row of tableRows) {
      const tableName = row.name;
      tableMap.set(tableName, {
        name: tableName,
        columns: [],
      });
    }

    // 2. Fetch columns
    const colQuery = `SELECT table, name, type, default_expression, is_in_primary_key FROM system.columns WHERE database = '${escapedDb}' ORDER BY table, position FORMAT JSON`;
    const colRes = await this.request(colQuery);
    const colRows = colRes.data || [];

    for (const row of colRows) {
      const tableName = row.table;
      let tableInfo = tableMap.get(tableName);
      if (!tableInfo) {
        tableInfo = { name: tableName, columns: [] };
        tableMap.set(tableName, tableInfo);
      }

      const colType = String(row.type || '');
      const isNullable = colType.startsWith('Nullable(');
      const defaultVal = row.default_expression ? String(row.default_expression) : undefined;

      const colInfo: ColumnInfo = {
        name: String(row.name),
        type: colType,
        nullable: isNullable,
        default: defaultVal,
      };

      tableInfo.columns.push(colInfo);

      const isPk = row.is_in_primary_key === 1 || row.is_in_primary_key === '1' || row.is_in_primary_key === true;
      if (isPk) {
        if (!tableInfo.primaryKeys) {
          tableInfo.primaryKeys = [];
        }
        if (!tableInfo.primaryKeys.includes(colInfo.name)) {
          tableInfo.primaryKeys.push(colInfo.name);
        }
      }
    }

    return { tables: Array.from(tableMap.values()) };
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    const safeTable = this.escapeIdentifier(table);
    const query = `SELECT * FROM ${safeTable} LIMIT ${limit} FORMAT JSON`;
    const res = await this.request(query);

    const meta = res.meta || [];
    const data = res.data || [];

    const columns = meta.map((m: { name: string }) => m.name);
    const rows = data.map((r: Record<string, unknown>) => columns.map((c: string) => r[c]));

    return {
      columns,
      rows,
      rowCount: rows.length,
    };
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;

    const formattedSql = this.formatSqlWithParams(sql, opts?.params);

    const trimmed = formattedSql.trim().replace(/;+$/, '');
    const hasFormat = /\bFORMAT\s+[A-Za-z0-9_]+$/i.test(trimmed);
    const sqlToRun = hasFormat ? trimmed : `${trimmed} FORMAT JSON`;

    const res = await this.request(sqlToRun, timeoutMs);

    if (res.meta && Array.isArray(res.meta)) {
      const columns = res.meta.map((m: { name: string }) => m.name);
      let rows = Array.isArray(res.data)
        ? res.data.map((r: Record<string, unknown>) => columns.map((c: string) => r[c]))
        : [];

      if (rows.length > rowLimit) {
        rows = rows.slice(0, rowLimit);
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    }

    return {
      columns: [],
      rows: [],
      rowCount: res.rows ?? 0,
    };
  }

  async explainQuery(sql: string): Promise<string> {
    const trimmed = sql.trim().replace(/;+$/, '');
    const query = `EXPLAIN ${trimmed} FORMAT JSON`;
    const res = await this.request(query);

    if (res.data && Array.isArray(res.data)) {
      return res.data
        .map((r: Record<string, unknown>) => (r.explain !== undefined ? String(r.explain) : Object.values(r).join(' ')))
        .join('\n');
    }

    if (res.rawText) {
      return res.rawText.trim();
    }

    return String(res);
  }

  async getTableStats(table: string): Promise<TableStats> {
    const db = this.config.database || 'default';
    const escapedDb = this.escapeStringLiteral(db);
    const escapedTable = this.escapeStringLiteral(table);

    const query = `SELECT total_rows, total_bytes FROM system.tables WHERE database = '${escapedDb}' AND name = '${escapedTable}' FORMAT JSON`;

    let estimatedRows = 0;
    let sizeBytes = 0;

    try {
      const res = await this.request(query);
      if (res.data && res.data.length > 0) {
        const row = res.data[0];
        estimatedRows = parseInt(String(row.total_rows ?? '0'), 10);
        sizeBytes = parseInt(String(row.total_bytes ?? '0'), 10);
      }
    } catch {
      // Ignore error if table not found in system.tables
    }

    if (estimatedRows === 0) {
      try {
        const safeTable = this.escapeIdentifier(table);
        const countRes = await this.request(`SELECT count() AS count FROM ${safeTable} FORMAT JSON`);
        if (countRes.data && countRes.data.length > 0) {
          estimatedRows = parseInt(String(countRes.data[0].count ?? '0'), 10);
        }
      } catch {
        // Ignore count failure
      }
    }

    return {
      estimatedRows,
      sizeBytes,
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
