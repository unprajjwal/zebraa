import mysql from 'mysql2/promise';
import { MySQLAdapter } from './mysql-adapter.js';
import type { ConnectionConfig, SchemaInfo, TableInfo } from './types/index.js';

export class MariaDBAdapter extends MySQLAdapter {
  constructor(config: ConnectionConfig) {
    super({
      ...config,
      port: config.port || 3306,
    });
  }

  override async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const connection = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port || 3306,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        connectTimeout: 5000,
      });

      try {
        await connection.query('SELECT VERSION()');
      } finally {
        await connection.end();
      }

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  override async getSchema(): Promise<SchemaInfo> {
    const pool = (this as any).getPool();

    // 1. Fetch tables and columns (including SYSTEM VERSIONED tables supported by MariaDB)
    const tableQuery = `
      SELECT
        t.TABLE_NAME as table_name,
        c.COLUMN_NAME as column_name,
        c.DATA_TYPE as data_type,
        c.IS_NULLABLE as is_nullable,
        c.COLUMN_DEFAULT as column_default
      FROM information_schema.tables t
      LEFT JOIN information_schema.columns c
        ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ?
        AND t.TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED')
      ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
    `;

    const [tableRows] = (await pool.query(tableQuery, [
      this.config.database,
    ])) as unknown as [mysql.RowDataPacket[]];

    const tableMap = new Map<string, TableInfo>();
    for (const row of tableRows) {
      const tableName = row.table_name as string;
      if (!tableMap.has(tableName)) {
        tableMap.set(tableName, {
          name: tableName,
          columns: [],
        });
      }

      if (row.column_name) {
        tableMap.get(tableName)!.columns.push({
          name: row.column_name as string,
          type: row.data_type as string,
          nullable: row.is_nullable === 'YES',
          default: row.column_default !== null ? String(row.column_default) : undefined,
        });
      }
    }

    // 2. Fetch Primary Keys
    const pkQuery = `
      SELECT
        kcu.TABLE_NAME as table_name,
        kcu.COLUMN_NAME as column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       AND tc.TABLE_NAME = kcu.TABLE_NAME
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.TABLE_SCHEMA = ?
      ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION
    `;

    const [pkRows] = (await pool.query(pkQuery, [this.config.database])) as unknown as [mysql.RowDataPacket[]];
    for (const row of pkRows) {
      const table = tableMap.get(row.table_name as string);
      if (table) {
        if (!table.primaryKeys) table.primaryKeys = [];
        if (!table.primaryKeys.includes(row.column_name as string)) {
          table.primaryKeys.push(row.column_name as string);
        }
      }
    }

    // 3. Fetch Foreign Keys
    const fkQuery = `
      SELECT
        kcu.TABLE_NAME as table_name,
        kcu.COLUMN_NAME as column_name,
        kcu.REFERENCED_TABLE_NAME as foreign_table,
        kcu.REFERENCED_COLUMN_NAME as foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       AND tc.TABLE_NAME = kcu.TABLE_NAME
      WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND tc.TABLE_SCHEMA = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
    `;

    const [fkRows] = (await pool.query(fkQuery, [this.config.database])) as unknown as [mysql.RowDataPacket[]];
    for (const row of fkRows) {
      const table = tableMap.get(row.table_name as string);
      if (table) {
        if (!table.foreignKeys) table.foreignKeys = [];
        const exists = table.foreignKeys.some(
          (fk) =>
            fk.column === row.column_name &&
            fk.refTable === row.foreign_table &&
            fk.refColumn === row.foreign_column
        );
        if (!exists) {
          table.foreignKeys.push({
            column: row.column_name as string,
            refTable: row.foreign_table as string,
            refColumn: row.foreign_column as string,
          });
        }
      }
    }

    return { tables: Array.from(tableMap.values()) };
  }
}
