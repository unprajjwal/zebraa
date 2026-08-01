import React, { useState, useEffect } from 'react';
import type { AdapterType } from '@zebraa/core';
import { getActiveIpc } from '../ipc';

interface Props {
  initialType?: AdapterType;
  onBack?: () => void;
  onSubmit: (config: any) => Promise<void>;
  onCancel: () => void;
}

function getDefaultPort(type: AdapterType): string {
  switch (type) {
    case 'postgres': return '5432';
    case 'mysql': return '3306';
    case 'sqlite': return '0';
    case 'mariadb': return '3306';
    case 'mssql': return '1433';
    case 'mongodb': return '27017';
    case 'redis': return '6379';
    case 'clickhouse': return '8123';
    default: return '5432';
  }
}

function getDefaultUsername(type: AdapterType): string {
  switch (type) {
    case 'postgres': return 'postgres';
    case 'mysql': return 'root';
    case 'sqlite': return '';
    case 'mariadb': return 'root';
    case 'mssql': return 'sa';
    case 'mongodb': return '';
    case 'redis': return '';
    case 'clickhouse': return 'default';
    default: return 'postgres';
  }
}

function getTypeLabel(type: AdapterType): string {
  switch (type) {
    case 'postgres': return 'PostgreSQL';
    case 'mysql': return 'MySQL';
    case 'sqlite': return 'SQLite';
    case 'mariadb': return 'MariaDB';
    case 'mssql': return 'SQL Server';
    case 'mongodb': return 'MongoDB';
    case 'redis': return 'Redis';
    case 'clickhouse': return 'ClickHouse';
    default: return type;
  }
}

export default function ConnectionForm({ initialType = 'postgres', onBack, onSubmit, onCancel }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState<AdapterType>(initialType);
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(getDefaultPort(initialType));
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState(getDefaultUsername(initialType));
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    setType(initialType);
    setPort(getDefaultPort(initialType));
    setUsername(getDefaultUsername(initialType));
    setTestResult(null);
  }, [initialType]);

  function handleTypeChange(newType: AdapterType) {
    setType(newType);
    setTestResult(null);
    setPort(getDefaultPort(newType));
    setUsername(getDefaultUsername(newType));
  }

  function validateLocal(): { valid: boolean; error?: string } {
    if (!name.trim()) {
      return { valid: false, error: 'Connection name is required' };
    }

    if (type === 'sqlite') {
      if (!database.trim()) {
        return { valid: false, error: 'Database file path is required for SQLite' };
      }
      return { valid: true };
    }

    if (!host.trim()) {
      return { valid: false, error: 'Host is required' };
    }

    if (port === '' || port === null || port === undefined) {
      return { valid: false, error: 'Port is required' };
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return { valid: false, error: 'Port must be a valid integer between 1 and 65535' };
    }

    if (type !== 'redis' && !database.trim()) {
      return { valid: false, error: 'Database name is required' };
    }

    if ((type === 'postgres' || type === 'mysql' || type === 'mariadb' || type === 'mssql') && !username.trim()) {
      return { valid: false, error: 'Username is required' };
    }

    return { valid: true };
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);

    const validation = validateLocal();
    if (!validation.valid) {
      setTestResult({ ok: false, error: validation.error });
      setTesting(false);
      return;
    }

    try {
      const result = await getActiveIpc().connections.test({
        name: name.trim(),
        type,
        host: host.trim(),
        port: parseInt(port, 10) || 0,
        database: database.trim(),
        username: username.trim(),
        password,
        filepath: type === 'sqlite' ? database.trim() : undefined,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validation = validateLocal();
    if (!validation.valid) {
      alert(`Error: ${validation.error}`);
      return;
    }

    if (!testResult?.ok) {
      alert('Please test the connection first');
      return;
    }

    try {
      await onSubmit({
        name: name.trim(),
        type,
        host: host.trim(),
        port: parseInt(port, 10) || 0,
        database: database.trim(),
        username: username.trim(),
        password,
      });
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="conn-form">
      {onBack && (
        <div className="conn-form__header">
          <button type="button" className="btn-back" onClick={onBack} title="Change database type">
            ← Change DB
          </button>
          <span className={`conn-form__type-badge conn-form__type-badge--${type}`}>
            {getTypeLabel(type)}
          </span>
        </div>
      )}

      <label className="form-label" htmlFor="conn-name">
        Name
      </label>
      <input
        id="conn-name"
        className="field"
        type="text"
        placeholder="e.g. Local dev"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setTestResult(null);
        }}
        required
      />

      <label className="form-label" htmlFor="conn-type">
        Database Type
      </label>
      <select
        id="conn-type"
        className="field"
        value={type}
        onChange={(e) => handleTypeChange(e.target.value as AdapterType)}
      >
        <option value="postgres">PostgreSQL</option>
        <option value="mysql">MySQL</option>
        <option value="sqlite">SQLite</option>
        <option value="mariadb">MariaDB</option>
        <option value="mssql">SQL Server (MSSQL)</option>
        <option value="mongodb">MongoDB</option>
        <option value="redis">Redis</option>
        <option value="clickhouse">ClickHouse</option>
      </select>

      {type !== 'sqlite' && (
        <div className="field-row">
          <div style={{ flex: 2 }}>
            <label className="form-label" htmlFor="conn-host">
              Host
            </label>
            <input
              id="conn-host"
              className="field"
              type="text"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                setTestResult(null);
              }}
              required
            />
          </div>
          <div style={{ flex: 1 }}>
            <label className="form-label" htmlFor="conn-port">
              Port
            </label>
            <input
              id="conn-port"
              className="field"
              type="number"
              value={port}
              onChange={(e) => {
                setPort(e.target.value);
                setTestResult(null);
              }}
              required
            />
          </div>
        </div>
      )}

      <label className="form-label" htmlFor="conn-database">
        {type === 'sqlite' ? 'Database File Path' : 'Database'}
      </label>
      <input
        id="conn-database"
        className="field"
        type="text"
        placeholder={type === 'sqlite' ? '/path/to/database.db or :memory:' : 'e.g. my_database'}
        value={database}
        onChange={(e) => {
          setDatabase(e.target.value);
          setTestResult(null);
        }}
        required
      />

      {type !== 'sqlite' && (
        <>
          <label className="form-label" htmlFor="conn-username">
            Username
          </label>
          <input
            id="conn-username"
            className="field"
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setTestResult(null);
            }}
          />

          <label className="form-label" htmlFor="conn-password">
            Password
          </label>
          <input
            id="conn-password"
            className="field"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setTestResult(null);
            }}
          />
        </>
      )}

      <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={testing}>
        {testing ? 'Testing…' : 'Test connection'}
      </button>

      {testResult && (
        <div className={testResult.ok ? 'callout callout-ok' : 'callout callout-error'} style={{ marginTop: 8 }}>
          {testResult.ok ? 'Connection successful.' : `Error: ${testResult.error}`}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={testResult?.ok ? 'btn btn-success' : 'btn btn-ghost'} disabled={!testResult?.ok}>
          Save
        </button>
      </div>
    </form>
  );
}
