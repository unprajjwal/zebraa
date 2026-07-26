-- db/init-scripts/sql/03-analytics.sql
-- Analytics dummy schema

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  event_name VARCHAR(100) NOT NULL,
  user_id INTEGER,
  session_id VARCHAR(100) NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id SERIAL PRIMARY KEY,
  metric_date DATE NOT NULL UNIQUE,
  active_users INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  bounce_rate NUMERIC(5, 2) DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS page_views (
  id SERIAL PRIMARY KEY,
  path VARCHAR(500) NOT NULL,
  referrer VARCHAR(500),
  duration_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sample Data
INSERT INTO events (event_name, user_id, session_id, payload) VALUES
  ('page_view', 101, 'sess_abc123', '{"path": "/dashboard"}'::jsonb),
  ('click_button', 101, 'sess_abc123', '{"button_id": "connect_db"}'::jsonb),
  ('export_query', 102, 'sess_xyz789', '{"format": "csv", "row_count": 500}'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO daily_metrics (metric_date, active_users, page_views, bounce_rate) VALUES
  (CURRENT_DATE - INTERVAL '2 days', 450, 1200, 32.50),
  (CURRENT_DATE - INTERVAL '1 day', 520, 1450, 28.10),
  (CURRENT_DATE, 310, 890, 30.00)
ON CONFLICT (metric_date) DO NOTHING;

INSERT INTO page_views (path, referrer, duration_seconds) VALUES
  ('/home', 'google.com', 45),
  ('/docs/postgres', '/home', 120),
  ('/pricing', 'twitter.com', 15)
ON CONFLICT DO NOTHING;
