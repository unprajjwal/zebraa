-- db/init-scripts/sql/02-ecommerce.sql
-- E-commerce store dummy schema

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sku VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  stock_quantity INTEGER DEFAULT 0,
  attributes JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'pending',
  total_amount NUMERIC(10, 2) NOT NULL,
  order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 2) NOT NULL
);

-- Sample Data
INSERT INTO customers (first_name, last_name, email, phone) VALUES
  ('Jane', 'Doe', 'jane.doe@example.com', '+15550199'),
  ('John', 'Smith', 'john.smith@example.com', '+15550198')
ON CONFLICT (email) DO NOTHING;

INSERT INTO categories (name, description) VALUES
  ('Electronics', 'Gadgets and electronic components'),
  ('Books', 'Physical and electronic books'),
  ('Apparel', 'Clothing and outerwear')
ON CONFLICT (name) DO NOTHING;

INSERT INTO products (category_id, sku, name, price, stock_quantity, attributes) VALUES
  (1, 'ELEC-001', 'Wireless Noise-Canceling Headphones', 199.99, 45, '{"color": "black", "bluetooth": "5.2"}'::jsonb),
  (1, 'ELEC-002', 'Mechanical Gaming Keyboard', 129.50, 20, '{"switches": "cherry-mx-red"}'::jsonb),
  (2, 'BOOK-001', 'Designing Data-Intensive Applications', 49.99, 100, '{"author": "Martin Kleppmann", "format": "paperback"}'::jsonb)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO orders (customer_id, status, total_amount) VALUES
  (1, 'completed', 249.98),
  (2, 'shipped', 129.50)
ON CONFLICT DO NOTHING;

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 199.99),
  (1, 3, 1, 49.99),
  (2, 2, 1, 129.50)
ON CONFLICT DO NOTHING;
