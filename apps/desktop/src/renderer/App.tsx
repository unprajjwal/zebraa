import React, { useState, useEffect } from 'react';
import ConnectionsList from './components/ConnectionsList';
import ConnectionForm from './components/ConnectionForm';
import SchemaBrowser from './components/SchemaBrowser';
import AIPanel from './components/AIPanel';
import type { ConnectionDTO } from '@zebraa/core';

export default function App() {
  const [connections, setConnections] = useState<ConnectionDTO[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    loadConnections();
  }, []);

  async function loadConnections() {
    try {
      const list = await window.ipc.connections.list();
      setConnections(list);
      if (list.length > 0 && !selectedConnectionId) {
        setSelectedConnectionId(list[0].id);
      }
    } catch (error) {
      console.error('Failed to load connections:', error);
    }
  }

  async function handleAddConnection(config: any) {
    try {
      await window.ipc.connections.create(config);
      setShowAddForm(false);
      await loadConnections();
    } catch (error) {
      console.error('Failed to create connection:', error);
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleDeleteConnection(id: string) {
    try {
      await window.ipc.connections.delete(id);
      if (selectedConnectionId === id) {
        setSelectedConnectionId(null);
      }
      await loadConnections();
    } catch (error) {
      console.error('Failed to delete connection:', error);
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      {/* Left sidebar */}
      <div style={{ width: '200px', borderRight: '1px solid #ddd', overflow: 'auto', padding: '8px' }}>
        <h2 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>Connections</h2>
        <ConnectionsList
          connections={connections}
          selectedId={selectedConnectionId}
          onSelect={setSelectedConnectionId}
          onDelete={handleDeleteConnection}
        />
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          style={{
            width: '100%',
            padding: '8px',
            marginTop: '12px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          {showAddForm ? 'Cancel' : 'Add Connection'}
        </button>
        {showAddForm && (
          <div style={{ marginTop: '12px' }}>
            <ConnectionForm onSubmit={handleAddConnection} />
          </div>
        )}
      </div>

      {/* Center panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedConnectionId ? (
          <SchemaBrowser connectionId={selectedConnectionId} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999' }}>
            No connection selected
          </div>
        )}
      </div>

      {/* Right panel */}
      <div style={{ width: '300px', borderLeft: '1px solid #ddd', overflow: 'auto', padding: '16px' }}>
        <AIPanel />
      </div>
    </div>
  );
}
