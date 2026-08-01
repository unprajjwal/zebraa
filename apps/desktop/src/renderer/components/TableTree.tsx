import React, { useState } from 'react';
import type { SchemaInfo } from '@zebraa/core';

interface TableTreeProps {
  schema: SchemaInfo | null;
  loading: boolean;
  error: string | null;
  onOpenTable: (tableName: string) => void;
}

export default function TableTree({ schema, loading, error, onOpenTable }: TableTreeProps) {
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});

  function toggleTable(tableName: string) {
    setExpandedTables((prev) => ({
      ...prev,
      [tableName]: !prev[tableName],
    }));
  }

  if (loading) {
    return <div className="table-tree__empty">Loading tables…</div>;
  }

  if (error) {
    return <div className="table-tree__empty table-tree__empty--error">Error: {error}</div>;
  }

  if (!schema || schema.tables.length === 0) {
    return <div className="table-tree__empty">No tables found</div>;
  }

  return (
    <div className="table-tree">
      <div className="panel-heading">
        <span>Tables</span>
        <span className="table-tree__total-count">{schema.tables.length}</span>
      </div>

      <div className="table-tree__list">
        {schema.tables.map((table) => {
          const isOpen = Boolean(expandedTables[table.name]);
          const primaryKeys = new Set(table.primaryKeys || []);

          return (
            <div key={table.name} className="table-tree__item">
              <div className="table-tree__row" onClick={() => onOpenTable(table.name)}>
                <button
                  type="button"
                  className={`table-tree__caret ${isOpen ? 'open' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleTable(table.name);
                  }}
                  title={isOpen ? 'Collapse columns' : 'Expand columns'}
                >
                  ▶
                </button>
                <span className="table-tree__name" title={table.name}>
                  {table.name}
                </span>
                <span className="table-tree__col-count">{table.columns.length}</span>
              </div>

              {isOpen && (
                <div className="table-tree__columns">
                  {table.columns.map((col) => {
                    const isPk = primaryKeys.has(col.name);
                    return (
                      <div key={col.name} className="table-tree__col-row">
                        <span className="table-tree__col-name">
                          {isPk && <span className="table-tree__pk-badge" title="Primary Key">🔑 </span>}
                          {col.name}
                        </span>
                        <span className="table-tree__col-type">{col.type}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
