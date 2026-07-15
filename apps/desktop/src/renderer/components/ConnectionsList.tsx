import React from 'react';
import type { ConnectionDTO } from '@zebraa/core';

interface Props {
  connections: ConnectionDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function ConnectionsList({ connections, selectedId, onSelect, onDelete }: Props) {
  return (
    <div>
      {connections.map((conn) => (
        <div
          key={conn.id}
          onClick={() => onSelect(conn.id)}
          style={{
            padding: '8px',
            marginBottom: '8px',
            borderRadius: '4px',
            backgroundColor: selectedId === conn.id ? '#e7f3ff' : '#f9f9f9',
            border: selectedId === conn.id ? '1px solid #007bff' : '1px solid #ddd',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '12px' }}>{conn.name}</div>
            <div style={{ fontSize: '11px', color: '#666' }}>
              {conn.type} @ {conn.host}:{conn.port}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(conn.id);
            }}
            style={{
              backgroundColor: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '3px',
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
