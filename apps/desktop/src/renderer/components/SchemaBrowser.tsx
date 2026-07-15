import React, { useState, useEffect } from 'react';
import type { SchemaInfo, TableInfo } from '@zebraa/core';

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
      const data = await window.ipc.schema.get(connectionId);
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

  if (loading) return <div style={{ padding: '16px', color: '#999' }}>Loading schema...</div>;
  if (error) return <div style={{ padding: '16px', color: '#d32f2f' }}>Error: {error}</div>;
  if (!schema) return <div style={{ padding: '16px', color: '#999' }}>No schema</div>;

  return (
    <div style={{ padding: '16px', overflow: 'auto' }}>
      <h2 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>Tables</h2>
      {schema.tables.length === 0 ? (
        <div style={{ color: '#999' }}>No tables found</div>
      ) : (
        schema.tables.map((table) => (
          <div key={table.name} style={{ marginBottom: '12px' }}>
            <div
              onClick={() => setExpandedTable(expandedTable === table.name ? null : table.name)}
              style={{
                cursor: 'pointer',
                padding: '8px',
                backgroundColor: '#f0f0f0',
                borderRadius: '4px',
                fontWeight: 'bold',
                fontSize: '12px',
                userSelect: 'none',
              }}
            >
              {expandedTable === table.name ? '▼' : '▶'} {table.name}
            </div>
            {expandedTable === table.name && (
              <div style={{ marginLeft: '12px', marginTop: '8px' }}>
                {table.columns.map((col) => (
                  <div
                    key={col.name}
                    style={{
                      padding: '6px 8px',
                      backgroundColor: '#fafafa',
                      borderRadius: '3px',
                      marginBottom: '4px',
                      fontSize: '11px',
                      borderLeft: '2px solid #007bff',
                    }}
                  >
                    <strong>{col.name}</strong> {col.type}
                    {!col.nullable && ' NOT NULL'}
                    {col.default && ` DEFAULT ${col.default}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
