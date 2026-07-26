import React, { useState } from 'react';
import type { AdapterType } from '@zebraa/core';

interface Props {
  selectedType?: AdapterType | null;
  onSelectType: (type: AdapterType) => void;
  onCancel?: () => void;
}

interface DbTypeOption {
  type: AdapterType;
  name: string;
  portText: string;
  description: string;
  iconClass: string;
  renderIcon: () => React.ReactNode;
}

const dbOptions: DbTypeOption[] = [
  {
    type: 'postgres',
    name: 'PostgreSQL',
    portText: 'Port 5432',
    description: 'Advanced open-source relational database',
    iconClass: 'db-type-card__icon--postgres',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
        <path d="M7 10c1.5-2 4-2.5 6-1 2 1.5 2.5 4 1 6-1 1.5-3.5 2-5 1" />
        <path d="M9 17v-4" />
      </svg>
    ),
  },
  {
    type: 'mysql',
    name: 'MySQL',
    portText: 'Port 3306',
    description: 'Popular open-source relational database',
    iconClass: 'db-type-card__icon--mysql',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
        <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
      </svg>
    ),
  },
  {
    type: 'sqlite',
    name: 'SQLite',
    portText: 'File-based',
    description: 'Lightweight file-based embedded SQL database',
    iconClass: 'db-type-card__icon--sqlite',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <line x1="10" y1="9" x2="8" y2="9" />
      </svg>
    ),
  },
  {
    type: 'mariadb',
    name: 'MariaDB',
    portText: 'Port 3306',
    description: 'Fast open-source relational database server',
    iconClass: 'db-type-card__icon--mariadb',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v18" />
        <path d="M5 8l7-5 7 5" />
        <path d="M5 16l7 5 7-5" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    type: 'mssql',
    name: 'SQL Server',
    portText: 'Port 1433',
    description: 'Enterprise relational database management system',
    iconClass: 'db-type-card__icon--mssql',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18" />
        <path d="M3 15h18" />
        <path d="M9 3v18" />
      </svg>
    ),
  },
  {
    type: 'mongodb',
    name: 'MongoDB',
    portText: 'Port 27017',
    description: 'Document-oriented NoSQL database',
    iconClass: 'db-type-card__icon--mongodb',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z" />
        <path d="M12 2v16" />
      </svg>
    ),
  },
  {
    type: 'redis',
    name: 'Redis',
    portText: 'Port 6379',
    description: 'In-memory data structure store & cache',
    iconClass: 'db-type-card__icon--redis',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    type: 'clickhouse',
    name: 'ClickHouse',
    portText: 'Port 8123',
    description: 'Column-oriented DBMS for real-time analytics',
    iconClass: 'db-type-card__icon--clickhouse',
    renderIcon: () => (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
];

export default function DatabaseTypeSelector({ selectedType: initialSelected, onSelectType, onCancel }: Props) {
  const [selected, setSelected] = useState<AdapterType>(initialSelected || 'postgres');

  function handleCardClick(type: AdapterType) {
    setSelected(type);
  }

  function handleContinue() {
    onSelectType(selected);
  }

  return (
    <div className="db-type-selector">
      <div className="db-type-selector__header">
        <h3 className="db-type-selector__title">Select Database Type</h3>
        <p className="db-type-selector__subtitle">
          Choose your database system to configure connection details.
        </p>
      </div>

      <div className="db-type-grid" role="radiogroup" aria-label="Database Type Selection">
        {dbOptions.map((opt) => (
          <div
            key={opt.type}
            role="radio"
            aria-checked={selected === opt.type}
            tabIndex={0}
            className={`db-type-card ${selected === opt.type ? 'selected' : ''}`}
            onClick={() => handleCardClick(opt.type)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleCardClick(opt.type);
              }
            }}
          >
            <div className={`db-type-card__icon ${opt.iconClass}`}>
              {opt.renderIcon()}
            </div>
            <div className="db-type-card__info">
              <div className="db-type-card__name-row">
                <span className="db-type-card__name">{opt.name}</span>
                <span className="db-type-card__port">{opt.portText}</span>
              </div>
              <div className="db-type-card__desc">{opt.description}</div>
            </div>
            <div className="db-type-card__radio">
              <div className="db-type-card__radio-inner" />
            </div>
          </div>
        ))}
      </div>

      <div className="db-type-selector__actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleContinue}
        >
          Continue to Details →
        </button>
      </div>
    </div>
  );
}
