export { createAdapter } from './registry.js';
export type { AdapterType, ConnectionConfig, SchemaInfo, TableInfo, ColumnInfo, ForeignKeyInfo, RowSet, QueryOptions, TableStats, DBAdapter, NewConnectionInput, ConnectionDTO } from './types/index.js';
export { PostgresAdapter } from './postgres-adapter.js';
export { DatabaseAdapter } from './db-adapter.js';
