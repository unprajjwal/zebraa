import { MongoClient, Db, Document, ObjectId } from 'mongodb';
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

export class MongoDBAdapter extends DatabaseAdapter {
  private client: MongoClient | null = null;

  constructor(config: ConnectionConfig) {
    super(config);
  }

  private buildConnectionString(): string {
    if (this.config.filepath) {
      return this.config.filepath;
    }

    const host = this.config.host || 'localhost';
    const port = this.config.port || 27017;
    const db = this.config.database || 'zebraa';

    if (this.config.username && this.config.password) {
      const user = encodeURIComponent(this.config.username);
      const pass = encodeURIComponent(this.config.password);
      return `mongodb://${user}:${pass}@${host}:${port}/${db}?authSource=admin`;
    }

    return `mongodb://${host}:${port}/${db}`;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    let tempClient: MongoClient | null = null;
    try {
      const uri = this.buildConnectionString();
      tempClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await tempClient.connect();
      const dbName = this.config.database || 'zebraa';
      await tempClient.db(dbName).command({ ping: 1 });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    } finally {
      if (tempClient) {
        await tempClient.close().catch(() => {});
      }
    }
  }

  private async getClient(): Promise<MongoClient> {
    if (!this.client) {
      const uri = this.buildConnectionString();
      this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await this.client.connect();
    }
    return this.client;
  }

