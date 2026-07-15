import React, { useState } from 'react';

interface Props {
  onSubmit: (config: any) => Promise<void>;
}

export default function ConnectionForm({ onSubmit }: Props) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('postgres');
  const [password, setPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  async function handleTest() {
    setTesting(true);
    try {
      const result = await window.ipc.connections.test({
        type: 'postgres',
        host,
        port: parseInt(port, 10),
        database,
        username,
        password,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, error: String(error) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!testResult?.ok) {
      alert('Please test the connection first');
      return;
    }
    try {
      await onSubmit({
        name,
        type: 'postgres',
        host,
        port: parseInt(port, 10),
        database,
        username,
        password,
      });
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const inputStyle = { width: '100%', padding: '6px', marginBottom: '8px', border: '1px solid #ddd', borderRadius: '4px', fontSize: '12px' };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Connection name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Host"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="number"
        placeholder="Port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Database"
        value={database}
        onChange={(e) => setDatabase(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        style={inputStyle}
      />

      <button
        type="button"
        onClick={handleTest}
        disabled={testing}
        style={{
          width: '100%',
          padding: '6px',
          marginBottom: '8px',
          backgroundColor: '#6c757d',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: testing ? 'wait' : 'pointer',
          fontSize: '12px',
        }}
      >
        {testing ? 'Testing...' : 'Test Connection'}
      </button>

      {testResult && (
        <div
          style={{
            padding: '8px',
            marginBottom: '8px',
            borderRadius: '4px',
            backgroundColor: testResult.ok ? '#d4edda' : '#f8d7da',
            color: testResult.ok ? '#155724' : '#721c24',
            fontSize: '12px',
          }}
        >
          {testResult.ok ? 'Connection successful!' : `Error: ${testResult.error}`}
        </div>
      )}

      <button
        type="submit"
        disabled={!testResult?.ok}
        style={{
          width: '100%',
          padding: '6px',
          backgroundColor: testResult?.ok ? '#28a745' : '#ccc',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: testResult?.ok ? 'pointer' : 'not-allowed',
          fontSize: '12px',
        }}
      >
        Save Connection
      </button>
    </form>
  );
}
