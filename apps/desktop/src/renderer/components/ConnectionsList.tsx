import React from 'react';
import type { ConnectionDTO } from '@zebraa/core';

interface Props {
  connections: ConnectionDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function ConnectionsList({ connections, selectedId, onSelect, onDelete }: Props) {
  if (connections.length === 0) {
    return (
      <div className="empty-state" style={{ height: 'auto', padding: '20px 8px' }}>
        No connections yet.
      </div>
    );
  }

  return (
    <>
      {connections.map((conn) => (
        <div
          key={conn.id}
          onClick={() => onSelect(conn.id)}
          className={`conn-card${selectedId === conn.id ? ' active' : ''}`}
        >
          <span className="conn-card__dot" aria-hidden="true" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="conn-card__name">{conn.name}</div>
            <div className="conn-card__meta">
              {conn.type} · {conn.host}:{conn.port}
            </div>
          </div>
          <button
            className="conn-card__delete"
            aria-label={`Delete ${conn.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(conn.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}
