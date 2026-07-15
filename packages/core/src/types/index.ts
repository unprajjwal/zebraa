export type AdapterType = 'postgres' | 'mysql';

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface SchemaInfo {
  tables: TableInfo[];
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKeys?: string[];
  foreignKeys?: ForeignKeyInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
}

export interface ForeignKeyInfo {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface RowSet {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface QueryOptions {
  timeoutMs?: number;   // Default: 10000
  rowLimit?: number;    // Default: 1000
}

export interface TableStats {
  estimatedRows: number;
  sizeBytes: number;
}

export interface DBAdapter {
  testConnection(): Promise<{ ok: boolean; error?: string }>;
  getSchema(): Promise<SchemaInfo>;
  getSampleRows(table: string, limit?: number): Promise<RowSet>;
  executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet>;
  explainQuery(sql: string): Promise<string>;
  getTableStats(table: string): Promise<TableStats>;
  close(): Promise<void>;
}

export type NewConnectionInput = Omit<ConnectionConfig, never>;

export interface ConnectionDTO {
  id: string;
  name: string;
  type: AdapterType;
  host: string;
  port: number;
  database: string;
  username: string;
  created_at: number;
  updated_at: number;
}
