// Prisbevakning.com Frontend

// ========== i18n ==========
const LANG = document.documentElement.lang || 'sv';
const L = {
  sv: {
    track: 'Bevaka',
    confirmDelete: 'Ta bort bevakningen?',
    price: 'Pris',
    loading: 'Hämtar pris...',
    blocked: 'Vissa produkter från den här hemsidan går tyvärr inte att bevaka.',
    timeout: 'Sidan svarade inte i tid. Försök igen om en stund.',
    network: 'Kunde inte nå sidan. Kontrollera att länken stämmer.',
    unknown: 'Kunde inte hämta priset. Kontrollera länken.',
  },
  en: {
    track: 'Track',
    confirmDelete: 'Remove this tracking?',
    price: 'Price',
    loading: 'Fetching price...',
    blocked: "Some products from this website unfortunately can't be tracked.",
    timeout: "The page didn't respond in time. Try again later.",
    network: 'Could not reach the page. Make sure the link is correct.',
    unknown: 'Could not fetch the price. Check the link.',
  }
}[LANG] || L.sv;


// ========== Add Product ==========
const addForm = document.getElementById('addForm');
if (addForm) {
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const urlInput = document.getElementById('urlInput');
    const errorEl = document.getElementById('addError');
    const loadingEl = document.getElementById('addLoading');
    const btn = document.getElementById('addBtn');

    errorEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ' + (LANG === 'sv' ? 'Hämtar...' : 'Fetching...');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.value }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      const data = await res.json();

      if (!res.ok) {
        throw new Error(L[data.reason] || L.unknown);
      }

      // Remove "no products" placeholder
      const placeholder = document.querySelector('#productsGrid .col-span-full');
      if (placeholder) placeholder.remove();

      // Add product card dynamically
      const grid = document.getElementById('productsGrid');
      const card = document.createElement('div');
      let domain = '';
      try { domain = new URL(data.url).hostname.replace('www.', ''); } catch {}
      const priceText = data.current_price ? Math.round(data.current_price) : '?';
      const currency = data.currency || 'SEK';

      card.className = 'product-card bg-white dark:bg-gray-800 rounded-2xl shadow-md overflow-hidden hover:shadow-lg transition';
      card.setAttribute('data-id', data.id);
      card.style.animation = 'fadeIn 0.3s ease';
      card.innerHTML = (data.image_url ? '<div class="h-40 bg-gray-100 dark:bg-gray-700 overflow-hidden"><img src="' + data.image_url + '" class="w-full h-full object-contain" alt="" onerror="this.parentElement.style.display=\'none\'" referrerpolicy="no-referrer"></div>' : '') +
        '<div class="p-4">' +
          '<div class="text-xs text-gray-400 mb-1">' + domain + '</div>' +
          '<h3 class="font-semibold text-sm mb-2 line-clamp-2">' + (data.title || data.url) + '</h3>' +
          '<div class="flex items-baseline gap-2 mb-3">' +
            '<span class="text-2xl font-bold">' + priceText + '</span>' +
            '<span class="text-sm text-gray-400">' + currency + '</span>' +
          '</div>' +
          '<div class="flex gap-2 items-center text-xs">' +
            '<button onclick="showHistory(' + data.id + ', \'' + (data.title || '').replace(/'/g, "\\'") + '\')" class="text-indigo-500 hover:text-indigo-700 font-medium">\u{1F4CA} ' + L.price + '</button>' +
            '<div class="flex-1"></div>' +
            '<label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked onchange="toggleNotify(' + data.id + ', this.checked)" class="rounded"><span>\u{1F514}</span></label>' +
            '<button onclick="deleteProduct(' + data.id + ')" class="text-red-400 hover:text-red-600">\u{1F5D1}</button>' +
          '</div>' +
        '</div>';
      grid.prepend(card);
      urlInput.value = '';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      loadingEl.classList.add('hidden');
      btn.disabled = false;
      btn.innerHTML = '<span>+</span> ' + L.track;
    }
  });
}

