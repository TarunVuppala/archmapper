-- Database schema for the payments platform.

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  order_id TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  transaction_id TEXT,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  items JSONB NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger (
  id SERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  type VARCHAR(20) NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);
