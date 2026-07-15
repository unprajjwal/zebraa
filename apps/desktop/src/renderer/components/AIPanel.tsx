import React from 'react';

export default function AIPanel() {
  return (
    <div>
      <h2 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 'bold' }}>AI Assistant</h2>
      <div style={{ color: '#999', fontSize: '12px', lineHeight: '1.6' }}>
        <p>AI features coming in phase 2.</p>
        <p>Will include:</p>
        <ul style={{ paddingLeft: '16px', margin: '8px 0' }}>
          <li>Schema summarization</li>
          <li>Natural language SQL generation</li>
          <li>Query result analysis</li>
        </ul>
      </div>
    </div>
  );
}
