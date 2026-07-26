import { describe, it, expect } from 'vitest';
import React from 'react';
import DatabaseTypeSelector from '../renderer/components/DatabaseTypeSelector';
import ConnectionForm from '../renderer/components/ConnectionForm';

describe('Database Type Selector & Connection Form UI components', () => {
  it('should export DatabaseTypeSelector component', () => {
    expect(DatabaseTypeSelector).toBeDefined();
    expect(typeof DatabaseTypeSelector).toBe('function');
  });

  it('should export ConnectionForm component', () => {
    expect(ConnectionForm).toBeDefined();
    expect(typeof ConnectionForm).toBe('function');
  });

  it('should create valid React elements for DatabaseTypeSelector', () => {
    const el = React.createElement(DatabaseTypeSelector, {
      selectedType: 'postgres',
      onSelectType: () => {},
    });
    expect(el).toBeDefined();
    expect(el.type).toBe(DatabaseTypeSelector);
    expect(el.props.selectedType).toBe('postgres');
  });

  it('should create valid React elements for ConnectionForm with initialType and onBack', () => {
    const el = React.createElement(ConnectionForm, {
      initialType: 'mysql',
      onBack: () => {},
      onSubmit: async () => {},
      onCancel: () => {},
    });
    expect(el).toBeDefined();
    expect(el.type).toBe(ConnectionForm);
    expect(el.props.initialType).toBe('mysql');
  });
});
