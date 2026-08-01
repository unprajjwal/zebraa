import React, { useState, useEffect, useRef } from 'react';
import type { RowSet, SchemaInfo } from '@zebraa/core';
import SqlEditor from './SqlEditor';
import ResultsGrid from './ResultsGrid';
import { getActiveIpc } from '../ipc';

export interface Tab {
  id: string;
  title: string;
  tableName?: string;
  sql: string;
  result: RowSet | null;
  error: string | null;
  running: boolean;
  elapsedMs: number | null;
  explainPlan: string | null;
}

interface QueryWorkspaceProps {
  connectionId: string;
  schema: SchemaInfo | null;
  openTableSignal?: { tableName: string; timestamp: number } | null;
  onRegisterOpenTable?: (fn: (tableName: string) => void) => void;
}

export default function QueryWorkspace({
  connectionId,
  schema,
  openTableSignal,
  onRegisterOpenTable,
}: QueryWorkspaceProps) {
  // Tabs per connection
  const [tabsByConnection, setTabsByConnection] = useState<Record<string, Tab[]>>({});
  const [activeTabIdByConnection, setActiveTabIdByConnection] = useState<Record<string, string>>({});
  const [queryCounterByConnection, setQueryCounterByConnection] = useState<Record<string, number>>({});

  // Vertical split state between SqlEditor and ResultsGrid
  const [splitRatio, setSplitRatio] = useState(0.38); // 38% top, 62% bottom
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentTabs = tabsByConnection[connectionId] || [];
  const currentActiveTabId = activeTabIdByConnection[connectionId] || '';
  const activeTab = currentTabs.find((t) => t.id === currentActiveTabId) || null;

  // Handle openTableSignal updates from parent
  useEffect(() => {
    if (openTableSignal && openTableSignal.tableName) {
      openTable(openTableSignal.tableName);
    }
  }, [openTableSignal]);

  // Register openTable handler if callback provided
  useEffect(() => {
    if (onRegisterOpenTable) {
      onRegisterOpenTable(openTable);
    }
  }, [connectionId, onRegisterOpenTable]);

  function updateTabsForConnection(
    updater: (prevTabs: Tab[]) => Tab[],
    newActiveTabId?: string
  ) {
    setTabsByConnection((prev) => {
      const connTabs = prev[connectionId] || [];
      const updated = updater(connTabs);
      return { ...prev, [connectionId]: updated };
    });

    if (newActiveTabId !== undefined) {
      setActiveTabIdByConnection((prev) => ({
        ...prev,
        [connectionId]: newActiveTabId,
      }));
    }
  }

  function openTable(tableName: string) {
    const escaped = tableName.replace(/"/g, '""');
    const sampleSql = `select * from "${escaped}" limit 200`;

    setTabsByConnection((prev) => {
      const connTabs = prev[connectionId] || [];
      const existing = connTabs.find((t) => t.tableName === tableName || t.title === tableName);

      if (existing) {
        setActiveTabIdByConnection((p) => ({ ...p, [connectionId]: existing.id }));
        return prev;
      }

      const newTabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const newTab: Tab = {
        id: newTabId,
        title: tableName,
        tableName,
        sql: sampleSql,
        result: null,
        error: null,
        running: true,
        elapsedMs: null,
        explainPlan: null,
      };

      setActiveTabIdByConnection((p) => ({ ...p, [connectionId]: newTabId }));

      // Run sample query
      const startTime = performance.now();
      getActiveIpc()
        .table.sample(connectionId, tableName, 200)
        .then((res) => {
          const elapsed = Math.round(performance.now() - startTime);
          setTabsByConnection((latest) => {
            const tabs = latest[connectionId] || [];
            return {
              ...latest,
              [connectionId]: tabs.map((t) =>
                t.id === newTabId
                  ? { ...t, result: res, elapsedMs: elapsed, running: false, error: null }
                  : t
              ),
            };
          });
        })
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          setTabsByConnection((latest) => {
            const tabs = latest[connectionId] || [];
            return {
              ...latest,
              [connectionId]: tabs.map((t) =>
                t.id === newTabId ? { ...t, error: errMsg, running: false } : t
              ),
            };
          });
        });

      return { ...prev, [connectionId]: [...connTabs, newTab] };
    });
  }

  function createNewQueryTab() {
    const currentCounter = (queryCounterByConnection[connectionId] || 0) + 1;
    setQueryCounterByConnection((prev) => ({ ...prev, [connectionId]: currentCounter }));

    const newTabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const title = `Query ${currentCounter}`;
    const newTab: Tab = {
      id: newTabId,
      title,
      sql: '',
      result: null,
      error: null,
      running: false,
      elapsedMs: null,
      explainPlan: null,
    };

    updateTabsForConnection((prev) => [...prev, newTab], newTabId);
  }

  function closeTab(tabIdToClose: string, e?: React.MouseEvent) {
    if (e) e.stopPropagation();

    const connTabs = tabsByConnection[connectionId] || [];
    const index = connTabs.findIndex((t) => t.id === tabIdToClose);
    if (index === -1) return;

    const newTabs = connTabs.filter((t) => t.id !== tabIdToClose);
    let nextActiveId = activeTabIdByConnection[connectionId] || '';

    if (currentActiveTabId === tabIdToClose) {
      if (newTabs.length > 0) {
        const nextIndex = Math.min(index, newTabs.length - 1);
        nextActiveId = newTabs[nextIndex].id;
      } else {
        nextActiveId = '';
      }
    }

    updateTabsForConnection(() => newTabs, nextActiveId);
  }

  function updateActiveTabSql(newSql: string) {
    if (!activeTab) return;
    updateTabsForConnection((tabs) =>
      tabs.map((t) => (t.id === activeTab.id ? { ...t, sql: newSql } : t))
    );
  }

  async function runQuery() {
    if (!activeTab || !activeTab.sql.trim()) return;

    const tabId = activeTab.id;
    const sqlToRun = activeTab.sql;

    updateTabsForConnection((tabs) =>
      tabs.map((t) => (t.id === tabId ? { ...t, running: true, error: null, explainPlan: null } : t))
    );

    const startTime = performance.now();
    try {
      const res = await getActiveIpc().query.execute(connectionId, sqlToRun, { rowLimit: 1000 });
      const elapsed = Math.round(performance.now() - startTime);

      updateTabsForConnection((tabs) =>
        tabs.map((t) =>
          t.id === tabId
            ? { ...t, result: res, elapsedMs: elapsed, running: false, error: null, explainPlan: null }
            : t
        )
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateTabsForConnection((tabs) =>
        tabs.map((t) => (t.id === tabId ? { ...t, error: errMsg, running: false } : t))
      );
    }
  }

  async function explainQuery() {
    if (!activeTab || !activeTab.sql.trim()) return;

    const tabId = activeTab.id;
    const sqlToRun = activeTab.sql;

    updateTabsForConnection((tabs) =>
      tabs.map((t) => (t.id === tabId ? { ...t, running: true, error: null } : t))
    );

    try {
      const plan = await getActiveIpc().query.explain(connectionId, sqlToRun);
      updateTabsForConnection((tabs) =>
        tabs.map((t) => (t.id === tabId ? { ...t, explainPlan: plan, running: false, error: null } : t))
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateTabsForConnection((tabs) =>
        tabs.map((t) => (t.id === tabId ? { ...t, error: errMsg, running: false } : t))
      );
    }
  }

  // Vertical resize handle
  function startSplitResize(e: React.MouseEvent) {
    e.preventDefault();
    setIsDraggingSplit(true);
    const startY = e.clientY;
    const startRatio = splitRatio;
    const containerHeight = containerRef.current?.getBoundingClientRect().height || 600;

    function onMouseMove(moveEvent: MouseEvent) {
      const deltaY = moveEvent.clientY - startY;
      const deltaRatio = deltaY / containerHeight;
      const newRatio = Math.max(0.15, Math.min(0.85, startRatio + deltaRatio));
      setSplitRatio(newRatio);
    }

    function onMouseUp() {
      setIsDraggingSplit(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  return (
    <div className="workspace">
      {/* Workspace Header / Tab Bar */}
      <div className="qtab-bar">
        <div className="qtab-bar__scroll">
          {currentTabs.map((tab) => {
            const isActive = tab.id === currentActiveTabId;
            return (
              <div
                key={tab.id}
                className={`qtab ${isActive ? 'qtab--active' : ''}`}
                onClick={() =>
                  setActiveTabIdByConnection((prev) => ({ ...prev, [connectionId]: tab.id }))
                }
              >
                <span className="qtab__title" title={tab.title}>
                  {tab.title}
                </span>
                <button
                  type="button"
                  className="qtab__close"
                  onClick={(e) => closeTab(tab.id, e)}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          className="qtab-bar__add-btn"
          onClick={createNewQueryTab}
          title="New SQL query tab"
        >
          + SQL
        </button>
      </div>

      {/* Main Workspace Body */}
      {currentTabs.length === 0 ? (
        <div className="workspace__empty">
          <div className="workspace__empty-text">
            Pick a table to see its rows, or start a new query.
          </div>
          <button
            type="button"
            className="btn btn-primary workspace__empty-btn"
            onClick={createNewQueryTab}
          >
            + SQL
          </button>
        </div>
      ) : activeTab ? (
        <div ref={containerRef} className="workspace__content">
          <div
            className="workspace__editor-pane"
            style={{ height: `${splitRatio * 100}%` }}
          >
            <SqlEditor
              sql={activeTab.sql}
              onChange={updateActiveTabSql}
              onRun={runQuery}
              onExplain={explainQuery}
              running={activeTab.running}
              rowCount={activeTab.result ? activeTab.result.rowCount : null}
              elapsedMs={activeTab.elapsedMs}
              error={activeTab.error}
            />
          </div>

          <div
            className={`resize-handle-v ${isDraggingSplit ? 'dragging' : ''}`}
            onMouseDown={startSplitResize}
            onDoubleClick={() => setSplitRatio(0.38)}
            title="Drag to resize editor/results, double-click to reset"
          />

          <div
            className="workspace__results-pane"
            style={{ height: `${(1 - splitRatio) * 100}%` }}
          >
            <ResultsGrid
              result={activeTab.result}
              error={activeTab.error}
              explainPlan={activeTab.explainPlan}
              running={activeTab.running}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
