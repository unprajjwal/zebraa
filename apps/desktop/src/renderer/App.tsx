import React, { useState, useEffect } from 'react';
import ConnectionsList from './components/ConnectionsList';
import ConnectionForm from './components/ConnectionForm';
import DatabaseTypeSelector from './components/DatabaseTypeSelector';
import TableTree from './components/TableTree';
import QueryWorkspace from './components/QueryWorkspace';
import AIPanel from './components/AIPanel';
import WelcomeScreen from './components/WelcomeScreen';
import ThemeToggle from './components/ThemeToggle';
import type { ConnectionDTO, AdapterType, SchemaInfo } from '@zebraa/core';
import { getActiveIpc } from './ipc';

export default function App() {
  const [entered, setEntered] = useState(false);
  const [connections, setConnections] = useState<ConnectionDTO[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addStep, setAddStep] = useState<'select-type' | 'configure'>('select-type');
  const [selectedDbType, setSelectedDbType] = useState<AdapterType>('postgres');

  // Schema state lifted from SchemaBrowser
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [openTableSignal, setOpenTableSignal] = useState<{ tableName: string; timestamp: number } | null>(null);

  // Left & Right panel resize & collapse state
  const [leftWidth, setLeftWidth] = useState(264);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);

  const [rightWidth, setRightWidth] = useState(320);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);

  useEffect(() => {
    loadConnections();
  }, []);

  useEffect(() => {
    if (!selectedConnectionId) {
      setSchema(null);
      setSchemaLoading(false);
      setSchemaError(null);
      return;
    }

    let canceled = false;
    setSchemaLoading(true);
    setSchemaError(null);

    getActiveIpc()
      .schema.get(selectedConnectionId)
      .then((data) => {
        if (!canceled) {
          setSchema(data);
          setSchemaLoading(false);
        }
      })
      .catch((err) => {
        if (!canceled) {
          setSchemaError(err instanceof Error ? err.message : String(err));
          setSchemaLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [selectedConnectionId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && showAddForm) {
        handleCancelAdd();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddForm]);

  async function loadConnections() {
    try {
      const list = await getActiveIpc().connections.list();
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
      await getActiveIpc().connections.create(config);
      handleCancelAdd();
      await loadConnections();
    } catch (error) {
      console.error('Failed to create connection:', error);
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleDeleteConnection(id: string) {
    try {
      await getActiveIpc().connections.delete(id);
      if (selectedConnectionId === id) {
        setSelectedConnectionId(null);
      }
      await loadConnections();
    } catch (error) {
      console.error('Failed to delete connection:', error);
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function startLeftResize(e: React.MouseEvent) {
    e.preventDefault();
    setIsDraggingLeft(true);
    const startX = e.clientX;
    const startWidth = leftWidth;

    function onMouseMove(moveEvent: MouseEvent) {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(200, Math.min(500, startWidth + delta));
      setLeftWidth(newWidth);
    }

    function onMouseUp() {
      setIsDraggingLeft(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function startRightResize(e: React.MouseEvent) {
    e.preventDefault();
    setIsDraggingRight(true);
    const startX = e.clientX;
    const startWidth = rightWidth;

    function onMouseMove(moveEvent: MouseEvent) {
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(200, Math.min(600, startWidth + delta));
      setRightWidth(newWidth);
    }

    function onMouseUp() {
      setIsDraggingRight(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  const selectedConnection = connections.find((c) => c.id === selectedConnectionId) || null;
  const currentAdapterType = selectedConnection?.type;

  if (!entered) {
    return <WelcomeScreen onEnter={() => setEntered(true)} />;
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar__brand">
          <span className="topbar__brand-mark" aria-hidden="true" />
          <span className="topbar__brand-text">Zebraa</span>
          <button
            type="button"
            className="topbar__add-btn"
            onClick={() => handleStartAdd()}
            title="New Connection"
            aria-label="New Connection"
          >
            +
          </button>
        </div>
        <div className="topbar__right">
          <ThemeToggle />
        </div>
      </div>

      <div className="app__body">
        {leftCollapsed ? (
          <div
            className="sidebar--collapsed"
            onClick={() => setLeftCollapsed(false)}
            title="Click to expand Left Panel"
          >
            <button
              type="button"
              className="panel-collapse-btn"
              onClick={(e) => {
                e.stopPropagation();
                setLeftCollapsed(false);
              }}
              title="Expand Left Panel"
            >
              »
            </button>
            <span className="sidebar--collapsed__icon">⚡</span>
            <div className="sidebar--collapsed__label">Connections</div>
          </div>
        ) : (
          <div className="sidebar" style={{ width: `${leftWidth}px` }}>
            <div className="sidebar__conn-section">
              <div className="panel-heading">
                <span>Connections</span>
                <button
                  type="button"
                  className="panel-collapse-btn"
                  onClick={() => setLeftCollapsed(true)}
                  title="Collapse Left Panel"
                >
                  «
                </button>
              </div>
              <div className="sidebar__list">
                <ConnectionsList
                  connections={connections}
                  selectedId={selectedConnectionId}
                  onSelect={setSelectedConnectionId}
                  onDelete={handleDeleteConnection}
                />
              </div>
            </div>

            {selectedConnectionId && (
              <div className="sidebar__table-section">
                <TableTree
                  schema={schema}
                  loading={schemaLoading}
                  error={schemaError}
                  adapterType={currentAdapterType}
                  onOpenTable={(tableName) =>
                    setOpenTableSignal({ tableName, timestamp: Date.now() })
                  }
                />
              </div>
            )}
          </div>
        )}

        {!leftCollapsed && (
          <div
            className={`resize-handle resize-handle--left ${isDraggingLeft ? 'dragging' : ''}`}
            onMouseDown={startLeftResize}
            onDoubleClick={() => setLeftWidth(264)}
            title="Drag to resize Left Panel, double-click to reset"
          />
        )}

        <div className="center">
          {selectedConnectionId ? (
            <QueryWorkspace
              connectionId={selectedConnectionId}
              adapterType={currentAdapterType}
              schema={schema}
              openTableSignal={openTableSignal}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-state__title">No connection selected</div>
              <div className="empty-state__subtitle">
                Select a database system to get started connecting to your data store:
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

        {!rightCollapsed && (
          <div
            className={`resize-handle resize-handle--right ${isDraggingRight ? 'dragging' : ''}`}
            onMouseDown={startRightResize}
            onDoubleClick={() => setRightWidth(320)}
            title="Drag to resize Right Panel, double-click to reset"
          />
        )}

        {rightCollapsed ? (
          <div
            className="aipanel--collapsed"
            onClick={() => setRightCollapsed(false)}
            title="Click to expand Right Panel"
          >
            <button
              type="button"
              className="panel-collapse-btn"
              onClick={(e) => {
                e.stopPropagation();
                setRightCollapsed(false);
              }}
              title="Expand Right Panel"
            >
              «
            </button>
            <span className="aipanel__spark" aria-hidden="true" style={{ width: 22, height: 22 }}>
              ✦
            </span>
            <div className="aipanel--collapsed__label">AI Panel</div>
          </div>
        ) : (
          <div className="aipanel" style={{ width: `${rightWidth}px` }}>
            <AIPanel onCollapse={() => setRightCollapsed(true)} />
          </div>
        )}
      </div>

      {showAddForm && (
        <div
          className="modal-overlay"
          onClick={handleCancelAdd}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
        >
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <span className="modal-icon" aria-hidden="true">⚡</span>
                <h2 id="modal-title" className="modal-title">
                  {addStep === 'select-type' ? 'New Connection' : 'Configure Connection'}
                </h2>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={handleCancelAdd}
                title="Close (Esc)"
                aria-label="Close modal"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              {addStep === 'select-type' ? (
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
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
