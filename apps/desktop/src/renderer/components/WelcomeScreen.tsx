import React, { useState } from 'react';

interface Props {
  onEnter: () => void;
}

export default function WelcomeScreen({ onEnter }: Props) {
  const [leaving, setLeaving] = useState(false);

  function handleEnter() {
    setLeaving(true);
    setTimeout(onEnter, 550);
  }

  return (
    <div className={`welcome${leaving ? ' leaving' : ''}`}>
      <div className="welcome__stripes" aria-hidden="true" />
      <div className="welcome__content">
        <div className="welcome__eyebrow">Zebraa — Database Explorer</div>
        <h1 className="welcome__headline">
          Your database,
          <br />
          <em>in plain sight.</em>
        </h1>
        <p className="welcome__sub">
          Connect to Postgres or MySQL, browse every table and column, and ask questions in plain English —
          no SQL required just to look around.
        </p>
        <button className="welcome__cta" onClick={handleEnter}>
          Open Zebraa <span>→</span>
        </button>
      </div>
    </div>
  );
}
