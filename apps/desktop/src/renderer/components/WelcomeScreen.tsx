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
        <div className="welcome__eyebrow">Zebraa — Data Store Explorer</div>
        <h1 className="welcome__headline">
          Your data stores,
          <br />
          <em>in plain sight.</em>
        </h1>
        <p className="welcome__sub">
          Connect to Postgres, MySQL, Redis, MongoDB, SQLite & more — browse every table, collection, and key,
          and explore your data seamlessly.
        </p>
        <button className="welcome__cta" onClick={handleEnter}>
          Open Zebraa <span>→</span>
        </button>
      </div>
    </div>
  );
}
