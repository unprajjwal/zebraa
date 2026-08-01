import React, { useState, useEffect } from 'react';
import ConnectionsList from './components/ConnectionsList';
import ConnectionForm from './components/ConnectionForm';
import DatabaseTypeSelector from './components/DatabaseTypeSelector';
import SchemaBrowser from './components/SchemaBrowser';
import AIPanel from './components/AIPanel';
import WelcomeScreen from './components/WelcomeScreen';
import ThemeToggle from './components/ThemeToggle';
import type { ConnectionDTO, AdapterType } from '@zebraa/core';
import { getActiveIpc } from './ipc';

export default function App() {
  const [entered, setEntered] = useState(false);
  const [connections, setConnections] = useState<ConnectionDTO[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addStep, setAddStep] = useState<'select-type' | 'configure'>('select-type');
  const [selectedDbType, setSelectedDbType] = useState<AdapterType>('postgres');

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
      const newWidth = Math.max(180, Math.min(500, startWidth + delta));
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
    </div>
  );
}
