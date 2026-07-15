import { PostgresAdapter } from './postgres-adapter.js';
import { AdapterType, ConnectionConfig, DBAdapter } from './types/index.js';

export function createAdapter(type: AdapterType, config: ConnectionConfig): DBAdapter {
  switch (type) {
    case 'postgres':
      return new PostgresAdapter(config);
    case 'mysql':
      throw new Error('MySQL adapter not yet implemented');
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}
