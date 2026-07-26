import { PostgresAdapter } from './postgres-adapter.js';
import { MySQLAdapter } from './mysql-adapter.js';
import { MariaDBAdapter } from './mariadb-adapter.js';
import { MSSQLAdapter } from './mssql-adapter.js';
import { MongoDBAdapter } from './mongodb-adapter.js';
import { RedisAdapter } from './redis-adapter.js';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { ClickHouseAdapter } from './clickhouse-adapter.js';
import { AdapterType, ConnectionConfig, DBAdapter } from './types/index.js';

export function createAdapter(type: AdapterType, config: ConnectionConfig): DBAdapter {
  switch (type) {
    case 'postgres':
      return new PostgresAdapter(config);
    case 'mysql':
      return new MySQLAdapter(config);
    case 'mariadb':
      return new MariaDBAdapter(config);
    case 'mssql':
      return new MSSQLAdapter(config);
    case 'mongodb':
      return new MongoDBAdapter(config);
    case 'redis':
      return new RedisAdapter(config);
    case 'sqlite':
      return new SQLiteAdapter(config);
    case 'clickhouse':
      return new ClickHouseAdapter(config);
    default:
      throw new Error(`Adapter for database type '${type}' is not implemented yet`);
  }
}

