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
