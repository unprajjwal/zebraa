-- db/init-scripts/sql/01-zebraa.sql
-- Core schema for zebraa database

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  content TEXT,
  view_count INTEGER DEFAULT 0,
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Sample Data
INSERT INTO users (email, name, role, metadata) VALUES
  ('alice@zebraa.io', 'Alice Smith', 'admin', '{"department": "Engineering"}'::jsonb),
  ('bob@zebraa.io', 'Bob Jones', 'editor', '{"department": "Marketing"}'::jsonb),
  ('charlie@zebraa.io', 'Charlie Brown', 'user', '{"department": "Support"}'::jsonb)
ON CONFLICT (email) DO NOTHING;

INSERT INTO posts (user_id, title, slug, content, view_count, published_at) VALUES
  (1, 'Welcome to Zebraa Explorer', 'welcome-to-zebraa', 'Zebraa is a modern database explorer app.', 150, CURRENT_TIMESTAMP),
  (1, 'Postgres Performance Tips', 'postgres-performance-tips', 'Learn how to optimize your queries.', 320, CURRENT_TIMESTAMP),
  (2, 'Building with Electron and Vite', 'building-electron-vite', 'A guide to modern desktop development.', 85, CURRENT_TIMESTAMP)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO comments (post_id, user_id, content) VALUES
  (1, 2, 'Great post! Looking forward to using Zebraa.'),
  (1, 3, 'Does it support MySQL as well?'),
  (2, 1, 'Indexes are essential for large tables.')
ON CONFLICT DO NOTHING;

INSERT INTO tags (name, slug) VALUES
  ('Database', 'database'),
  ('PostgreSQL', 'postgresql'),
  ('Electron', 'electron')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO post_tags (post_id, tag_id) VALUES
  (1, 1), (1, 2),
  (2, 2),
  (3, 3)
ON CONFLICT DO NOTHING;
