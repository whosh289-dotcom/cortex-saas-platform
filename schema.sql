DROP TABLE IF EXISTS stores;
CREATE TABLE stores (
    store_id TEXT PRIMARY KEY,
    stripe_key TEXT
);

DROP TABLE IF EXISTS products;
CREATE TABLE products (
    barcode TEXT,
    store_id TEXT,
    name TEXT,
    price REAL,
    PRIMARY KEY (barcode, store_id)
);

DROP TABLE IF EXISTS active_sessions;
CREATE TABLE active_sessions (
    device_id TEXT PRIMARY KEY,
    store_id TEXT
);

DROP TABLE IF EXISTS carts;
CREATE TABLE carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    barcode TEXT,
    name TEXT,
    price REAL,
    quantity INTEGER
);

DROP TABLE IF EXISTS order_history;
CREATE TABLE order_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    store_id TEXT,
    total REAL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS order_items;
CREATE TABLE order_items (
    order_id INTEGER,
    name TEXT,
    price REAL,
    quantity INTEGER,
    FOREIGN KEY(order_id) REFERENCES order_history(id)
);
