const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = path.join(DB_DIR, 'pricehawk.db');

let db;

async function initDb() {
  const SQL = await initSqlJs();
  try {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } catch {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      lang TEXT DEFAULT 'sv',
      display_currency TEXT DEFAULT 'SEK',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      price REAL NOT NULL,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      old_price REAL,
      new_price REAL,
      currency TEXT DEFAULT 'SEK',
      seen INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  save();
}

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
  return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
}

const queries = {
  findOrCreateUser(profile) {
    const existing = get('SELECT * FROM users WHERE google_id = ?', [profile.id]);
    if (existing) return existing;
    run('INSERT INTO users (google_id, email, name, avatar) VALUES (?, ?, ?, ?)',
      [profile.id, profile.emails[0].value, profile.displayName, profile.photos?.[0]?.value || '']);
    return get('SELECT * FROM users WHERE google_id = ?', [profile.id]);
  },

  getUser(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },

  updateLang(userId, lang) {
    run('UPDATE users SET lang = ? WHERE id = ?', [lang, userId]);
  },

  updateCurrency(userId, currency) {
    run('UPDATE users SET display_currency = ? WHERE id = ?', [currency, userId]);
  },

  addProduct(userId, data) {
    const result = run(
      'INSERT INTO products (user_id, url, title, image_url, current_price, currency) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, data.url, data.title, data.image_url, data.price, data.currency || 'SEK']
    );
    const product = get('SELECT * FROM products WHERE id = ?', [result.lastInsertRowid]);
    if (data.price) {
      run('INSERT INTO price_history (product_id, price) VALUES (?, ?)', [product.id, data.price]);
    }
    return product;
  },

  getUserProducts(userId) {
    return all('SELECT * FROM products WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  },

  getProduct(id, userId) {
    return get('SELECT * FROM products WHERE id = ? AND user_id = ?', [id, userId]);
  },

  deleteProduct(id, userId) {
    run('DELETE FROM products WHERE id = ? AND user_id = ?', [id, userId]);
  },

  updateProduct(id, userId, data) {
    if (data.notify !== undefined) {
      run('UPDATE products SET notify = ? WHERE id = ? AND user_id = ?', [data.notify ? 1 : 0, id, userId]);
    }
    if (data.target_price !== undefined) {
      run('UPDATE products SET target_price = ? WHERE id = ? AND user_id = ?', [data.target_price, id, userId]);
    }
  },

  updateScrapedData(productId, scraped) {
    const updates = [];
    const params = [];
    if (scraped.title) { updates.push('title = ?'); params.push(scraped.title); }
    if (scraped.image_url) { updates.push('image_url = ?'); params.push(scraped.image_url); }
    if (scraped.price) { updates.push('current_price = ?'); params.push(scraped.price); }
    if (scraped.currency) { updates.push('currency = ?'); params.push(scraped.currency); }
    if (updates.length > 0) {
      params.push(productId);
      run(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    if (scraped.price) {
      run('INSERT INTO price_history (product_id, price) VALUES (?, ?)', [productId, scraped.price]);
    }
  },

  updatePrice(productId, newPrice) {
    const product = get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) return null;
    run('UPDATE products SET previous_price = current_price, current_price = ? WHERE id = ?', [newPrice, productId]);
    run('INSERT INTO price_history (product_id, price) VALUES (?, ?)', [productId, newPrice]);
    return { ...product, previous_price: product.current_price, current_price: newPrice };
  },

  getPriceHistory(productId) {
    return all('SELECT price, checked_at FROM price_history WHERE product_id = ? ORDER BY checked_at ASC', [productId]);
  },

  getAllProductsForCron() {
    return all(`
      SELECT p.*, u.email, u.name AS user_name, u.lang
      FROM products p
      JOIN users u ON p.user_id = u.id
    `);
  },

  addNotification(userId, productId, title, oldPrice, newPrice, currency) {
    run('INSERT INTO notifications (user_id, product_id, title, old_price, new_price, currency) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, productId, title, oldPrice, newPrice, currency]);
  },

  getNotifications(userId) {
    return all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [userId]);
  },

  getUnseenCount(userId) {
    const row = get('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND seen = 0', [userId]);
    return row ? row.count : 0;
  },

  markNotificationsSeen(userId) {
    run('UPDATE notifications SET seen = 1 WHERE user_id = ? AND seen = 0', [userId]);
  },

  getStats(userId) {
    const row = get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN previous_price IS NOT NULL AND current_price < previous_price THEN previous_price - current_price ELSE 0 END) AS saved
      FROM products WHERE user_id = ?
    `, [userId]);
    return { total: row?.total || 0, saved: row?.saved || 0 };
  }
};

module.exports = { initDb, ...queries };
