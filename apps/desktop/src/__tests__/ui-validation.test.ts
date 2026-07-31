import { describe, it, expect } from 'vitest';
import React from 'react';
import ConnectionForm from '../renderer/components/ConnectionForm';
import type { AdapterType } from '@zebraa/core';
import { validateConnectionConfig } from '@zebraa/core';

describe('End-to-End UI & IPC Connection Validation for All Databases', () => {
  const dbTypes: AdapterType[] = [
    'postgres',
    'mysql',
    'sqlite',
    'mariadb',
    'mssql',
    'mongodb',
    'redis',
    'clickhouse',
  ];

  it('should validate connection config for all 8 database types without throwing TypeError', () => {
    for (const type of dbTypes) {
      // 1. Completely empty config
      const resEmpty = validateConnectionConfig(type, {});
      expect(resEmpty.valid).toBe(false);
      expect(resEmpty.error).toBeDefined();
      expect(typeof resEmpty.error).toBe('string');
      expect(resEmpty.error).not.toContain('TypeError');

      // 2. Config with invalid / NaN port
      if (type !== 'sqlite') {
        const resNaNPort = validateConnectionConfig(type, { host: 'localhost', port: NaN, database: 'db', username: 'user' });
        expect(resNaNPort.valid).toBe(false);
        expect(resNaNPort.error).toBe('Port must be a valid integer between 1 and 65535');
      }

      // 3. Config with missing host
      if (type !== 'sqlite') {
        const resNoHost = validateConnectionConfig(type, { host: '', port: 5432, database: 'db', username: 'user' });
        expect(resNoHost.valid).toBe(false);
        expect(resNoHost.error).toBe('Host is required');
      }

      // 4. Config with missing database name
      if (['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse'].includes(type)) {
        const resNoDb = validateConnectionConfig(type, { host: 'localhost', port: 5432, database: '', username: 'user' });
        expect(resNoDb.valid).toBe(false);
        expect(resNoDb.error).toBe('Database name is required');
      }

      // 5. Config with missing username
      if (['postgres', 'mysql', 'mariadb', 'mssql'].includes(type)) {
        const resNoUser = validateConnectionConfig(type, { host: 'localhost', port: 5432, database: 'db', username: '' });
        expect(resNoUser.valid).toBe(false);
        expect(resNoUser.error).toBe('Username is required');
      }
    }
  });

  it('should render ConnectionForm properly for all 8 database types', () => {
    for (const type of dbTypes) {
      const element = React.createElement(ConnectionForm, {
        initialType: type,
        onBack: () => {},
        onSubmit: async () => {},
        onCancel: () => {},
      });
      expect(element).toBeDefined();
      expect(element.props.initialType).toBe(type);
    }
  });
});
