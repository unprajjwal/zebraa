import { Redis } from 'ioredis';
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

const DEFAULT_ROW_LIMIT = 1000;

import { validateConnectionConfig } from './validation.js';

export class RedisAdapter extends DatabaseAdapter {
  private client: Redis | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const validation = validateConnectionConfig('redis', this.config);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    let tempClient: Redis | null = null;
    try {
      tempClient = new Redis({
        host: this.config.host || 'localhost',
        port: this.config.port || 6379,
        password: this.config.password,
        db: parseInt(String(this.config.database || '0'), 10) || 0,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      tempClient.on('error', () => {});

      await tempClient.connect();
      const ping = await tempClient.ping();
      if (ping === 'PONG') {
        return { ok: true };
      }
      return { ok: false, error: `Unexpected response: ${ping}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    } finally {
      if (tempClient) {
        await tempClient.quit().catch(() => {});
      }
    }
  }

  private async getClient(): Promise<Redis> {
    if (!this.client) {
      this.client = new Redis({
        host: this.config.host || 'localhost',
        port: this.config.port || 6379,
        password: this.config.password,
        db: parseInt(String(this.config.database || '0'), 10) || 0,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      this.client.on('error', () => {});
      await this.client.connect();
    }
    return this.client;
  }

  private async scanKeys(pattern: string = '*', maxKeys: number = 1000): Promise<string[]> {
    const client = await this.getClient();
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, foundKeys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...foundKeys);
      if (keys.length >= maxKeys) break;
    } while (cursor !== '0');

    return keys.slice(0, maxKeys);
  }

  async getSchema(): Promise<SchemaInfo> {
    const client = await this.getClient();
    const keys = await this.scanKeys('*', 500);

    const patternMap = new Map<string, { type: string; keys: string[] }>();

    for (const key of keys) {
      const type = await client.type(key);
      const prefixMatch = key.match(/^([a-zA-Z0-9_-]+):/);
      const patternName = prefixMatch ? `${prefixMatch[1]}:*` : key;

      if (!patternMap.has(patternName)) {
        patternMap.set(patternName, { type, keys: [] });
      }
      patternMap.get(patternName)!.keys.push(key);
    }

    const tables: TableInfo[] = [];

    // Always include a base "keys" virtual table
    tables.push({
      name: 'keys',
      columns: [
        { name: 'key', type: 'string', nullable: false },
        { name: 'type', type: 'string', nullable: false },
        { name: 'ttl', type: 'number', nullable: true },
        { name: 'value', type: 'string', nullable: true },
      ],
      primaryKeys: ['key'],
    });

    for (const [pattern, info] of patternMap.entries()) {
      const sampleKey = info.keys[0];
      let columns: ColumnInfo[] = [
        { name: 'key', type: 'string', nullable: false },
        { name: 'type', type: 'string', nullable: false },
        { name: 'ttl', type: 'number', nullable: true },
      ];

      if (info.type === 'hash') {
        const hashFields = await client.hkeys(sampleKey);
        columns.push(
          ...hashFields.map((f) => ({
            name: f,
            type: 'string',
            nullable: true,
          }))
        );
      } else if (info.type === 'string') {
        columns.push({ name: 'value', type: 'string', nullable: true });
      } else if (info.type === 'set') {
        columns.push({ name: 'member', type: 'string', nullable: true });
      } else if (info.type === 'zset') {
        columns.push(
          { name: 'member', type: 'string', nullable: true },
          { name: 'score', type: 'number', nullable: true }
        );
      } else if (info.type === 'list') {
        columns.push(
          { name: 'index', type: 'number', nullable: false },
          { name: 'value', type: 'string', nullable: true }
        );
      }

      tables.push({
        name: pattern,
        columns,
        primaryKeys: ['key'],
      });
    }

    return { tables };
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    const client = await this.getClient();
    let pattern = table;
    if (table === 'keys') pattern = '*';
    else if (!table.includes('*') && !table.includes(':')) pattern = `${table}:*`;

    let keys = await this.scanKeys(pattern, limit);
    if (keys.length === 0 && table !== 'keys' && table !== '*') {
      // try exact key lookup
      const exists = await client.exists(table);
      if (exists) keys = [table];
    }

    if (keys.length === 0) {
      return { columns: ['key', 'type', 'ttl', 'value'], rows: [], rowCount: 0 };
    }

    const firstType = await client.type(keys[0]);

    if (firstType === 'hash') {
      const allFields = new Set<string>();
      const hashDataList: { key: string; ttl: number; data: Record<string, string> }[] = [];

      for (const k of keys) {
        const [ttl, data] = await Promise.all([client.ttl(k), client.hgetall(k)]);
        hashDataList.push({ key: k, ttl, data });
        Object.keys(data).forEach((f) => allFields.add(f));
      }

      const columns = ['key', 'ttl', ...Array.from(allFields)];
      const rows = hashDataList.map(({ key, ttl, data }) => {
        return [key, ttl, ...Array.from(allFields).map((f) => data[f] ?? null)];
      });

      return { columns, rows, rowCount: rows.length };
    }

    // Default string / mixed key representation
    const rows: unknown[][] = [];
    for (const k of keys) {
      const [type, ttl] = await Promise.all([client.type(k), client.ttl(k)]);
      let val: any = null;
      if (type === 'string') {
        val = await client.get(k);
      } else if (type === 'hash') {
        val = JSON.stringify(await client.hgetall(k));
      } else if (type === 'set') {
        val = JSON.stringify(await client.smembers(k));
      } else if (type === 'zset') {
        val = JSON.stringify(await client.zrange(k, 0, -1, 'WITHSCORES'));
      } else if (type === 'list') {
        val = JSON.stringify(await client.lrange(k, 0, -1));
      }
      rows.push([k, type, ttl, val]);
    }

    return {
      columns: ['key', 'type', 'ttl', 'value'],
      rows,
      rowCount: rows.length,
    };
  }

  async executeQuery(cmdStr: string, opts?: QueryOptions): Promise<RowSet> {
    const client = await this.getClient();
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;
    const trimmed = cmdStr.trim();

    // 1. Check for SQL syntax (SELECT ...)
    const selectMatch = trimmed.match(/^SELECT\s+(.*?)\s+FROM\s+([`"]?[a-zA-Z0-9_*:-]+[`"]?)(?:\s+WHERE\s+(.*?))?(?:\s+LIMIT\s+(\d+))?$/i);
    if (selectMatch) {
      const [, , rawTable, whereStr, limitStr] = selectMatch;
      let pattern = rawTable.replace(/[`"]/g, '');
      if (pattern === 'keys') pattern = '*';

      if (whereStr) {
        const keyMatch = whereStr.match(/^key\s+(?:LIKE|=)\s*['"]?(.*?)['"]?$/i);
        if (keyMatch) {
          pattern = keyMatch[1].replace(/%/g, '*');
        }
      }

      const limit = limitStr ? Math.min(parseInt(limitStr, 10), rowLimit) : rowLimit;
      return this.getSampleRows(pattern, limit);
    }

    // 2. Direct Redis command parsing
    const tokens = this.tokenizeCommand(trimmed);
    if (tokens.length === 0) {
      throw new Error('Empty query string');
    }

    const command = tokens[0].toUpperCase();
    const args = tokens.slice(1);

    switch (command) {
      case 'GET': {
        if (!args[0]) throw new Error('GET requires key');
        const val = await client.get(args[0]);
        return {
          columns: ['key', 'value'],
          rows: val !== null ? [[args[0], val]] : [],
          rowCount: val !== null ? 1 : 0,
        };
      }
      case 'MGET': {
        if (args.length === 0) throw new Error('MGET requires at least one key');
        const vals = await client.mget(...args);
        const rows = args.map((key, idx) => [key, vals[idx]]);
        return {
          columns: ['key', 'value'],
          rows,
          rowCount: rows.length,
        };
      }
      case 'HGETALL': {
        if (!args[0]) throw new Error('HGETALL requires key');
        const data = await client.hgetall(args[0]);
        const entries = Object.entries(data);
        return {
          columns: ['field', 'value'],
          rows: entries,
          rowCount: entries.length,
        };
      }
      case 'HGET': {
        if (args.length < 2) throw new Error('HGET requires key and field');
        const val = await client.hget(args[0], args[1]);
        return {
          columns: ['key', 'field', 'value'],
          rows: val !== null ? [[args[0], args[1], val]] : [],
          rowCount: val !== null ? 1 : 0,
        };
      }
      case 'SCAN': {
        const cursor = args[0] || '0';
        let pattern = '*';
        let count = rowLimit;

        for (let i = 1; i < args.length; i++) {
          if (args[i].toUpperCase() === 'MATCH' && args[i + 1]) {
            pattern = args[i + 1];
            i++;
          } else if (args[i].toUpperCase() === 'COUNT' && args[i + 1]) {
            count = parseInt(args[i + 1], 10);
            i++;
          }
        }

        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
        const rows: unknown[][] = [];
        for (const k of keys) {
          const [type, ttl] = await Promise.all([client.type(k), client.ttl(k)]);
          rows.push([k, type, ttl, nextCursor]);
        }

        return {
          columns: ['key', 'type', 'ttl', 'next_cursor'],
          rows,
          rowCount: rows.length,
        };
      }
      case 'KEYS': {
        const pattern = args[0] || '*';
        const keys = await client.keys(pattern);
        const limitedKeys = keys.slice(0, rowLimit);
        return {
          columns: ['key'],
          rows: limitedKeys.map((k) => [k]),
          rowCount: limitedKeys.length,
        };
      }
      case 'SMEMBERS': {
        if (!args[0]) throw new Error('SMEMBERS requires key');
        const members = await client.smembers(args[0]);
        return {
          columns: ['key', 'member'],
          rows: members.map((m) => [args[0], m]),
          rowCount: members.length,
        };
      }
      case 'ZRANGE': {
        if (args.length < 3) throw new Error('ZRANGE requires key, min, max');
        const withScores = args.some((a) => a.toUpperCase() === 'WITHSCORES');
        const rangeArgs = args.filter((a) => a.toUpperCase() !== 'WITHSCORES');
        const result = withScores
          ? await client.zrange(rangeArgs[0], rangeArgs[1], rangeArgs[2], 'WITHSCORES')
          : await client.zrange(rangeArgs[0], rangeArgs[1], rangeArgs[2]);

        if (withScores) {
          const rows: unknown[][] = [];
          for (let i = 0; i < result.length; i += 2) {
            rows.push([rangeArgs[0], result[i], parseFloat(result[i + 1])]);
          }
          return { columns: ['key', 'member', 'score'], rows, rowCount: rows.length };
        }

        return {
          columns: ['key', 'member'],
          rows: result.map((m) => [rangeArgs[0], m]),
          rowCount: result.length,
        };
      }
      case 'LRANGE': {
        if (args.length < 3) throw new Error('LRANGE requires key, start, stop');
        const items = await client.lrange(args[0], parseInt(args[1], 10), parseInt(args[2], 10));
        return {
          columns: ['key', 'index', 'value'],
          rows: items.map((item, idx) => [args[0], idx, item]),
          rowCount: items.length,
        };
      }
      case 'SET': {
        if (args.length < 2) throw new Error('SET requires key and value');
        const res = await client.set(args[0], args[1]);
        return { columns: ['result'], rows: [[res]], rowCount: 1 };
      }
      case 'HSET': {
        if (args.length < 3) throw new Error('HSET requires key, field, and value');
        const res = await client.hset(args[0], args[1], args[2]);
        return { columns: ['result'], rows: [[res]], rowCount: 1 };
      }
      case 'DEL': {
        if (args.length === 0) throw new Error('DEL requires key(s)');
        const res = await client.del(...args);
        return { columns: ['deletedCount'], rows: [[res]], rowCount: 1 };
      }
      case 'EXPIRE': {
        if (args.length < 2) throw new Error('EXPIRE requires key and seconds');
        const res = await client.expire(args[0], parseInt(args[1], 10));
        return { columns: ['result'], rows: [[res]], rowCount: 1 };
      }
      default: {
        // Fallback for custom / standard redis commands
        try {
          const res = await (client as any).call(command, ...args);
          if (Array.isArray(res)) {
            return {
              columns: ['value'],
              rows: res.map((item) => [Array.isArray(item) ? JSON.stringify(item) : item]),
              rowCount: res.length,
            };
          }
          return {
            columns: ['result'],
            rows: [[res]],
            rowCount: 1,
          };
        } catch (error) {
          throw new Error(`Unsupported or invalid Redis command: ${command}`);
        }
      }
    }
  }

  private tokenizeCommand(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = '';
      } else if (/\s/.test(char) && !inQuotes) {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
  }

  async explainQuery(sql: string): Promise<string> {
    const trimmed = sql.trim();
    const tokens = this.tokenizeCommand(trimmed);
    const command = tokens[0]?.toUpperCase() || 'SCAN';
    return `Redis Execution Plan:\nCommand: ${command}\nArgs: ${JSON.stringify(tokens.slice(1))}`;
  }

  async getTableStats(table: string): Promise<TableStats> {
    const client = await this.getClient();
    let pattern = table;
    if (table === 'keys') pattern = '*';
    else if (!table.includes('*') && !table.includes(':')) pattern = `${table}:*`;

    const keys = await this.scanKeys(pattern, 10000);
    let sizeBytes = 0;

    for (const key of keys.slice(0, 100)) {
      try {
        const mem = await (client as any).call('MEMORY', 'USAGE', key);
        if (typeof mem === 'number') sizeBytes += mem;
      } catch {
        // MEMORY USAGE command might fail on older Redis versions or restricted environments
      }
    }

    if (keys.length > 100) {
      sizeBytes = Math.round((sizeBytes / 100) * keys.length);
    }

    return {
      estimatedRows: keys.length,
      sizeBytes,
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.client = null;
    }
  }
}
