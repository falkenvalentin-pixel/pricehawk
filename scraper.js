const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function parsePrice(str) {
  if (!str && str !== 0) return null;
  const cleaned = String(str)
    .replace(/\s/g, '')
    .replace(/[^\d.,\-]/g, '')
    .replace(/,(\d{2})$/, '.$1')
    .replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) || num <= 0 ? null : num;
}

function detectCurrency(text) {
  if (!text) return 'SEK';
  const t = text.toUpperCase();
  if (t.includes('SEK') || t.includes('KR')) return 'SEK';
  if (t.includes('EUR') || t.includes('€')) return 'EUR';
  if (t.includes('USD') || t.includes('$')) return 'USD';
  if (t.includes('GBP') || t.includes('£')) return 'GBP';
  if (t.includes('NOK')) return 'NOK';
  if (t.includes('DKK')) return 'DKK';
  return 'SEK';
}

function extractFromHtml($, url) {
  const result = { title: null, price: null, image_url: null, currency: 'SEK' };

  // --- Title ---
  result.title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="title"]').attr('content') ||
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    null;

  // --- Image ---
  result.image_url =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    null;

  if (result.image_url && !result.image_url.startsWith('http')) {
    try {
      const urlObj = new URL(url);
      result.image_url = result.image_url.startsWith('//')
        ? urlObj.protocol + result.image_url
        : urlObj.origin + result.image_url;
    } catch {}
  }

  // --- Price: JSON-LD ---
  $('script[type="application/ld+json"]').each((_, el) => {
    if (result.price) return;
    try {
      let data = JSON.parse($(el).html());
      if (data['@graph']) data = data['@graph'];
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item.offers || (item['@type'] === 'Offer' ? item : null);
        if (!offers) continue;
        const offerList = Array.isArray(offers) ? offers : [offers];
        for (const o of offerList) {
          const p = o.price || o.lowPrice;
          if (p) {
            result.price = parsePrice(p);
            if (o.priceCurrency) result.currency = o.priceCurrency;
            if (result.price) return;
          }
        }
      }
    } catch {}
  });

  // --- Price: Meta tags ---
  if (!result.price) {
    const metaPrice =
      $('meta[property="product:price:amount"]').attr('content') ||
      $('meta[property="og:price:amount"]').attr('content') ||
      $('meta[name="price"]').attr('content') ||
      $('meta[name="twitter:data1"]').attr('content');
    result.price = parsePrice(metaPrice);
    const metaCurrency =
      $('meta[property="product:price:currency"]').attr('content') ||
      $('meta[property="og:price:currency"]').attr('content');
    if (metaCurrency) result.currency = metaCurrency;
  }

  // --- Price: Microdata ---
  if (!result.price) {
    const itemprop = $('[itemprop="price"]').first();
    if (itemprop.length) {
      result.price = parsePrice(itemprop.attr('content') || itemprop.text());
    }
  }

  // --- Price: Common CSS selectors ---
  if (!result.price) {
    const priceSelectors = [
      '[data-price]',
      '[data-product-price]',
      '[data-current-price]',
      '.product-price-value',
      '.product-price',
      '.price .current',
      '.price-current',
      '.product__price',
      '.price--sale',
      '.price--current',
      '.sale-price',
      '.current-price',
      '.now-price',
      '#price',
      '.price',
      '.pris',
      '[class*="price" i]',
      '[class*="pris" i]',
      '[id*="price" i]',
    ];
    for (const sel of priceSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const priceText = el.attr('data-price') || el.attr('data-product-price') || el.attr('data-current-price') || el.attr('content') || el.text();
        const parsed = parsePrice(priceText);
        if (parsed && parsed > 0) {
          result.price = parsed;
          result.currency = detectCurrency(el.text() + ' ' + (el.attr('data-currency') || ''));
          break;
        }
      }
    }
  }

  // --- Price: Embedded JSON in scripts (React/Next.js stores etc) ---
  if (!result.price) {
    $('script').each((_, el) => {
      if (result.price) return;
      const text = $(el).html() || '';
      if (text.length < 50 || text.length > 500000) return;
      const jsonPatterns = [
        /"price"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"currentPrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"salePrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"discountedPrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"finalPrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"sellingPrice"\s*:\s*(\d+(?:\.\d+)?)/g,
        /"amount"\s*:\s*(\d+(?:\.\d+)?)/g,
      ];
      for (const pat of jsonPatterns) {
        const m = pat.exec(text);
        if (m) {
          const p = parseFloat(m[1]);
          if (p > 0 && p < 1000000) {
            result.price = p;
            return;
          }
        }
      }
    });
  }

  // --- Price: Regex fallback on full HTML ---
  if (!result.price) {
    const html = $.html();
    const patterns = [
      /(\d[\d\s]*(?:[,.]\d{2})?)\s*(?:kr|SEK|:-)/i,
      /(?:pris|price)[^<\d]{0,30}?(\d[\d\s]*(?:[,.]\d{2})?)/i,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        const parsed = parsePrice(m[1]);
        if (parsed && parsed > 0 && parsed < 1000000) {
          result.price = parsed;
          break;
        }
      }
    }
  }

  if (result.title && result.title.length > 200) {
    result.title = result.title.substring(0, 197) + '...';
  }

  return result;
}

async function scrapeProduct(url) {
  console.log(`[Scraper] Scraping: ${url}`);

  // Try with normal headers first
  const headers = [
    {
      'User-Agent': USER_AGENTS[0],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
    },
    {
      // Some sites need a more complete browser-like header set
      'User-Agent': USER_AGENTS[1],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  ];

  let lastResult = null;

  for (const h of headers) {
    try {
      const res = await axios.get(url, {
        headers: h,
        timeout: 15000,
        maxRedirects: 5,
      });
      const $ = cheerio.load(res.data);
      const result = extractFromHtml($, url);

      if (result.price) {
        console.log(`[Scraper] Found price: ${result.price} ${result.currency}`);
        return result;
      }
      lastResult = result;
    } catch (err) {
      console.log(`[Scraper] Attempt failed: ${err.message}`);
    }
  }

  // Return whatever we got (at least title/image maybe)
  if (lastResult) {
    console.log(`[Scraper] No price found, returning partial result`);
    return lastResult;
  }

  throw new Error('Could not fetch page');
}

module.exports = { scrapeProduct, parsePrice };
