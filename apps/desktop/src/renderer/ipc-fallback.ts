import type { IpcApi } from '../preload/index.js';

if (typeof window !== 'undefined' && !window.ipc) {
  window.ipc = {
    connections: {
      list: async () => [],
      create: async (config) => ({
        id: 'demo-1',
        name: config.name,
        type: config.type || 'postgres',
        host: config.host,
        port: config.port,
        database: config.database,
        username: config.username,
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
      update: async (id, config) => ({
        id,
        name: config.name || 'Updated',
        type: config.type || 'postgres',
        host: config.host || 'localhost',
        port: config.port || 5432,
        database: config.database || 'zebraa',
        username: config.username || 'postgres',
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
      delete: async () => {},
      test: async () => ({
        ok: false,
        error: 'Electron IPC bridge is unavailable. Please run the app inside Electron (e.g., `pnpm dev` or `npm run dev`).',
      }),
    },
    schema: {
      get: async () => ({ tables: [] }),
    },
    query: {
      execute: async () => ({ columns: [], rows: [], rowCount: 0 }),
      explain: async () => 'Execution plan unavailable in browser preview',
    },
    table: {
      sample: async () => ({ columns: [], rows: [], rowCount: 0 }),
      stats: async () => ({ estimatedRows: 0, sizeBytes: 0 }),
    },
  };
}
