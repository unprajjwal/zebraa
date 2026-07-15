import { ipcMain, safeStorage } from 'electron';
import { randomUUID } from 'crypto';
import { createAdapter, type ConnectionDTO, type SchemaInfo } from '@zebraa/core';
import { listConnections, getConnection, createConnection, updateConnection, deleteConnection, type ConnectionRow } from './db.js';

const adapterCache = new Map<string, any>();

function rowToDto(row: ConnectionRow): ConnectionDTO {
  return {
    id: row.id,
    name: row.name,
    type: row.type as any,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function setupIpcHandlers(): void {
  // connections:list
  ipcMain.handle('connections:list', async () => {
    const rows = listConnections();
    return rows.map(rowToDto);
  });

  // connections:test
  ipcMain.handle('connections:test', async (_event, config) => {
    try {
      const adapter = createAdapter(config.type || 'postgres', {
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        password: config.password,
      });

      const result = await adapter.testConnection();
      await adapter.close();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  // connections:create
  ipcMain.handle('connections:create', async (_event, config) => {
    try {
      const id = randomUUID();
      const now = Date.now();

      const secretBlob = safeStorage.encryptString(config.password);

      createConnection({
        id,
        name: config.name,
        type: config.type || 'postgres',
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        secret_encrypted: secretBlob,
      });

      return {
        id,
        name: config.name,
        type: config.type || 'postgres',
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        created_at: now,
        updated_at: now,
      } as ConnectionDTO;
    } catch (error) {
      throw new Error(`Failed to create connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // connections:update
  ipcMain.handle('connections:update', async (_event, id: string, updates) => {
    try {
      const connection = getConnection(id);
      if (!connection) {
        throw new Error(`Connection ${id} not found`);
      }

      const updateData: any = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.host !== undefined) updateData.host = updates.host;
      if (updates.port !== undefined) updateData.port = updates.port;
      if (updates.database !== undefined) updateData.database = updates.database;
      if (updates.username !== undefined) updateData.username = updates.username;
      if (updates.password !== undefined) {
        updateData.secret_encrypted = safeStorage.encryptString(updates.password);
      }

      updateConnection(id, updateData);

      const updated = getConnection(id)!;
      return rowToDto(updated);
    } catch (error) {
      throw new Error(`Failed to update connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // connections:delete
  ipcMain.handle('connections:delete', async (_event, id: string) => {
    try {
      deleteConnection(id);
      if (adapterCache.has(id)) {
        const adapter = adapterCache.get(id);
        await adapter.close();
        adapterCache.delete(id);
      }
    } catch (error) {
      throw new Error(`Failed to delete connection: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // schema:get
  ipcMain.handle('schema:get', async (_event, connectionId: string) => {
    try {
      const connection = getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection ${connectionId} not found`);
      }

      let adapter = adapterCache.get(connectionId);
      if (!adapter) {
        const password = safeStorage.decryptString(connection.secret_encrypted);
        adapter = createAdapter(connection.type as any, {
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: connection.username,
          password,
        });
        adapterCache.set(connectionId, adapter);
      }

      return await adapter.getSchema();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch schema: ${message}`);
    }
  });

  // query:execute (stubbed for now)
  ipcMain.handle('query:execute', async (_event, connectionId: string, sql: string, opts) => {
    throw new Error('Query execution not yet implemented (phase 2)');
  });
}
