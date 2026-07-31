import type { AdapterType, ConnectionConfig } from './types/index.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const VALID_ADAPTER_TYPES: AdapterType[] = [
  'postgres',
  'mysql',
  'sqlite',
  'mariadb',
  'mssql',
  'mongodb',
  'redis',
  'clickhouse',
];

export function validateConnectionConfig(
  type: AdapterType,
  config?: Partial<ConnectionConfig> | null
): ValidationResult {
  if (!type || !VALID_ADAPTER_TYPES.includes(type)) {
    return { valid: false, error: `Invalid or unsupported database type: '${type}'` };
  }

  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Connection configuration is required' };
  }

  if (type === 'sqlite') {
    const dbPath = (config.filepath || config.database || '').trim();
    if (!dbPath) {
      return { valid: false, error: 'Database file path is required for SQLite' };
    }
    return { valid: true };
  }

  if (type === 'mongodb' && config.filepath && config.filepath.trim().length > 0) {
    return { valid: true };
  }

  // Host validation
  if (config.host === undefined || config.host === null || typeof config.host !== 'string' || config.host.trim() === '') {
    return { valid: false, error: 'Host is required' };
  }

  // Port validation
  if (config.port === undefined || config.port === null || (typeof config.port === 'string' && (config.port as string).trim() === '')) {
    return { valid: false, error: 'Port is required' };
  }
  const portNum = typeof config.port === 'number' ? config.port : Number(config.port);
  if (isNaN(portNum) || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { valid: false, error: 'Port must be a valid integer between 1 and 65535' };
  }

  // Database name validation
  if (type !== 'redis') {
    if (config.database === undefined || config.database === null || typeof config.database !== 'string' || config.database.trim() === '') {
      return { valid: false, error: 'Database name is required' };
    }
  }

  // Username validation
  if (type === 'postgres' || type === 'mysql' || type === 'mariadb' || type === 'mssql') {
    if (config.username === undefined || config.username === null || typeof config.username !== 'string' || config.username.trim() === '') {
      return { valid: false, error: 'Username is required' };
    }
  }

  return { valid: true };
}

export function assertValidConnectionConfig(
  type: AdapterType,
  config?: Partial<ConnectionConfig> | null
): void {
  const result = validateConnectionConfig(type, config);
  if (!result.valid) {
    throw new Error(result.error);
  }
}
