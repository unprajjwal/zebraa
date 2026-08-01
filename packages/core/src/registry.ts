import { PostgresAdapter } from './postgres-adapter.js';
import { MySQLAdapter } from './mysql-adapter.js';
import { MariaDBAdapter } from './mariadb-adapter.js';
import { MSSQLAdapter } from './mssql-adapter.js';
import { MongoDBAdapter } from './mongodb-adapter.js';
import { RedisAdapter } from './redis-adapter.js';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { ClickHouseAdapter } from './clickhouse-adapter.js';
import { AdapterType, ConnectionConfig, DBAdapter } from './types/index.js';
import { assertValidConnectionConfig } from './validation.js';

export function createAdapter(type: AdapterType, config: ConnectionConfig): DBAdapter {
  const finalConfig = { ...config };
  if (type !== 'sqlite' && finalConfig.host && finalConfig.host.trim().toLowerCase() === 'localhost') {
    finalConfig.host = '127.0.0.1';
  }
  assertValidConnectionConfig(type, finalConfig);

  switch (type) {
    case 'postgres':
      return new PostgresAdapter(finalConfig);
    case 'mysql':
      return new MySQLAdapter(finalConfig);
    case 'mariadb':
      return new MariaDBAdapter(finalConfig);
    case 'mssql':
      return new MSSQLAdapter(finalConfig);
    case 'mongodb':
      return new MongoDBAdapter(finalConfig);
    case 'redis':
      return new RedisAdapter(finalConfig);
    case 'sqlite':
      return new SQLiteAdapter(finalConfig);
    case 'clickhouse':
      return new ClickHouseAdapter(finalConfig);
    default:
      throw new Error(`Adapter for database type '${type}' is not implemented yet`);
  }
}

