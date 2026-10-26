/* ============================================================================
   Mystery Bakebite — Catalogue sync for the static product list

   WHY THIS EXISTS
   products.html is hand-authored markup: 39 product rows with the name, a short
   note and a price written into the HTML. That is fine for layout, but it means
   a price edited in the admin dashboard never reached the shop page. The
   customer could read GH₵ 30.00 on the page and be charged whatever
   api_place_order reads from the database.

   This module closes that gap without touching the design: it looks up each row
   by `data-sku`, and rewrites only the price. Names, notes, images and every
   class on the page are left exactly as they are.

   Fails safe
   ----------
   If the catalogue cannot be loaded — offline, database missing, empty table —
   the page keeps the prices already in the HTML. Nothing is blanked and nothing
   is shown as free.

   A row whose SKU is missing from the published catalogue is marked
   "Unavailable" rather than silently showing a price the kitchen will not honour.
   ========================================================================== */
(function () {
  'use strict';

  function fmt(pesewas) {
    if (window.MB && typeof window.MB.formatMoney === 'function') {
      return window.MB.formatMoney(pesewas);
    }
    if (typeof pesewas !== 'number' || !isFinite(pesewas)) return 'On request';
    var val = pesewas / 100;
    var fixed = Math.abs(val).toFixed(2);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return 'GH\u20B5 ' + parts.join('.');
  }

  function apply(products) {
    var rows = document.querySelectorAll('.vrow[data-sku]');
    if (!rows.length) return;

    var bySku = {};
    for (var i = 0; i < products.length; i++) {
      if (products[i] && products[i].sku) bySku[products[i].sku] = products[i];
    }

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var sku = row.getAttribute('data-sku');
      var priceEl = row.querySelector('.vrow__price');
      if (!priceEl) continue;

      var p = bySku[sku];

      if (!p) {
        /* Not in the published catalogue: say so instead of quoting a price
           the kitchen will not accept. */
        row.classList.add('is-unavailable');
        priceEl.textContent = 'Unavailable';
        priceEl.setAttribute('title', 'This item is not currently available to order.');
        continue;
      }

      row.classList.remove('is-unavailable');
      priceEl.removeAttribute('title');

      if (p.price === null || p.price === undefined) {
        priceEl.textContent = 'On request';
      } else {
        /* The catalogue is authoritative for money. Show the discounted price
           when a discount is set, so the page agrees with the cart. */
        var pct = Number(p.discountPct || p.discount_pct || 0);
        if (pct > 0 && pct <= 90) {
          var net = Math.round(p.price * (100 - pct) / 100);
          priceEl.innerHTML = '<s class="vrow__was">' + fmt(p.price) + '</s> ' + fmt(net);
        } else {
          priceEl.textContent = fmt(p.price);
        }
      }
    }
  }

  function load() {
    if (!window.MB || typeof window.MB.api !== 'function') return;
    Promise.resolve(window.MB.api('/api/catalogue')).then(function (data) {
      if (!data || data.ok === false) return;          /* keep the static prices */
      var products = Array.isArray(data.products) ? data.products : [];
      if (!products.length) return;                     /* nothing published yet */
      apply(products);
    }).catch(function () { /* keep the static prices */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
