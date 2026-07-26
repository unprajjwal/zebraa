import React from 'react';

export default function AIPanel() {
  return (
    <>
      <div className="aipanel__head">
        <span className="aipanel__spark" aria-hidden="true">
          ✦
        </span>
        <span className="aipanel__title">AI Assistant</span>
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
