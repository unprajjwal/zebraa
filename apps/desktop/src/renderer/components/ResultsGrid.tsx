import React from 'react';
import type { RowSet } from '@zebraa/core';
import { isTauriEnvironment } from '../ipc';

interface ResultsGridProps {
  result: RowSet | null;
  error: string | null;
  explainPlan: string | null;
  running: boolean;
}

export function formatCellDisplay(val: unknown): { content: React.ReactNode; typeClass: string; titleText?: string } {
  if (val === null || val === undefined) {
    return { content: 'NULL', typeClass: 'rgrid__cell--null' };
  }
  if (typeof val === 'number') {
    return { content: String(val), typeClass: 'rgrid__cell--num' };
  }
  if (typeof val === 'boolean') {
    return { content: String(val), typeClass: val ? 'rgrid__cell--bool-true' : 'rgrid__cell--bool-false' };
  }
  if (typeof val === 'object') {
    const str = JSON.stringify(val);
    return { content: str, typeClass: 'rgrid__cell--obj', titleText: str };
  }
  const str = String(val);
  return { content: str, typeClass: 'rgrid__cell--str', titleText: str };
}

export default function ResultsGrid({ result, error, explainPlan, running }: ResultsGridProps) {
  // Check Tauri environment first
  if (!isTauriEnvironment()) {
    return (
      <div className="rgrid__notice">
        Direct database TCP socket connection is unavailable in web browser preview mode. Please run the desktop application (<code>pnpm dev</code>).
      </div>
    );
  }

  if (running) {
    return (
      <div className="rgrid__notice rgrid__notice--muted">
        Executing query…
      </div>
    );
  }

  if (error) {
    const cleanedError = error.replace(/^Query execution failed:\s*/i, '');
    return <div className="rgrid__error">{cleanedError}</div>;
  }

  if (explainPlan) {
    return (
      <div className="rgrid__explain-container">
        <div className="rgrid__explain-header">EXPLAIN PLAN</div>
        <pre className="rgrid__explain">{explainPlan}</pre>
      </div>
    );
  }

  if (!result || !result.columns) {
    return <div className="rgrid__notice rgrid__notice--muted">Run a query to view results</div>;
  }

  if (result.rows.length === 0) {
    return <div className="rgrid__notice">Query returned no rows.</div>;
  }

  const maxDisplayRows = 1000;
  const displayedRows = result.rows.slice(0, maxDisplayRows);
  const isTruncated = result.rows.length > maxDisplayRows;

  return (
    <div className="rgrid">
      <div className="rgrid__scroll">
        <table className="rgrid__table">
          <thead>
            <tr>
              <th className="rgrid__gutter-hdr">#</th>
              {result.columns.map((col, i) => (
                <th key={i} className="rgrid__hdr">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedRows.map((row, rowIdx) => {
              const rowNum = rowIdx + 1;
              return (
                <tr key={rowIdx} className="rgrid__tr">
                  <td className="rgrid__gutter">{rowNum}</td>
                  {result.columns.map((_, colIdx) => {
                    const cellVal = row[colIdx];
                    const { content, typeClass, titleText } = formatCellDisplay(cellVal);
                    return (
                      <td key={colIdx} className={`rgrid__td ${typeClass}`} title={titleText}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isTruncated && (
        <div className="rgrid__footer-note">
          Showing first {maxDisplayRows.toLocaleString()} of {result.rowCount.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
