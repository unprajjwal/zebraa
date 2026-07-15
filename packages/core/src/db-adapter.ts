import { DBAdapter, ConnectionConfig, SchemaInfo, QueryOptions, RowSet, TableStats } from './types/index.js';

export class DatabaseAdapter {
  protected config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    throw new Error('Must be implemented by subclass');
  }

  async getSchema(): Promise<SchemaInfo> {
    throw new Error('Must be implemented by subclass');
  }

  async getSampleRows(table: string, limit?: number): Promise<RowSet> {
    throw new Error('Must be implemented by subclass');
  }

  async executeQuery(sql: string, opts?: QueryOptions): Promise<RowSet> {
    throw new Error('Must be implemented by subclass');
  }

  async explainQuery(sql: string): Promise<string> {
    throw new Error('Must be implemented by subclass');
  }

  async getTableStats(table: string): Promise<TableStats> {
    throw new Error('Must be implemented by subclass');
  }

  async close(): Promise<void> {
    throw new Error('Must be implemented by subclass');
  }
}

export { DBAdapter, ConnectionConfig, SchemaInfo, QueryOptions, RowSet, TableStats } from './types/index.js';