// ========== Delete Product ==========
async function deleteProduct(id) {
  if (!confirm(L.confirmDelete)) return;
  await fetch(`/api/products/${id}`, { method: 'DELETE' });
  const card = document.querySelector(`[data-id="${id}"]`);
  if (card) {
    card.style.transform = 'scale(0.9)';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 200);
  }
}

// ========== Toggle Notify ==========
async function toggleNotify(id, checked) {
  await fetch(`/api/products/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notify: checked })
  });
}

// ========== Price History Modal ==========
let historyChart = null;

async function showHistory(id, title) {
  const modal = document.getElementById('historyModal');
  const modalTitle = document.getElementById('modalTitle');
  modalTitle.textContent = title;
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  const res = await fetch(`/api/products/${id}/history`);
  const data = await res.json();

  if (historyChart) historyChart.destroy();

  const ctx = document.getElementById('historyChart').getContext('2d');
  const isDark = document.documentElement.classList.contains('dark');

  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => {
        const date = new Date(d.checked_at);
        return date.toLocaleDateString(LANG === 'sv' ? 'sv-SE' : 'en-US', {
          month: 'short', day: 'numeric'
        });
      }),
      datasets: [{
        label: L.price,
        data: data.map(d => d.price),
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#6366f1',
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? '#374151' : '#fff',
          titleColor: isDark ? '#f3f4f6' : '#111827',
          bodyColor: isDark ? '#d1d5db' : '#4b5563',
          borderColor: isDark ? '#4b5563' : '#e5e7eb',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
        }
      },
      scales: {
        y: {
          grid: { color: isDark ? '#374151' : '#f3f4f6' },
          ticks: { color: isDark ? '#9ca3af' : '#6b7280' }
        },
        x: {
          grid: { display: false },
          ticks: { color: isDark ? '#9ca3af' : '#6b7280' }
        }
      }
    }
  });
}

function closeModal() {
  const modal = document.getElementById('historyModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); closeNotifPanel(); }
});

// ========== Notifications ==========
async function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const isHidden = panel.classList.contains('hidden');
  if (isHidden) {
    panel.classList.remove('hidden');
    const res = await fetch('/api/notifications');
    const data = await res.json();
    const list = document.getElementById('notifList');
    if (data.notifications.length === 0) {
      list.innerHTML = `<div class="text-center text-gray-400 py-6 text-sm">${LANG === 'sv' ? 'Inga notifikationer ännu' : 'No notifications yet'}</div>`;
    } else {
      list.innerHTML = data.notifications.map(n => {
        const isDown = n.new_price < n.old_price;
        const arrow = isDown ? '\u2193' : '\u2191';
        const color = isDown ? 'text-green-500' : 'text-red-500';
        const bg = n.seen ? '' : 'bg-indigo-50 dark:bg-indigo-900 dark:bg-opacity-30';
        const date = new Date(n.created_at).toLocaleDateString(LANG === 'sv' ? 'sv-SE' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `<div class="p-3 rounded-xl mb-1 ${bg}">
          <div class="text-sm font-medium line-clamp-1">${n.title || ''}</div>
          <div class="text-sm ${color} font-bold">${arrow} ${n.old_price} \u2192 ${n.new_price} ${n.currency}</div>
          <div class="text-xs text-gray-400">${date}</div>
        </div>`;
      }).join('');
    }
    // Mark as seen
    if (data.unseen > 0) {
      await fetch('/api/notifications/seen', { method: 'POST' });
      const badge = document.querySelector('.notif-badge');
      if (badge) badge.remove();
    }
  } else {
    panel.classList.add('hidden');
  }
}

function closeNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (panel) panel.classList.add('hidden');
}

// Close notif panel when clicking outside
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  if (panel && !panel.classList.contains('hidden') && !e.target.closest('#notifPanel') && !e.target.closest('[onclick*="toggleNotifPanel"]')) {
    panel.classList.add('hidden');
  }
});
