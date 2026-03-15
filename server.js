require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cron = require('node-cron');
const path = require('path');

const db = require('./db');
const { scrapeProduct } = require('./scraper');
const { sendPriceAlert } = require('./mailer');
const { t } = require('./i18n');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

const googleConfigured = process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_ID !== 'your-google-client-id';

if (googleConfigured) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: (process.env.BASE_URL || 'http://localhost:3000') + '/auth/google/callback',
  }, (accessToken, refreshToken, profile, done) => {
    const user = db.findOrCreateUser(profile);
    done(null, user);
  }));
} else {
  console.log('[Auth] Google OAuth not configured — running in demo mode');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.getUser(id);
  done(null, user || false);
});

// Template locals
app.use((req, res, next) => {
  const lang = req.user?.lang || req.session?.lang || 'sv';
  res.locals.user = req.user || null;
  res.locals.lang = lang;
  res.locals.t = (key, vars) => t(lang, key, vars);
  next();
});

// Auth middleware
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// ========== ROUTES ==========

// Landing / Dashboard
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    const products = db.getUserProducts(req.user.id);
    const unseenNotifs = db.getUnseenCount(req.user.id);
    res.render('dashboard', { products, unseenNotifs });
  } else {
    res.render('landing');
  }
});

// Google Auth
app.get('/auth/google', (req, res, next) => {
  if (!googleConfigured) {
    // Demo mode: create a fake user
    const fakeProfile = {
      id: 'demo-user',
      displayName: 'Demo User',
      emails: [{ value: 'demo@prisbevakning.com' }],
      photos: [{ value: '' }]
    };
    const user = db.findOrCreateUser(fakeProfile);
    req.login(user, (err) => {
      if (err) return next(err);
      res.redirect('/');
    });
    return;
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  (req, res, next) => {
    if (!googleConfigured) return res.redirect('/');
    passport.authenticate('google', { failureRedirect: '/' })(req, res, next);
  },
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ========== API ==========

// Add product (async: save immediately, scrape in background)
app.post('/api/products', requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    // Save product immediately with domain as title
    let title = null;
    try { title = new URL(url).hostname.replace('www.', ''); } catch {}
    const product = db.addProduct(req.user.id, { url, title, price: null, image_url: null, currency: 'SEK' });
    // Return immediately so frontend can show the card
    res.json({ ...product, scraping: true });
    // Scrape in background and update DB when done
    scrapeProduct(url).then(scraped => {
      db.updateScrapedData(product.id, scraped);
      console.log(`[Scrape] Background done for ${product.id}: ${scraped.price} ${scraped.currency}`);
    }).catch(err => {
      console.log(`[Scrape] Background failed for ${product.id}: ${err.message}`);
    });
  } catch (err) {
    console.error('[Add error]', err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Poll product (frontend polls until price appears)
app.get('/api/products/:id', requireAuth, (req, res) => {
  const product = db.getProduct(parseInt(req.params.id), req.user.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json(product);
});

// Delete product
app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.deleteProduct(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// Update product (notify, target_price)
app.patch('/api/products/:id', requireAuth, (req, res) => {
  db.updateProduct(parseInt(req.params.id), req.user.id, req.body);
  res.json({ ok: true });
});

// Price history
app.get('/api/products/:id/history', requireAuth, (req, res) => {
  const product = db.getProduct(parseInt(req.params.id), req.user.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  const history = db.getPriceHistory(product.id);
  res.json(history);
});


// Notifications
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifications = db.getNotifications(req.user.id);
  const unseen = db.getUnseenCount(req.user.id);
  res.json({ notifications, unseen });
});

app.post('/api/notifications/seen', requireAuth, (req, res) => {
  db.markNotificationsSeen(req.user.id);
  res.json({ ok: true });
});

// ========== CRON: Check prices every 6 hours ==========
cron.schedule('0 */6 * * *', async () => {
  console.log('[Cron] Checking prices...');
  const products = db.getAllProductsForCron();
  for (const product of products) {
    try {
      const scraped = await scrapeProduct(product.url);
      if (!scraped.price) continue;
      if (scraped.price === product.current_price) continue;

      const updated = db.updatePrice(product.id, scraped.price);
      if (!product.notify) continue;

      const shouldNotify =
        scraped.price !== product.current_price ||
        (product.target_price && scraped.price <= product.target_price);

      if (shouldNotify && product.current_price) {
        // Save notification in app
        db.addNotification(product.user_id, product.id, product.title, product.current_price, scraped.price, product.currency);

        // Also try email if configured
        await sendPriceAlert({
          email: product.email,
          name: product.user_name,
          lang: product.lang,
          product: updated,
          oldPrice: product.current_price,
          newPrice: scraped.price,
        });
      }
    } catch (err) {
      console.error(`[Cron] Error checking ${product.url}:`, err.message);
    }
  }
  console.log('[Cron] Done.');
});

// Start
db.initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Prisbevakning.com running at http://localhost:${PORT}\n`);
    if (!googleConfigured) {
      console.log('  ⚠  Google OAuth not configured — click "Login" for demo mode\n');
    }
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
