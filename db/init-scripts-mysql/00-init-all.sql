-- db/init-scripts-mysql/00-init-all.sql
-- MySQL initialization script for Zebraa dev & testing

CREATE DATABASE IF NOT EXISTS zebraa;
CREATE DATABASE IF NOT EXISTS dummy_ecommerce;
CREATE DATABASE IF NOT EXISTS dummy_analytics;

USE zebraa;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  is_active BOOLEAN DEFAULT true,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  content TEXT,
  view_count INT DEFAULT 0,
  published_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  post_id INT NOT NULL,
  user_id INT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  slug VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INT NOT NULL,
  tag_id INT NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

INSERT IGNORE INTO users (id, email, name, role, metadata) VALUES
  (1, 'alice@zebraa.io', 'Alice Smith', 'admin', '{"department": "Engineering"}'),
  (2, 'bob@zebraa.io', 'Bob Jones', 'editor', '{"department": "Marketing"}'),
  (3, 'charlie@zebraa.io', 'Charlie Brown', 'user', '{"department": "Support"}');

INSERT IGNORE INTO posts (id, user_id, title, slug, content, view_count, published_at) VALUES
  (1, 1, 'Welcome to Zebraa Explorer', 'welcome-to-zebraa', 'Zebraa is a modern database explorer app.', 150, CURRENT_TIMESTAMP),
  (2, 1, 'MySQL Performance Tips', 'mysql-performance-tips', 'Learn how to optimize your queries.', 320, CURRENT_TIMESTAMP),
  (3, 2, 'Building with Electron and Vite', 'building-electron-vite', 'A guide to modern desktop development.', 85, CURRENT_TIMESTAMP);

INSERT IGNORE INTO comments (id, post_id, user_id, content) VALUES
  (1, 1, 2, 'Great post! Looking forward to using Zebraa.'),
  (2, 1, 3, 'Does it support MySQL as well?'),
  (3, 2, 1, 'Indexes are essential for large tables.');

INSERT IGNORE INTO tags (id, name, slug) VALUES
  (1, 'Database', 'database'),
  (2, 'MySQL', 'mysql'),
  (3, 'Electron', 'electron');

INSERT IGNORE INTO post_tags (post_id, tag_id) VALUES
  (1, 1), (1, 2),
  (2, 2),
  (3, 3);

-- Switch to dummy_ecommerce
USE dummy_ecommerce;

CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_id INT,
  sku VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  stock_quantity INT DEFAULT 0,
  attributes JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  total_amount DECIMAL(10, 2) NOT NULL,
  order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price DECIMAL(10, 2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

INSERT IGNORE INTO customers (id, first_name, last_name, email, phone) VALUES
  (1, 'Jane', 'Doe', 'jane.doe@example.com', '+15550199'),
  (2, 'John', 'Smith', 'john.smith@example.com', '+15550198');

INSERT IGNORE INTO categories (id, name, description) VALUES
  (1, 'Electronics', 'Gadgets and electronic components'),
  (2, 'Books', 'Physical and electronic books'),
  (3, 'Apparel', 'Clothing and outerwear');

INSERT IGNORE INTO products (id, category_id, sku, name, price, stock_quantity, attributes) VALUES
  (1, 1, 'ELEC-001', 'Wireless Noise-Canceling Headphones', 199.99, 45, '{"color": "black", "bluetooth": "5.2"}'),
  (2, 1, 'ELEC-002', 'Mechanical Gaming Keyboard', 129.50, 20, '{"switches": "cherry-mx-red"}'),
  (3, 2, 'BOOK-001', 'Designing Data-Intensive Applications', 49.99, 100, '{"author": "Martin Kleppmann", "format": "paperback"}');

INSERT IGNORE INTO orders (id, customer_id, status, total_amount) VALUES
  (1, 1, 'completed', 249.98),
  (2, 2, 'shipped', 129.50);

INSERT IGNORE INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 1, 199.99),
  (2, 1, 3, 1, 49.99),
  (3, 2, 2, 1, 129.50);

-- Switch to dummy_analytics
USE dummy_analytics;

CREATE TABLE IF NOT EXISTS events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_name VARCHAR(100) NOT NULL,
  user_id INT,
  session_id VARCHAR(100) NOT NULL,
  payload JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  metric_date DATE NOT NULL UNIQUE,
  active_users INT DEFAULT 0,
  page_views INT DEFAULT 0,
  bounce_rate DECIMAL(5, 2) DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS page_views (
  id INT AUTO_INCREMENT PRIMARY KEY,
  path VARCHAR(500) NOT NULL,
  referrer VARCHAR(500),
  duration_seconds INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO events (id, event_name, user_id, session_id, payload) VALUES
  (1, 'page_view', 101, 'sess_abc123', '{"path": "/dashboard"}'),
  (2, 'click_button', 101, 'sess_abc123', '{"button_id": "connect_db"}'),
  (3, 'export_query', 102, 'sess_xyz789', '{"format": "csv", "row_count": 500}');

INSERT IGNORE INTO daily_metrics (id, metric_date, active_users, page_views, bounce_rate) VALUES
  (1, DATE_SUB(CURDATE(), INTERVAL 2 DAY), 450, 1200, 32.50),
  (2, DATE_SUB(CURDATE(), INTERVAL 1 DAY), 520, 1450, 28.10),
  (3, CURDATE(), 310, 890, 30.00);

INSERT IGNORE INTO page_views (id, path, referrer, duration_seconds) VALUES
  (1, '/home', 'google.com', 45),
  (2, '/docs/mysql', '/home', 120),
  (3, '/pricing', 'twitter.com', 15);
