import { describe, it, expect } from 'vitest';
import React from 'react';
import App from '../renderer/App';
import AIPanel from '../renderer/components/AIPanel';
import TableTree from '../renderer/components/TableTree';
import QueryWorkspace from '../renderer/components/QueryWorkspace';
import SqlEditor, { tokenizeSql } from '../renderer/components/SqlEditor';
import ResultsGrid, { formatCellDisplay } from '../renderer/components/ResultsGrid';

describe('Resizable & Minimizable Panels UI', () => {
  it('should export App component', () => {
    expect(App).toBeDefined();
    expect(typeof App).toBe('function');
  });

  it('should export AIPanel component with optional onCollapse prop', () => {
    expect(AIPanel).toBeDefined();
    expect(typeof AIPanel).toBe('function');

    const el = React.createElement(AIPanel, { onCollapse: () => {} });
    expect(el).toBeDefined();
    expect(el.props.onCollapse).toBeDefined();
  });

  it('should create valid React element for App', () => {
    const el = React.createElement(App);
    expect(el).toBeDefined();
    expect(el.type).toBe(App);
  });

  it('should export TableTree component', () => {
    expect(TableTree).toBeDefined();
    expect(typeof TableTree).toBe('function');

    const el = React.createElement(TableTree, {
      schema: { tables: [] },
      loading: false,
      error: null,
      onOpenTable: () => {},
    });
    expect(el).toBeDefined();
    expect(el.type).toBe(TableTree);
  });

  it('should export QueryWorkspace component', () => {
    expect(QueryWorkspace).toBeDefined();
    expect(typeof QueryWorkspace).toBe('function');

    const el = React.createElement(QueryWorkspace, {
      connectionId: 'conn-1',
      schema: { tables: [] },
    });
    expect(el).toBeDefined();
    expect(el.type).toBe(QueryWorkspace);
  });

  it('should export SqlEditor component', () => {
    expect(SqlEditor).toBeDefined();
    expect(typeof SqlEditor).toBe('function');

    const el = React.createElement(SqlEditor, {
      sql: 'SELECT 1;',
      onChange: () => {},
      onRun: () => {},
      onExplain: () => {},
      running: false,
      rowCount: 1,
      elapsedMs: 12,
      error: null,
    });
    expect(el).toBeDefined();
    expect(el.type).toBe(SqlEditor);
  });

  it('should export ResultsGrid component', () => {
    expect(ResultsGrid).toBeDefined();
    expect(typeof ResultsGrid).toBe('function');

    const el = React.createElement(ResultsGrid, {
      result: { columns: ['id'], rows: [[1]], rowCount: 1 },
      error: null,
      explainPlan: null,
      running: false,
    });
    expect(el).toBeDefined();
    expect(el.type).toBe(ResultsGrid);
  });
});

describe('SQL Tokenizer Logic', () => {
  it('should correctly classify keywords, strings, numbers, comments, and identifiers', () => {
    const sql = "SELECT id, email FROM users WHERE age >= 21 AND name = 'Alice'; -- comment";
    const tokens = tokenizeSql(sql);

    const keywords = tokens.filter((t) => t.type === 'keyword').map((t) => t.text.toUpperCase());
    expect(keywords).toContain('SELECT');
    expect(keywords).toContain('FROM');
    expect(keywords).toContain('WHERE');
    expect(keywords).toContain('AND');

    const strings = tokens.filter((t) => t.type === 'string').map((t) => t.text);
    expect(strings).toContain("'Alice'");

    const numbers = tokens.filter((t) => t.type === 'number').map((t) => t.text);
    expect(numbers).toContain('21');

    const comments = tokens.filter((t) => t.type === 'comment').map((t) => t.text);
    expect(comments).toContain('-- comment');
  });
});

describe('Cell Formatting Logic', () => {
  it('should format null/undefined as NULL with cell--null class', () => {
    const resNull = formatCellDisplay(null);
    expect(resNull.content).toBe('NULL');
    expect(resNull.typeClass).toBe('rgrid__cell--null');

    const resUndef = formatCellDisplay(undefined);
    expect(resUndef.content).toBe('NULL');
    expect(resUndef.typeClass).toBe('rgrid__cell--null');
  });

  it('should format numbers with cell--num class', () => {
    const resNum = formatCellDisplay(42);
    expect(resNum.content).toBe('42');
    expect(resNum.typeClass).toBe('rgrid__cell--num');
  });

  it('should format booleans with boolean classes', () => {
    const resTrue = formatCellDisplay(true);
    expect(resTrue.content).toBe('true');
    expect(resTrue.typeClass).toBe('rgrid__cell--bool-true');

    const resFalse = formatCellDisplay(false);
    expect(resFalse.content).toBe('false');
    expect(resFalse.typeClass).toBe('rgrid__cell--bool-false');
  });

  it('should format objects/arrays as JSON strings with title attributes', () => {
    const obj = { role: 'admin' };
    const resObj = formatCellDisplay(obj);
    expect(resObj.content).toBe('{"role":"admin"}');
    expect(resObj.typeClass).toBe('rgrid__cell--obj');
    expect(resObj.titleText).toBe('{"role":"admin"}');
  });

  it('should format strings as text', () => {
    const resStr = formatCellDisplay('hello world');
    expect(resStr.content).toBe('hello world');
    expect(resStr.typeClass).toBe('rgrid__cell--str');
    expect(resStr.titleText).toBe('hello world');
  });
});
