const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'pricehawk.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrations
try { db.prepare("SELECT display_currency FROM users LIMIT 1").get(); }
catch { db.exec("ALTER TABLE users ADD COLUMN display_currency TEXT DEFAULT 'SEK'"); }
try { db.prepare("SELECT 1 FROM notifications LIMIT 1").get(); }
catch { db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
  title TEXT NOT NULL, old_price REAL, new_price REAL, currency TEXT DEFAULT 'SEK',
  seen INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
)`); }

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    lang TEXT DEFAULT 'sv',
    display_currency TEXT DEFAULT 'SEK',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    image_url TEXT,
    current_price REAL,
    previous_price REAL,
    currency TEXT DEFAULT 'SEK',
    notify INTEGER DEFAULT 1,
    target_price REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    old_price REAL,
    new_price REAL,
    currency TEXT DEFAULT 'SEK',
    seen INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    price REAL NOT NULL,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );
`);

const queries = {
  // Users
  findOrCreateUser(profile) {
    const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
    if (existing) return existing;
    const stmt = db.prepare('INSERT INTO users (google_id, email, name, avatar) VALUES (?, ?, ?, ?)');
    const result = stmt.run(profile.id, profile.emails[0].value, profile.displayName, profile.photos?.[0]?.value);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  },

  getUser(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  updateLang(userId, lang) {
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, userId);
  },

  updateCurrency(userId, currency) {
    db.prepare('UPDATE users SET display_currency = ? WHERE id = ?').run(currency, userId);
  },

  // Products
  addProduct(userId, data) {
    const stmt = db.prepare(`
      INSERT INTO products (user_id, url, title, image_url, current_price, currency)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(userId, data.url, data.title, data.image_url, data.price, data.currency || 'SEK');
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    if (data.price) {
      db.prepare('INSERT INTO price_history (product_id, price) VALUES (?, ?)').run(product.id, data.price);
    }
    return product;
  },

  getUserProducts(userId) {
    return db.prepare('SELECT * FROM products WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },

  getProduct(id, userId) {
    return db.prepare('SELECT * FROM products WHERE id = ? AND user_id = ?').get(id, userId);
  },

  deleteProduct(id, userId) {
    return db.prepare('DELETE FROM products WHERE id = ? AND user_id = ?').run(id, userId);
  },

  updateProduct(id, userId, data) {
    const sets = [];
    const vals = [];
    if (data.notify !== undefined) { sets.push('notify = ?'); vals.push(data.notify ? 1 : 0); }
    if (data.target_price !== undefined) { sets.push('target_price = ?'); vals.push(data.target_price); }
    if (sets.length === 0) return;
    vals.push(id, userId);
    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  },

  updatePrice(productId, newPrice) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return null;
    db.prepare('UPDATE products SET previous_price = current_price, current_price = ? WHERE id = ?').run(newPrice, productId);
    db.prepare('INSERT INTO price_history (product_id, price) VALUES (?, ?)').run(productId, newPrice);
    return { ...product, previous_price: product.current_price, current_price: newPrice };
  },

  getPriceHistory(productId) {
    return db.prepare('SELECT price, checked_at FROM price_history WHERE product_id = ? ORDER BY checked_at ASC').all(productId);
  },

  getAllProductsForCron() {
    return db.prepare(`
      SELECT p.*, u.email, u.name AS user_name, u.lang
      FROM products p
      JOIN users u ON p.user_id = u.id
    `).all();
  },

  // Notifications
  addNotification(userId, productId, title, oldPrice, newPrice, currency) {
    db.prepare(`INSERT INTO notifications (user_id, product_id, title, old_price, new_price, currency) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, productId, title, oldPrice, newPrice, currency);
  },

  getNotifications(userId) {
    return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId);
  },

  getUnseenCount(userId) {
    return db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND seen = 0').get(userId).count;
  },

  markNotificationsSeen(userId) {
    db.prepare('UPDATE notifications SET seen = 1 WHERE user_id = ? AND seen = 0').run(userId);
  },

  getStats(userId) {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN previous_price IS NOT NULL AND current_price < previous_price THEN previous_price - current_price ELSE 0 END) AS saved
      FROM products WHERE user_id = ?
    `).get(userId);
    return { total: row.total, saved: row.saved || 0 };
  }
};

module.exports = { db, ...queries };