  private async withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    const dbName = this.config.database || 'zebraa';
    return await fn(client.db(dbName));
  }

  private inferType(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (value instanceof ObjectId) return 'objectId';
    if (value instanceof Date) return 'date';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return typeof value;
  }

  async getSchema(): Promise<SchemaInfo> {
    return this.withDb(async (db) => {
      const collectionInfos = await db.listCollections().toArray();
      const tables: TableInfo[] = [];

      for (const colInfo of collectionInfos) {
        const colName = colInfo.name;
        if (colName.startsWith('system.')) continue;

        const collection = db.collection(colName);
        const sampleDocs = await collection.find({}).limit(50).toArray();

        const columnMap = new Map<string, { types: Set<string>; nullable: boolean }>();

        for (const doc of sampleDocs) {
          const docKeys = Object.keys(doc);
          for (const key of docKeys) {
            if (!columnMap.has(key)) {
              columnMap.set(key, { types: new Set(), nullable: false });
            }
            const val = doc[key];
            const typeStr = this.inferType(val);
            columnMap.get(key)!.types.add(typeStr);
          }

          for (const key of columnMap.keys()) {
            if (!(key in doc) || doc[key] === null || doc[key] === undefined) {
              columnMap.get(key)!.nullable = true;
            }
          }
        }

        const columns: ColumnInfo[] = Array.from(columnMap.entries()).map(([name, info]) => {
          const types = Array.from(info.types).filter((t) => t !== 'null');
          const type = types.length > 0 ? types.join(' | ') : 'string';
          return {
            name,
            type,
            nullable: info.nullable || sampleDocs.length === 0,
          };
        });

        const primaryKeys = columnMap.has('_id') ? ['_id'] : undefined;

        tables.push({
          name: colName,
          columns,
          primaryKeys,
        });
      }

      return { tables };
    });
  }

  async getSampleRows(table: string, limit: number = 10): Promise<RowSet> {
    return this.withDb(async (db) => {
      const collection = db.collection(table);
      const docs = await collection.find({}).limit(limit).toArray();

      if (docs.length === 0) {
        return { columns: [], rows: [], rowCount: 0 };
      }

      const columnSet = new Set<string>();
      for (const doc of docs) {
        for (const key of Object.keys(doc)) {
          columnSet.add(key);
        }
      }
      const columns = Array.from(columnSet);

      const rows = docs.map((doc) => {
        return columns.map((col) => {
          const val = doc[col];
          if (val === undefined) return null;
          if (val instanceof ObjectId) return val.toString();
          return val;
        });
      });

      return {
        columns,
        rows,
        rowCount: rows.length,
      };
    });
  }

  async executeQuery(queryStr: string, opts?: QueryOptions): Promise<RowSet> {
    const rowLimit = opts?.rowLimit ?? DEFAULT_ROW_LIMIT;
    const trimmed = queryStr.trim();

    return this.withDb(async (db) => {
      // 1. Check if query is JSON
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch (e) {
          throw new Error(`Invalid JSON query: ${(e as Error).message}`);
        }

        if (Array.isArray(parsed)) {
          throw new Error('JSON query must be an object specifying collection/operation');
        }

        const colName = parsed.collection || parsed.find || parsed.aggregate || parsed.insert || parsed.update || parsed.delete;
        if (!colName) {
          throw new Error('JSON query must contain "collection", "find", "aggregate", "insert", "update", or "delete" property');
        }

        const col = db.collection(colName);

        if (parsed.aggregate) {
          const pipeline = parsed.pipeline || [];
          const docs = await col.aggregate(pipeline).toArray();
          return this.docsToRowSet(docs.slice(0, rowLimit));
        }

        if (parsed.insert) {
          const docs = parsed.documents || parsed.docs || [parsed.doc || parsed.document];
          const res = await col.insertMany(docs);
          return {
            columns: ['insertedCount', 'insertedIds'],
            rows: [[res.insertedCount, Object.values(res.insertedIds).map(id => id.toString())]],
            rowCount: 1,
          };
        }

        if (parsed.update) {
          const filter = parsed.filter || {};
          const update = parsed.updateDoc || parsed.update || parsed.doc;
          const res = await col.updateMany(filter, update);
          return {
            columns: ['matchedCount', 'modifiedCount'],
            rows: [[res.matchedCount, res.modifiedCount]],
            rowCount: 1,
          };
        }

        if (parsed.delete) {
          const filter = parsed.filter || {};
          const res = await col.deleteMany(filter);
          return {
            columns: ['deletedCount'],
            rows: [[res.deletedCount]],
            rowCount: 1,
          };
        }

        // find operation
        const filter = parsed.filter || parsed.query || {};
        const projection = parsed.projection || undefined;
        const sort = parsed.sort || undefined;
        const limit = parsed.limit ? Math.min(parsed.limit, rowLimit) : rowLimit;

        let cursor = col.find(filter, { projection });
        if (sort) cursor = cursor.sort(sort);
        cursor = cursor.limit(limit);

        const docs = await cursor.toArray();
        return this.docsToRowSet(docs);
      }

      // 2. Check mongo syntax like db.users.find({...}) or users.find({...})
      const mongoMethodMatch = trimmed.match(/^(?:db\.)?([a-zA-Z0-9_]+)\.(find|aggregate|insertMany|insertOne|deleteMany|deleteOne|updateMany)\((.*)\)$/s);
      if (mongoMethodMatch) {
        const [, colName, method, argsStr] = mongoMethodMatch;
        const col = db.collection(colName);

        if (method === 'find') {
          let filter = {};
          if (argsStr.trim()) {
            try {
              filter = JSON.parse(argsStr.trim());
            } catch {
              // fallback
            }
          }
          const docs = await col.find(filter).limit(rowLimit).toArray();
          return this.docsToRowSet(docs);
        }
      }

      // 3. SQL Translation fallback
      return this.executeSqlTranslation(db, trimmed, rowLimit);
    });
  }

  private async executeSqlTranslation(db: Db, sql: string, rowLimit: number): Promise<RowSet> {
    const selectMatch = sql.match(/^SELECT\s+(.*?)\s+FROM\s+([`"]?[a-zA-Z0-9_]+[`"]?)(?:\s+WHERE\s+(.*?))?(?:\s+ORDER\s+BY\s+(.*?))?(?:\s+LIMIT\s+(\d+))?$/i);

    if (selectMatch) {
      const [, colsStr, rawTable, whereStr, orderStr, limitStr] = selectMatch;
      const tableName = rawTable.replace(/[`"]/g, '');
      const collection = db.collection(tableName);

      const filter: Record<string, any> = {};
      if (whereStr) {
        const conds = whereStr.split(/\s+AND\s+/i);
        for (const cond of conds) {
          const eqMatch = cond.match(/^([a-zA-Z0-9_]+)\s*=\s*(.*)$/);
          const neMatch = cond.match(/^([a-zA-Z0-9_]+)\s*(?:!=|<>)\s*(.*)$/);
          const gtMatch = cond.match(/^([a-zA-Z0-9_]+)\s*>\s*(.*)$/);
          const gteMatch = cond.match(/^([a-zA-Z0-9_]+)\s*>=\s*(.*)$/);
          const ltMatch = cond.match(/^([a-zA-Z0-9_]+)\s*<\s*(.*)$/);
          const lteMatch = cond.match(/^([a-zA-Z0-9_]+)\s*<=\s*(.*)$/);

          if (gteMatch) {
            filter[gteMatch[1]] = { $gte: this.parseSqlVal(gteMatch[2]) };
          } else if (gtMatch) {
            filter[gtMatch[1]] = { $gt: this.parseSqlVal(gtMatch[2]) };
          } else if (lteMatch) {
            filter[lteMatch[1]] = { $lte: this.parseSqlVal(lteMatch[2]) };
          } else if (ltMatch) {
            filter[ltMatch[1]] = { $lt: this.parseSqlVal(ltMatch[2]) };
          } else if (neMatch) {
            filter[neMatch[1]] = { $ne: this.parseSqlVal(neMatch[2]) };
          } else if (eqMatch) {
            filter[eqMatch[1]] = this.parseSqlVal(eqMatch[2]);
          }
        }
      }

      let sort: Record<string, 1 | -1> | undefined;
      if (orderStr) {
        sort = {};
        const parts = orderStr.split(',');
        for (const part of parts) {
          const [field, dir] = part.trim().split(/\s+/);
          sort[field] = dir && dir.toUpperCase() === 'DESC' ? -1 : 1;
        }
      }

      const limit = limitStr ? Math.min(parseInt(limitStr, 10), rowLimit) : rowLimit;

      let cursor = collection.find(filter);
      if (sort) cursor = cursor.sort(sort);
      cursor = cursor.limit(limit);

      const docs = await cursor.toArray();

      if (colsStr.trim() !== '*') {
        const explicitCols = colsStr.split(',').map((c) => c.trim());
        const rows = docs.map((doc) =>
          explicitCols.map((col) => {
            const val = doc[col];
            if (val instanceof ObjectId) return val.toString();
            return val ?? null;
          })
        );
        return {
          columns: explicitCols,
          rows,
          rowCount: rows.length,
        };
      }

      return this.docsToRowSet(docs);
    }

    // Insert translation
    const insertMatch = sql.match(/^INSERT\s+INTO\s+([`"]?[a-zA-Z0-9_]+[`"]?)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)$/i);
    if (insertMatch) {
      const [, rawTable, colsStr, valsStr] = insertMatch;
      const tableName = rawTable.replace(/[`"]/g, '');
      const cols = colsStr.split(',').map((c) => c.trim());
      const vals = valsStr.split(',').map((v) => this.parseSqlVal(v.trim()));

      const doc: Record<string, any> = {};
      cols.forEach((col, idx) => {
        doc[col] = vals[idx];
      });

      const res = await db.collection(tableName).insertOne(doc);
      return {
        columns: ['insertedCount', 'insertedId'],
        rows: [[1, res.insertedId.toString()]],
        rowCount: 1,
      };
    }

    // Delete translation
    const deleteMatch = sql.match(/^DELETE\s+FROM\s+([`"]?[a-zA-Z0-9_]+[`"]?)(?:\s+WHERE\s+(.*?))?$/i);
    if (deleteMatch) {
      const [, rawTable, whereStr] = deleteMatch;
      const tableName = rawTable.replace(/[`"]/g, '');

      const filter: Record<string, any> = {};
      if (whereStr) {
        const eqMatch = whereStr.match(/^([a-zA-Z0-9_]+)\s*=\s*(.*)$/);
        if (eqMatch) {
          filter[eqMatch[1]] = this.parseSqlVal(eqMatch[2]);
        }
      }

      const res = await db.collection(tableName).deleteMany(filter);
      return {
        columns: ['deletedCount'],
        rows: [[res.deletedCount]],
        rowCount: 1,
      };
    }

    throw new Error(`Unsupported SQL query for MongoDB: ${sql}`);
  }

  private parseSqlVal(valStr: string): any {
    const trimmed = valStr.trim();
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1);
    }
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;
    if (trimmed.toLowerCase() === 'null') return null;
    const num = Number(trimmed);
    if (!isNaN(num)) return num;
    return trimmed;
  }

  private docsToRowSet(docs: Document[]): RowSet {
    if (docs.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }

    const colSet = new Set<string>();
    for (const doc of docs) {
      for (const k of Object.keys(doc)) {
        colSet.add(k);
      }
    }
    const columns = Array.from(colSet);

    const rows = docs.map((doc) =>
      columns.map((col) => {
        const val = doc[col];
        if (val === undefined) return null;
        if (val instanceof ObjectId) return val.toString();
        return val;
      })
    );

    return {
      columns,
      rows,
      rowCount: rows.length,
    };
  }

  async explainQuery(sql: string): Promise<string> {
    return this.withDb(async (db) => {
      const trimmed = sql.trim();
      let colName = 'default';
      let filter = {};

      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          colName = parsed.collection || parsed.find || 'default';
          filter = parsed.filter || {};
        } catch {
          // fallback
        }
      } else {
        const selectMatch = trimmed.match(/^SELECT\s+.*?\s+FROM\s+([`"]?[a-zA-Z0-9_]+[`"]?)/i);
        if (selectMatch) {
          colName = selectMatch[1].replace(/[`"]/g, '');
        }
      }

      const collection = db.collection(colName);
      const explanation = await collection.find(filter).explain();
      return JSON.stringify(explanation, null, 2);
    });
  }

  async getTableStats(table: string): Promise<TableStats> {
    return this.withDb(async (db) => {
      const collection = db.collection(table);
      let estimatedRows = 0;
      let sizeBytes = 0;

      try {
        estimatedRows = await collection.estimatedDocumentCount();
      } catch {
        estimatedRows = await collection.countDocuments();
      }

      try {
        const stats = await db.command({ collStats: table });
        sizeBytes = stats.size || stats.storageSize || 0;
      } catch {
        sizeBytes = 0;
      }

      return {
        estimatedRows,
        sizeBytes,
      };
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
