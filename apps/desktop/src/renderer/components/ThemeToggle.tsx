import React, { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('zebraa-theme', theme);
  }, [theme]);

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button
        aria-label="Light mode"
        aria-pressed={theme === 'light'}
        className={theme === 'light' ? 'active' : ''}
        onClick={() => setTheme('light')}
      >
        ☀
      </button>
      <button
        aria-label="Dark mode"
        aria-pressed={theme === 'dark'}
        className={theme === 'dark' ? 'active' : ''}
        onClick={() => setTheme('dark')}
      >
        ☾
      </button>
    </div>
  );
}
