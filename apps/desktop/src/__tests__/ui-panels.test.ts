import { describe, it, expect } from 'vitest';
import React from 'react';
import App from '../renderer/App';
import AIPanel from '../renderer/components/AIPanel';

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
});
