import React, { useRef, useState, useEffect } from 'react';

import type { AdapterType } from '@zebraa/core';

export interface SqlToken {
  text: string;
  type: 'keyword' | 'string' | 'number' | 'comment' | 'text';
}

function getPlaceholderForAdapter(type?: AdapterType): string {
  switch (type) {
    case 'redis':
      return 'Enter Redis command (e.g. GET my_key or HGETALL user:100)';
    case 'mongodb':
      return 'Enter MongoDB query (e.g. db.users.find({ age: { $gte: 21 } }))';
    default:
      return 'Enter query or command (e.g. SELECT * FROM users;)';
  }
}

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'LEFT', 'RIGHT',
  'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'CREATE', 'DROP', 'ALTER',
  'TABLE', 'INTO', 'VALUES', 'SET', 'WITH', 'UNION', 'ALL', 'EXPLAIN', 'DISTINCT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'CROSS', 'FULL', 'TRUE', 'FALSE', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST'
]);

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const char = sql[i];

    // Single-line comment (-- ...)
    if (char === '-' && sql[i + 1] === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = len;
      tokens.push({ text: sql.slice(i, end), type: 'comment' });
      i = end;
      continue;
    }

    // Multi-line comment (/* ... */)
    if (char === '/' && sql[i + 1] === '*') {
      let end = sql.indexOf('*/', i + 2);
      if (end === -1) end = len;
      else end += 2;
      tokens.push({ text: sql.slice(i, end), type: 'comment' });
      i = end;
      continue;
    }

    // Single or Double Quoted Strings ('...' or "...")
    if (char === "'" || char === '"') {
      const quote = char;
      let j = i + 1;
      while (j < len) {
        if (sql[j] === '\\') {
          j += 2;
        } else if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            // Escaped quote
            j += 2;
          } else {
            j++;
            break;
          }
        } else {
          j++;
        }
      }
      tokens.push({ text: sql.slice(i, j), type: 'string' });
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(char) || (char === '.' && i + 1 < len && /[0-9]/.test(sql[i + 1]))) {
      let j = i;
      while (j < len && /[0-9._]/.test(sql[j])) {
        j++;
      }
      tokens.push({ text: sql.slice(i, j), type: 'number' });
      i = j;
      continue;
    }

    // Words / Identifiers / Keywords
    if (/[a-zA-Z_]/.test(char)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_]/.test(sql[j])) {
        j++;
      }
      const word = sql.slice(i, j);
      if (SQL_KEYWORDS.has(word.toUpperCase())) {
        tokens.push({ text: word, type: 'keyword' });
      } else {
        tokens.push({ text: word, type: 'text' });
      }
      i = j;
      continue;
    }

    // Other characters (whitespace, punctuation, operators)
    tokens.push({ text: char, type: 'text' });
    i++;
  }

  return tokens;
}

interface SqlEditorProps {
  sql: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  onExplain: () => void;
  running: boolean;
  rowCount: number | null;
  elapsedMs: number | null;
  error: string | null;
  adapterType?: AdapterType;
}

export default function SqlEditor({
  sql,
  onChange,
  onRun,
  onExplain,
  running,
  rowCount,
  elapsedMs,
  error,
  adapterType,
}: SqlEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [escPressed, setEscPressed] = useState(false);

  const tokens = tokenizeSql(sql);

  function handleScroll() {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
      preRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      setEscPressed(true);
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!running) {
        onRun();
      }
      return;
    }

    if (e.key === 'Tab') {
      if (escPressed) {
        setEscPressed(false);
        return; // Allow normal Tab focus navigation
      }
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const newSql = sql.substring(0, start) + '  ' + sql.substring(end);
      onChange(newSql);
      setTimeout(() => {
        if (target) {
          target.selectionStart = target.selectionEnd = start + 2;
        }
      }, 0);
      return;
    }

    if (escPressed) {
      setEscPressed(false);
    }
  }

  let statusText = 'Ready';
  if (running) {
    statusText = 'Running…';
  } else if (error) {
    statusText = 'Error';
  } else if (rowCount !== null && elapsedMs !== null) {
    statusText = `${rowCount} rows · ${elapsedMs}ms`;
  }

  return (
    <div className="sqled">
      <div className="sqled__editor-container">
        <pre ref={preRef} className="sqled__highlight" aria-hidden="true">
          {tokens.map((token, idx) => {
            if (token.type === 'keyword') {
              return (
                <span key={idx} className="sqled__tok--keyword">
                  {token.text}
                </span>
              );
            }
            if (token.type === 'string') {
              return (
                <span key={idx} className="sqled__tok--string">
                  {token.text}
                </span>
              );
            }
            if (token.type === 'number') {
              return (
                <span key={idx} className="sqled__tok--number">
                  {token.text}
                </span>
              );
            }
            if (token.type === 'comment') {
              return (
                <span key={idx} className="sqled__tok--comment">
                  {token.text}
                </span>
              );
            }
            return <span key={idx}>{token.text}</span>;
          })}
          {/* Ensure trailing newline is visible in pre */}
          {sql.endsWith('\n') ? '\n' : ''}
        </pre>
        <textarea
          ref={textareaRef}
          className="sqled__textarea"
          value={sql}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          placeholder={getPlaceholderForAdapter(adapterType)}
          spellCheck={false}
        />
      </div>

      <div className="sqled__toolbar">
        <div className="sqled__status">{statusText}</div>
        <div className="sqled__actions">
          <button
            type="button"
            className="sqled__btn sqled__btn--explain"
            onClick={onExplain}
            disabled={running || !sql.trim()}
            title="Explain execution plan"
          >
            Explain
          </button>
          <button
            type="button"
            className="sqled__btn sqled__btn--run"
            onClick={onRun}
            disabled={running || !sql.trim()}
            title="Run query (⌘⏎)"
          >
            {running ? 'Running…' : '⌘⏎ Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
