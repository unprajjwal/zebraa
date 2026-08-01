import React, { useState, useEffect } from 'react';
import type { SchemaInfo } from '@zebraa/core';
import { getActiveIpc } from '../ipc';

interface Props {
  connectionId: string;
}

export default function SchemaBrowser({ connectionId }: Props) {
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSchema();
  }, [connectionId]);

  async function loadSchema() {
    setLoading(true);
    setError(null);
    try {
      const data = await getActiveIpc().schema.get(connectionId);
      setSchema(data);
      if (data.tables.length > 0) {
        setExpandedTable(data.tables[0].name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="empty-state">Loading schema…</div>;
  if (error) return <div className="empty-state" style={{ color: 'var(--danger)' }}>Error: {error}</div>;
  if (!schema) return <div className="empty-state">No schema</div>;

  return (
    <div className="schema">
      <div className="schema__header">
        <div className="schema__title">Tables</div>
        <div className="schema__count">{schema.tables.length} total</div>
      </div>

      {schema.tables.length === 0 ? (
        <div className="empty-state">No tables found</div>
      ) : (
        schema.tables.map((table) => {
          const open = expandedTable === table.name;
          return (
            <div key={table.name} className="table-card">
              <div className="table-card__head" onClick={() => setExpandedTable(open ? null : table.name)}>
                <span className={`table-card__caret${open ? ' open' : ''}`}>▶</span>
                <span className="table-card__name">{table.name}</span>
                <span className="table-card__colcount">{table.columns.length} cols</span>
              </div>
              {open && (
                <div>
                  {table.columns.map((col) => (
                    <div key={col.name} className="col-row">
                      <span className="col-row__name">{col.name}</span>
                      <span className="col-row__type">{col.type}</span>
                      <span className="col-row__badge">
                        {!col.nullable && 'NOT NULL'}
                        {col.default && ` · DEFAULT ${col.default}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
