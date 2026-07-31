import React from 'react';

interface AIPanelProps {
  onCollapse?: () => void;
}

export default function AIPanel({ onCollapse }: AIPanelProps) {
  return (
    <>
      <div className="aipanel__head">
        <span className="aipanel__spark" aria-hidden="true">
          ✦
        </span>
        <span className="aipanel__title">AI Assistant</span>
        {onCollapse && (
          <button
            type="button"
            className="panel-collapse-btn"
            onClick={onCollapse}
            title="Collapse AI Panel"
            style={{ marginLeft: 'auto' }}
          >
            »
          </button>
        )}
      </div>
      <div className="aipanel__body">
        <p className="aipanel__note">Ask questions about this database in plain English. Coming in phase 2:</p>
        <ul className="aipanel__list">
          <li>Schema summarization</li>
          <li>Natural language → SQL generation</li>
          <li>Query result analysis</li>
        </ul>
      </div>
    </>
  );
}
