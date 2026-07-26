import React, { useState, useEffect } from 'react';
import ConnectionsList from './components/ConnectionsList';
import ConnectionForm from './components/ConnectionForm';
import DatabaseTypeSelector from './components/DatabaseTypeSelector';
import SchemaBrowser from './components/SchemaBrowser';
import AIPanel from './components/AIPanel';
import WelcomeScreen from './components/WelcomeScreen';
import ThemeToggle from './components/ThemeToggle';
import type { ConnectionDTO, AdapterType } from '@zebraa/core';

export default function App() {
  const [entered, setEntered] = useState(false);
  const [connections, setConnections] = useState<ConnectionDTO[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addStep, setAddStep] = useState<'select-type' | 'configure'>('select-type');
  const [selectedDbType, setSelectedDbType] = useState<AdapterType>('postgres');

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

  function handleStartAdd(type?: AdapterType) {
    setShowAddForm(true);
    if (type) {
      setSelectedDbType(type);
      setAddStep('configure');
    } else {
      setAddStep('select-type');
    }
  }

  function handleCancelAdd() {
    setShowAddForm(false);
    setAddStep('select-type');
  }

  async function handleAddConnection(config: any) {
    try {
      await window.ipc.connections.create(config);
      handleCancelAdd();
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

  if (!entered) {
    return <WelcomeScreen onEnter={() => setEntered(true)} />;
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar__brand">
          <span className="topbar__brand-mark" aria-hidden="true" />
          Zebraa
        </div>
        <div className="topbar__right">
          <ThemeToggle />
        </div>
      </div>

      <div className="app__body">
        <div className="sidebar">
          <div className="panel-heading">Connections</div>
          <div className="sidebar__list">
            <ConnectionsList
              connections={connections}
              selectedId={selectedConnectionId}
              onSelect={setSelectedConnectionId}
              onDelete={handleDeleteConnection}
            />
          </div>
          <div className="sidebar__footer">
            {showAddForm ? (
              addStep === 'select-type' ? (
                <DatabaseTypeSelector
                  selectedType={selectedDbType}
                  onSelectType={(type) => {
                    setSelectedDbType(type);
                    setAddStep('configure');
                  }}
                  onCancel={handleCancelAdd}
                />
              ) : (
                <ConnectionForm
                  initialType={selectedDbType}
                  onBack={() => setAddStep('select-type')}
                  onSubmit={handleAddConnection}
                  onCancel={handleCancelAdd}
                />
              )
            ) : (
              <button className="btn btn-primary" onClick={() => handleStartAdd()}>
                + Add connection
              </button>
            )}
          </div>
        </div>

        <div className="center">
          {selectedConnectionId ? (
            <SchemaBrowser connectionId={selectedConnectionId} />
          ) : (
            <div className="empty-state">
              <div className="empty-state__title">No connection selected</div>
              <div className="empty-state__subtitle">
                Select a database type to get started connecting to your database:
              </div>
              <div className="empty-state__quick-cards">
                <button
                  type="button"
                  className="quick-db-card quick-db-card--postgres"
                  onClick={() => handleStartAdd('postgres')}
                >
                  <span className="quick-db-card__badge">PG</span>
                  <div className="quick-db-card__info">
                    <span className="quick-db-card__name">PostgreSQL</span>
                    <span className="quick-db-card__port">Port 5432</span>
                  </div>
                  <span className="quick-db-card__arrow">→</span>
                </button>
                <button
                  type="button"
                  className="quick-db-card quick-db-card--mysql"
                  onClick={() => handleStartAdd('mysql')}
                >
                  <span className="quick-db-card__badge">MY</span>
                  <div className="quick-db-card__info">
                    <span className="quick-db-card__name">MySQL</span>
                    <span className="quick-db-card__port">Port 3306</span>
                  </div>
                  <span className="quick-db-card__arrow">→</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="aipanel">
          <AIPanel />
        </div>
      </div>
    </div>
  );
}
