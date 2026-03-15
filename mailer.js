const nodemailer = require('nodemailer');
const { t } = require('./i18n');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD ||
      process.env.GMAIL_USER === 'your-email@gmail.com') {
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

async function sendPriceAlert({ email, name, lang, product, oldPrice, newPrice }) {
  const tr = getTransporter();
  if (!tr) {
    console.log(`[Mailer] Skipping email (not configured): ${product.title} ${oldPrice} → ${newPrice}`);
    return;
  }

  const isDown = newPrice < oldPrice;
  const isTarget = product.target_price && newPrice <= product.target_price;

  let subjectKey = isTarget ? 'emailSubjectTarget' : (isDown ? 'emailSubjectDown' : 'emailSubjectUp');
  const subject = t(lang || 'sv', subjectKey, { title: product.title });
  const body = t(lang || 'sv', 'emailBody', {
    name: name,
    title: product.title,
    old: oldPrice.toFixed(2),
    new: newPrice.toFixed(2),
    currency: product.currency,
    url: product.url,
  });

  const emoji = isDown ? '📉' : '📈';

  await tr.sendMail({
    from: `"PriceHawk" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `${emoji} ${subject}`,
    text: body,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: ${isDown ? '#10b981' : '#ef4444'};">${emoji} ${subject}</h2>
        ${product.image_url ? `<img src="${product.image_url}" style="max-width: 200px; border-radius: 8px; margin: 10px 0;" />` : ''}
        <p style="font-size: 16px;">
          <span style="text-decoration: line-through; color: #888;">${oldPrice.toFixed(2)} ${product.currency}</span>
          &nbsp;→&nbsp;
          <strong style="color: ${isDown ? '#10b981' : '#ef4444'};">${newPrice.toFixed(2)} ${product.currency}</strong>
        </p>
        <a href="${product.url}" style="display: inline-block; margin-top: 15px; padding: 10px 25px; background: #6366f1; color: white; text-decoration: none; border-radius: 8px;">
          ${lang === 'en' ? 'View product' : 'Se produkten'}
        </a>
        <p style="margin-top: 30px; font-size: 12px; color: #888;">/ PriceHawk</p>
      </div>
    `,
  });
  console.log(`[Mailer] Sent alert to ${email}: ${product.title} ${oldPrice} → ${newPrice}`);
}

module.exports = { sendPriceAlert };
