import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisAdapter } from '../redis-adapter.js';
import { createAdapter } from '../registry.js';
import type { ConnectionConfig } from '../types/index.js';

const redisConfig: ConnectionConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  database: '0',
};

describe('RedisAdapter Unit & Integration Tests', () => {
  let adapter: RedisAdapter;

  beforeAll(async () => {
    adapter = new RedisAdapter(redisConfig);

    // Seed test data in Redis
    await adapter.executeQuery('SET session:1 active');
    await adapter.executeQuery('HSET user:100 name Alice');
    await adapter.executeQuery('HSET user:100 role admin');
    await adapter.executeQuery('HSET user:101 name Bob');
    await adapter.executeQuery('HSET user:101 role user');
    await adapter.executeQuery('SADD tags tech');
    await adapter.executeQuery('SADD tags ai');
    await adapter.executeQuery('ZADD leaderboard 100 player1');
    await adapter.executeQuery('ZADD leaderboard 200 player2');
    await adapter.executeQuery('RPUSH tasks task1');
    await adapter.executeQuery('RPUSH tasks task2');
  });

  afterAll(async () => {
    await adapter.executeQuery('FLUSHDB').catch(() => {});
    await adapter.close();
  });

  it('should create adapter via registry factory', () => {
    const regAdapter = createAdapter('redis', redisConfig);
    expect(regAdapter).toBeInstanceOf(RedisAdapter);
  });

  it('should test connection successfully', async () => {
    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('should return error for invalid connection host/port', async () => {
    const badAdapter = new RedisAdapter({
      host: '127.0.0.1',
      port: 59999, // Unreachable port
    });
    const res = await badAdapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    await badAdapter.close();
  });

  it('should map key patterns and data structures to SchemaInfo', async () => {
    const schema = await adapter.getSchema();
    expect(schema).toBeDefined();
    expect(schema.tables.length).toBeGreaterThanOrEqual(2);

    const tableNames = schema.tables.map((t) => t.name);
    expect(tableNames).toContain('keys');
    expect(tableNames).toContain('user:*');
    expect(tableNames).toContain('session:*');

    const userTable = schema.tables.find((t) => t.name === 'user:*')!;
    expect(userTable).toBeDefined();
    const colNames = userTable.columns.map((c) => c.name);
    expect(colNames).toContain('key');
    expect(colNames).toContain('name');
    expect(colNames).toContain('role');
  });

  it('should get sample rows for pattern', async () => {
    const sample = await adapter.getSampleRows('user:*', 5);
    expect(sample.columns).toContain('key');
    expect(sample.columns).toContain('name');
    expect(sample.columns).toContain('role');
    expect(sample.rowCount).toBe(2);
  });

  it('should execute GET and MGET commands', async () => {
    const getRes = await adapter.executeQuery('GET session:1');
    expect(getRes.columns).toEqual(['key', 'value']);
    expect(getRes.rowCount).toBe(1);
    expect(getRes.rows[0]).toEqual(['session:1', 'active']);

    const mgetRes = await adapter.executeQuery('MGET session:1 non_existent_key');
    expect(mgetRes.rowCount).toBe(2);
    expect(mgetRes.rows[0]).toEqual(['session:1', 'active']);
    expect(mgetRes.rows[1]).toEqual(['non_existent_key', null]);
  });

  it('should execute HGETALL and HGET commands', async () => {
    const hgetallRes = await adapter.executeQuery('HGETALL user:100');
    expect(hgetallRes.columns).toEqual(['field', 'value']);
    expect(hgetallRes.rowCount).toBe(2);

    const hgetRes = await adapter.executeQuery('HGET user:100 name');
    expect(hgetRes.columns).toEqual(['key', 'field', 'value']);
    expect(hgetRes.rows[0]).toEqual(['user:100', 'name', 'Alice']);
  });

  it('should execute SCAN and KEYS commands', async () => {
    const scanRes = await adapter.executeQuery('SCAN 0 MATCH user:* COUNT 10');
    expect(scanRes.columns).toContain('key');
    expect(scanRes.rowCount).toBe(2);

    const keysRes = await adapter.executeQuery('KEYS user:*');
    expect(keysRes.columns).toEqual(['key']);
    expect(keysRes.rowCount).toBe(2);
  });

  it('should execute SMEMBERS, ZRANGE, and LRANGE commands', async () => {
    const smembersRes = await adapter.executeQuery('SMEMBERS tags');
    expect(smembersRes.columns).toEqual(['key', 'member']);
    expect(smembersRes.rowCount).toBe(2);

    const zrangeRes = await adapter.executeQuery('ZRANGE leaderboard 0 -1 WITHSCORES');
    expect(zrangeRes.columns).toEqual(['key', 'member', 'score']);
    expect(zrangeRes.rowCount).toBe(2);
    expect(zrangeRes.rows[0]).toEqual(['leaderboard', 'player1', 100]);

    const lrangeRes = await adapter.executeQuery('LRANGE tasks 0 -1');
    expect(lrangeRes.columns).toEqual(['key', 'index', 'value']);
    expect(lrangeRes.rowCount).toBe(2);
  });

  it('should execute write commands SET, HSET, DEL', async () => {
    const setRes = await adapter.executeQuery('SET temp_key temp_val');
    expect(setRes.rows[0][0]).toBe('OK');

    const delRes = await adapter.executeQuery('DEL temp_key');
    expect(delRes.rows[0][0]).toBe(1);
  });

  it('should execute SQL SELECT translation query', async () => {
    const res = await adapter.executeQuery("SELECT * FROM keys WHERE key LIKE 'user:%'");
    expect(res.rowCount).toBe(2);
  });

  it('should explain query execution plan', async () => {
    const plan = await adapter.explainQuery('HGETALL user:100');
    expect(plan).toContain('HGETALL');
    expect(plan).toContain('user:100');
  });

  it('should fetch table stats for Redis keys', async () => {
    const stats = await adapter.getTableStats('user:*');
    expect(stats.estimatedRows).toBe(2);
  });
});
