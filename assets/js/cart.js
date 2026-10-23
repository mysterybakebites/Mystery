/* ============================================================
   Mystery Bakebite: two separate carts + slide-out cart pop-up
   ------------------------------------------------------------
   Product orders and class bookings are different transactions,
   so they have different carts, different storage keys, different
   checkouts and different references. Nothing can move from one
   into the other.

     products  bakery items and custom cakes   -> checkout.html   (MB-)
     classes   baking classes                  -> booking.html    (MC-)

   The page declares which cart it shows by default with
   <div id="cart-drawer" data-scope="product|class">.
   The slide-out cart pop-up also lets the customer switch tabs
   between their Product Cart and Class Booking from any page.
   ============================================================ */
(function () {
  'use strict';

  var STORES = {
    product: 'mb-cart-products-v3',
    class: 'mb-cart-classes-v3'
  };
  var LEGACY = 'mb-cart-v2';

  var KIND_TO_TYPE = { product: 'product', custom: 'product', class: 'class' };

  function typeOf(kind) {
    return KIND_TO_TYPE[kind] || null;
  }

  function defaultImageFor(item) {
    if (item && item.image) {
      var idCheck = String(item.id || item.sku || '').toLowerCase();
      if (idCheck.indexOf('milky-') === 0 && item.image === 'assets/img/prod-doughnuts.webp') {
        return 'assets/img/milky-doughnuts-new.webp';
      }
      if ((idCheck.indexOf('choc-cookies-') === 0 || idCheck === 'mixed-cookie-box') && item.image === 'assets/img/prod-cookies.webp') {
        return 'assets/img/mystery-cookie-box.webp';
      }
      return item.image;
    }
    if (!item) return 'assets/img/milky-doughnuts-new.webp';
    if (item.kind === 'class') {
      var slug = String(item.slug || item.id || '');
      return slug.indexOf('pastry') !== -1
        ? 'assets/img/school-pastry.webp'
        : 'assets/img/school-bread.webp';
    }
    if (item.kind === 'custom') return 'assets/img/birthday-cakes.webp';
    var id = String(item.id || item.sku || '').toLowerCase();
    if (id.indexOf('chips') !== -1) return 'assets/img/prod-savoury.webp';
    if (id.indexOf('slice') !== -1 || id.indexOf('tasting-box') !== -1 || id.indexOf('flavour-box') !== -1) return 'assets/img/prod-slices.webp';
    if (id.indexOf('loaf') !== -1 || id.indexOf('banana') !== -1 || id.indexOf('vanilla') !== -1) return 'assets/img/prod-loaves.webp';
    if (id.indexOf('choc-cookie') !== -1 || id === 'mixed-cookie-box') return 'assets/img/mystery-cookie-box.webp';
    if (id.indexOf('cookie') !== -1) return 'assets/img/prod-cookies.webp';
    if (id.indexOf('cupcake') !== -1) return 'assets/img/prod-cupcakes.webp';
    if (id.indexOf('parfait') !== -1) return 'assets/img/prod-parfait.webp';
    return 'assets/img/milky-doughnuts-new.webp';
  }

  function localIsoDate(daysOffset) {
    if (window.MB && typeof window.MB.localIsoDate === 'function') {
      return window.MB.localIsoDate(daysOffset);
    }
    var d = new Date();
    d.setHours(12, 0, 0, 0);
    if (daysOffset && isFinite(Number(daysOffset))) {
      d.setDate(d.getDate() + Math.round(Number(daysOffset)));
    }
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1);
    if (m.length < 2) m = '0' + m;
    var day = String(d.getDate());
    if (day.length < 2) day = '0' + day;
    return y + '-' + m + '-' + day;
  }

  function formatOrderDate(ymd) {
    if (window.MB && typeof window.MB.formatOrderDate === 'function') {
      return window.MB.formatOrderDate(ymd);
    }
    if (!ymd) return '';
    var s = String(ymd).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function prepLabelText(days) {
    var d = Math.max(0, Math.round(Number(days) || 0));
    if (d <= 0) return '';
    return 'Order at least ' + d + ' ' + (d === 1 ? 'day' : 'days') + ' ahead';
  }

  /* ---------- storage helpers ---------- */
  function normalise(raw, type) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (i) {
      return i && i.qty > 0 && typeOf(i.kind) === type;
    }).map(function (i) {
      var idStr = String(i.id || i.sku || i.slug || (i.spec && i.spec.type) || 'item');
      var defaultPrep = i.kind === 'custom'
        ? 1
        : (window.MB && typeof window.MB.defaultPrepDaysForSku === 'function' ? window.MB.defaultPrepDaysForSku(i.sku || idStr, '') : 0);
      return {
        id: idStr,
        kind: i.kind,
        sku: i.sku || '',
        slug: i.slug || '',
        spec: i.spec || null,
        name: i.name || 'Item',
        meta: i.meta || '',
        image: defaultImageFor(i),
        unitPrice: typeof i.unitPrice === 'number' ? i.unitPrice : null,
        originalPrice: typeof i.originalPrice === 'number' ? i.originalPrice : (typeof i.unitPrice === 'number' ? i.unitPrice : null),
        discountPct: typeof i.discountPct === 'number' ? i.discountPct : 0,
        prepDays: (i.prepDays !== undefined && i.prepDays !== null) ? Math.max(0, Math.round(Number(i.prepDays) || 0)) : defaultPrep,
        qty: Math.max(1, Math.min(99, parseInt(i.qty, 10) || 1))
      };
    });
  }

  /* ---------- storage that also works inside a sandboxed frame ---------- */
  function nameStore() {
    try {
      var parsed = JSON.parse(window.name || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function readStore(type) {
    var raw = null;
    try {
      raw = localStorage.getItem(STORES[type]);
    } catch (e) {
      raw = null;
    }
    if (!raw) {
      var mirror = nameStore();
      raw = mirror[STORES[type]] || null;
    }
    if (!raw) return [];
    try {
      return normalise(JSON.parse(raw), type);
    } catch (e) {
      return [];
    }
  }

  function writeStore(type, items) {
    try { localStorage.setItem(STORES[type], JSON.stringify(items)); } catch (e) { /* private mode */ }
    try {
      var mirror = nameStore();
      mirror[STORES[type]] = JSON.stringify(items);
      window.name = JSON.stringify(mirror);
    } catch (e) { /* a frame may refuse window.name too */ }
  }

  /* One-time move of the old combined cart into the two new carts. */
  function migrateLegacy() {
    try {
      if (localStorage.getItem(LEGACY + ':migrated')) return;
      var raw = localStorage.getItem(LEGACY);
      if (raw) {
        var old = JSON.parse(raw) || [];
        ['product', 'class'].forEach(function (type) {
          var mine = normalise(old, type);
          if (mine.length && !readStore(type).length) writeStore(type, mine);
        });
        localStorage.removeItem(LEGACY);
      }
      localStorage.setItem(LEGACY + ':migrated', '1');
    } catch (e) { /* ignore */ }
  }

  /* ---------- money ---------- */
  function money(pesewas) {
    if (typeof pesewas !== 'number' || !isFinite(pesewas)) return 'On request';
    var val = pesewas / 100;
    var neg = val < 0;
    var fixed = Math.abs(val).toFixed(2);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '\u2212 ' : '') + 'GH\u20B5 ' + parts.join('.');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ---------- one cart ---------- */
  function createCart(type) {
    var items = readStore(type);

    function subtotal() {
      return items.reduce(function (s, i) {
        return s + (typeof i.unitPrice === 'number' ? i.unitPrice * i.qty : 0);
      }, 0);
    }

    function count() {
      return items.reduce(function (n, i) { return n + i.qty; }, 0);
    }

    function hasQuote() {
      return items.some(function (i) { return typeof i.unitPrice !== 'number'; });
    }

    function payloadItems() {
      return items.map(function (i) {
        if (i.kind === 'class') {
          return {
            id: i.id,
            kind: 'class',
            slug: i.slug || String(i.id || '').replace(/^class-/, ''),
            name: i.name,
            meta: i.meta,
            image: i.image,
            unitPrice: i.unitPrice,
            qty: 1
          };
        }
        if (i.kind === 'custom') {
          return {
            id: i.id,
            kind: 'custom',
            spec: i.spec,
            name: i.name,
            meta: i.meta,
            image: i.image,
            unitPrice: i.unitPrice,
            prepDays: resolveItemPrepDays(i),
            qty: i.qty
          };
        }
        return {
          id: i.id,
          kind: 'product',
          sku: i.sku || i.id,
          name: i.name,
          meta: i.meta,
          image: i.image,
          unitPrice: i.unitPrice,
          originalPrice: i.originalPrice || i.unitPrice,
          discountPct: i.discountPct || 0,
          prepDays: resolveItemPrepDays(i),
          qty: i.qty
        };
      });
    }

    function changed() {
      if (type === 'class') {
        document.dispatchEvent(new CustomEvent('mb-booking-updated', {
          detail: { items: items.slice(), subtotal: subtotal(), count: count() }
        }));
      } else {
        document.dispatchEvent(new CustomEvent('mb-cart-updated', {
          detail: { items: items.slice(), subtotal: subtotal(), count: count() }
        }));
      }
    }

    function add(payload) {
      var key = payload.id || payload.sku || payload.slug || (payload.spec && payload.spec.type) || 'item';
      var existing = items.find(function (i) { return i.id === key; });
      if (existing) {
        if (type === 'class') {
          existing.qty = 1;
        } else {
          existing.qty = Math.min(99, existing.qty + (payload.qty || 1));
        }
        if (payload.unitPrice !== undefined) existing.unitPrice = typeof payload.unitPrice === 'number' ? payload.unitPrice : null;
        if (payload.originalPrice !== undefined) existing.originalPrice = typeof payload.originalPrice === 'number' ? payload.originalPrice : existing.unitPrice;
        if (payload.discountPct !== undefined) existing.discountPct = Number(payload.discountPct) || 0;
        if (payload.prepDays !== undefined && payload.prepDays !== null) existing.prepDays = Math.max(0, Math.round(Number(payload.prepDays) || 0));
        if (payload.image) existing.image = payload.image;
        if (payload.meta) existing.meta = payload.meta;
      } else {
        var kind = payload.kind || (type === 'class' ? 'class' : 'product');
        var uPrice = typeof payload.unitPrice === 'number' ? payload.unitPrice : null;
        var defaultPrep = kind === 'custom'
          ? 1
          : (window.MB && typeof window.MB.defaultPrepDaysForSku === 'function' ? window.MB.defaultPrepDaysForSku(payload.sku || key, '') : 0);
        items.push({
          id: key,
          kind: kind,
          sku: payload.sku || '',
          slug: payload.slug || '',
          spec: payload.spec || null,
          name: payload.name || 'Item',
          meta: payload.meta || '',
          image: payload.image || defaultImageFor({ kind: kind, id: key, sku: payload.sku, slug: payload.slug }),
          unitPrice: uPrice,
          originalPrice: typeof payload.originalPrice === 'number' ? payload.originalPrice : uPrice,
          discountPct: Number(payload.discountPct) || 0,
          prepDays: (payload.prepDays !== undefined && payload.prepDays !== null) ? Math.max(0, Math.round(Number(payload.prepDays) || 0)) : defaultPrep,
          qty: type === 'class' ? 1 : (payload.qty || 1)
        });
      }
      writeStore(type, items);
      changed();
    }

    function remove(id) {
      items = items.filter(function (i) { return i.id !== id; });
      writeStore(type, items);
      changed();
    }

    function setQty(id, qty) {
      var item = items.find(function (i) { return i.id === id; });
      if (!item) return;
      if (qty <= 0) return remove(id);
      item.qty = Math.min(99, qty);
      writeStore(type, items);
      changed();
    }

    function clear() {
      items = [];
      writeStore(type, items);
      changed();
    }

    function reload() {
      items = readStore(type);
    }

    return {
      type: type,
      add: add, remove: remove, setQty: setQty, clear: clear,
      items: function () { return items.slice(); },
      orderItems: payloadItems,
      subtotal: subtotal, count: count, hasQuote: hasQuote,
      reload: reload
    };
  }

  var carts = { product: createCart('product'), class: createCart('class') };

  /* ---------- slide-out drawer ---------- */
  var drawer, listEl, subEl, quoteEl, toastEl, toastTimer;
  var pageScope = 'product';
  var scope = 'product';
  var config = null;
  var catalogue = null;

  function otherType() { return scope === 'class' ? 'product' : 'class'; }

  function resolveProductDiscountInfo(item) {
    if (!item || item.kind === 'class') {
      return { baseUnit: item ? item.unitPrice : null, netUnit: item ? item.unitPrice : null, discountPct: 0, unitDiscount: 0, lineDiscount: 0 };
    }
    var baseUnit = typeof item.originalPrice === 'number' && item.originalPrice > 0
      ? item.originalPrice
      : (typeof item.unitPrice === 'number' ? item.unitPrice : null);
    var pct = Number(item.discountPct) > 0 ? Math.round(Number(item.discountPct)) : 0;

    if (catalogue && Array.isArray(catalogue.products)) {
      var lookupKey = '';
      if (item.kind === 'custom' && item.spec && item.spec.type === 'celebration' && item.spec.variety) {
        lookupKey = item.spec.variety === 'corporate' ? 'luxury' : String(item.spec.variety);
      } else if (item.kind !== 'custom') {
        lookupKey = String(item.sku || item.id || '');
      }
      if (lookupKey) {
        var match = catalogue.products.filter(function (p) {
          return String(p.sku || '').toLowerCase() === lookupKey.toLowerCase();
        })[0];
        if (match) {
          if (typeof match.price === 'number') baseUnit = match.price;
          pct = Number(match.discountPct) > 0 ? Math.round(Number(match.discountPct)) : 0;
        }
      }
    } else if (config && config.product_discounts) {
      var cKey = String(item.sku || item.id || '');
      if (config.product_discounts[cKey] !== undefined) {
        pct = Number(config.product_discounts[cKey]) || 0;
      }
    }

    if (typeof baseUnit !== 'number' || !isFinite(baseUnit)) {
      return { baseUnit: null, netUnit: null, discountPct: 0, unitDiscount: 0, lineDiscount: 0 };
    }
    var unitDisc = pct > 0 ? Math.round(baseUnit * pct / 100) : 0;
    var netUnit = Math.max(0, baseUnit - unitDisc);
    var qty = Math.max(1, parseInt(item.qty, 10) || 1);
    return {
      baseUnit: baseUnit,
      netUnit: netUnit,
      discountPct: pct,
      unitDiscount: unitDisc,
      lineDiscount: unitDisc * qty
    };
  }

  function computeProductCartDiscount(prodItems) {
    if (!prodItems || !prodItems.length) return { subtotal: 0, discount: 0, netTotal: 0, pctLabels: [] };
    var gross = 0;
    var disc = 0;
    var pcts = [];
    prodItems.forEach(function (item) {
      var info = resolveProductDiscountInfo(item);
      if (typeof info.baseUnit === 'number') {
        gross += info.baseUnit * item.qty;
        disc += info.lineDiscount;
        if (info.discountPct > 0 && pcts.indexOf(info.discountPct + '%') === -1) {
          pcts.push(info.discountPct + '%');
        }
      }
    });
    return {
      subtotal: gross,
      discount: disc,
      netTotal: Math.max(0, gross - disc),
      pctLabels: pcts
    };
  }

  function resolveItemPrepDays(item) {
    if (!item || item.kind === 'class') return 0;
    var prep = (item.prepDays !== undefined && item.prepDays !== null)
      ? Math.max(0, Math.round(Number(item.prepDays) || 0))
      : (item.kind === 'custom'
          ? 1
          : (window.MB && typeof window.MB.defaultPrepDaysForSku === 'function'
              ? window.MB.defaultPrepDaysForSku(item.sku || item.id, '')
              : 0));

    if (catalogue && Array.isArray(catalogue.products)) {
      var lookupKey = '';
      if (item.kind === 'custom' && item.spec && item.spec.type === 'celebration' && item.spec.variety) {
        lookupKey = item.spec.variety === 'corporate' ? 'luxury' : String(item.spec.variety);
      } else if (item.kind !== 'custom') {
        lookupKey = String(item.sku || item.id || '');
      }
      if (lookupKey) {
        var match = catalogue.products.filter(function (p) {
          return String(p.sku || '').toLowerCase() === lookupKey.toLowerCase();
        })[0];
        if (match && match.prepDays !== undefined && match.prepDays !== null) {
          prep = Math.max(item.kind === 'custom' ? 1 : 0, Math.round(Number(match.prepDays) || 0));
        }
      }
    } else if (config && config.product_prep_days) {
      var cKey = String(item.sku || item.id || '');
      if (config.product_prep_days[cKey] !== undefined) {
        prep = Math.max(0, Math.round(Number(config.product_prep_days[cKey]) || 0));
      }
    }
    if (item.kind === 'custom' && prep < 1) prep = 1;
    return prep;
  }

  function computeProductCartPrep(prodItems) {
    var list = Array.isArray(prodItems) ? prodItems : [];
    var maxPrepDays = 0;
    var prepItems = [];
    list.forEach(function (item) {
      var pDays = resolveItemPrepDays(item);
      if (pDays > maxPrepDays) maxPrepDays = pDays;
      if (pDays > 0) {
        prepItems.push({
          id: item.id,
          name: item.name,
          prepDays: pDays
        });
      }
    });
    var limitingItems = prepItems.filter(function (pi) {
      return pi.prepDays === maxPrepDays && maxPrepDays > 0;
    });
    var earliestYmd = localIsoDate(maxPrepDays);
    return {
      maxPrepDays: maxPrepDays,
      earliestDate: earliestYmd,
      earliestDateFormatted: formatOrderDate(earliestYmd),
      todayDate: localIsoDate(0),
      prepItems: prepItems,
      limitingItems: limitingItems
    };
  }

  function ensureDrawerEnhancements() {
    if (!drawer) return;
    var panel = drawer.querySelector('.cart-panel');
    if (!panel) return;

    // 1. Ensure backdrop overlay element exists behind the slide-out panel
    if (!drawer.querySelector('.cart-backdrop')) {
      var backdrop = document.createElement('div');
      backdrop.className = 'cart-backdrop';
      backdrop.setAttribute('data-cart-close', '');
      backdrop.setAttribute('aria-hidden', 'true');
      drawer.insertBefore(backdrop, panel);
    }

    // 2. Ensure scope switcher tabs exist inside the slide-out panel
    if (!panel.querySelector('.cart-tabs')) {
      var head = panel.querySelector('.cart-head');
      var tabs = document.createElement('div');
      tabs.className = 'cart-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Switch between Product Cart and Class Booking');
      tabs.innerHTML =
        '<button type="button" class="cart-tab" data-cart-tab="product" role="tab" aria-selected="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6h15l-1.6 9.4a2 2 0 01-2 1.6H9.3a2 2 0 01-2-1.7L6 6z"/><path d="M6 6L5 2.6H2"/><circle cx="9.5" cy="20.4" r="1.5"/><circle cx="17.5" cy="20.4" r="1.5"/></svg>' +
          '<span>Products</span>' +
          '<span class="cart-tab__badge" data-tab-count="product">0</span>' +
        '</button>' +
        '<button type="button" class="cart-tab" data-cart-tab="class" role="tab" aria-selected="false">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 016.5 3H20v18H6.5A2.5 2.5 0 014 18.5z"/><path d="M8 7h8M8 11h6"/></svg>' +
          '<span>Classes</span>' +
          '<span class="cart-tab__badge" data-tab-count="class">0</span>' +
        '</button>';
      if (head && head.nextSibling) {
        panel.insertBefore(tabs, head.nextSibling);
      } else {
        panel.insertBefore(tabs, panel.firstChild);
      }
    }

    // 3. Ensure bundle discount line and preparation lead-time note exist in footer
    var foot = panel.querySelector('.cart-foot');
    var subRow = panel.querySelector('.cart-subtotal');
    if (foot && subRow && !panel.querySelector('#cart-discount-row')) {
      var discRow = document.createElement('div');
      discRow.className = 'cart-discount';
      discRow.id = 'cart-discount-row';
      discRow.hidden = true;
      discRow.innerHTML = '<span id="cart-discount-label">Bundle discount</span><b id="cart-discount-val">- GH&#8373; 0.00</b>';
      foot.insertBefore(discRow, subRow);
    }
    if (foot && !panel.querySelector('#cart-prep-note')) {
      var prepRow = document.createElement('div');
      prepRow.className = 'cart-prep-note';
      prepRow.id = 'cart-prep-note';
      prepRow.hidden = true;
      if (subRow && subRow.nextSibling) {
        foot.insertBefore(prepRow, subRow.nextSibling);
      } else {
        foot.appendChild(prepRow);
      }
    }
  }

  function computeClassBundleDiscount(classItems) {
    /* Rule: Class bundle discounts ONLY apply when 2 or more classes are selected */
    if (!classItems || classItems.length < 2) return { discount: 0, pctLabels: [] };
    var twoPct = (config && config.bundle_two_pct !== undefined) ? Number(config.bundle_two_pct) : 15;
    var threePct = (config && config.bundle_three_pct !== undefined) ? Number(config.bundle_three_pct) : 25;
    if (!isFinite(twoPct)) twoPct = 15;
    if (!isFinite(threePct)) threePct = 25;
    var groups = { bread: [], pastry: [] };
    classItems.forEach(function (item) {
      var slug = String(item.slug || item.id || '').toLowerCase();
      var meta = String(item.meta || '').toLowerCase();
      var track = (slug.indexOf('pastry') !== -1 || meta.indexOf('pastry') !== -1) ? 'pastry' : 'bread';
      groups[track].push(item);
    });
    var discount = 0;
    var pctLabels = [];
    var remaining = [];
    ['bread', 'pastry'].forEach(function (t) {
      var g = groups[t];
      var pct = g.length >= 3 ? threePct : (g.length === 2 ? twoPct : 0);
      if (pct > 0) {
        var sum = g.reduce(function (s, x) { return s + (typeof x.unitPrice === 'number' ? x.unitPrice : 0); }, 0);
        discount += Math.round(sum * pct / 100);
        pctLabels.push(pct + '% ' + t);
      } else if (g.length) {
        remaining = remaining.concat(g);
      }
    });
    if (remaining.length > 0 && classItems.length >= 2) {
      var crossPct = classItems.length >= 3 ? threePct : twoPct;
      if (crossPct > 0) {
        var rSum = remaining.reduce(function (s, x) { return s + (typeof x.unitPrice === 'number' ? x.unitPrice : 0); }, 0);
        discount += Math.round(rSum * crossPct / 100);
        pctLabels.push(crossPct + '% bundle');
      }
    }
    return { discount: discount, pctLabels: pctLabels };
  }

  function lineMarkup(i) {
    var discInfo = resolveProductDiscountInfo(i);
    var prepDays = resolveItemPrepDays(i);
    var hasPrice = typeof discInfo.baseUnit === 'number';
    var hasDisc = hasPrice && discInfo.discountPct > 0;
    var effUnit = hasDisc ? discInfo.netUnit : discInfo.baseUnit;
    var lineTotal = hasPrice
      ? (hasDisc
          ? '<s style="opacity:.52;font-weight:400;font-size:.78rem;margin-right:5px">' + money(discInfo.baseUnit * i.qty) + '</s>' + money(effUnit * i.qty)
          : money(effUnit * i.qty))
      : '<span class="cart-line__quote">Confirmed by baker</span>';
    var unitEach = '';
    if (hasPrice && hasDisc) {
      unitEach = '<span class="cart-line__unit"><s style="opacity:.55">' + money(discInfo.baseUnit) + '</s> ' + money(effUnit) + ' each (\u2212' + discInfo.discountPct + '%)</span>';
    } else if (hasPrice && i.qty > 1) {
      unitEach = '<span class="cart-line__unit">' + money(effUnit) + ' each</span>';
    }
    var kindTag = i.kind === 'class' ? 'Class booking'
      : (i.kind === 'custom' ? 'Custom cake' : (hasDisc ? '\u2212' + discInfo.discountPct + '% off' : ''));
    var prepBadgeHtml = prepDays > 0
      ? '<span class="prep-badge prep-badge--sm" data-prep-days="' + prepDays + '">' + esc(prepLabelText(prepDays)) + '</span>'
      : '';
    var imgSrc = defaultImageFor(i);
    var stepper = i.kind === 'class'
      ? '<div class="qty qty--fixed"><span>1 place</span></div>'
      : '<div class="qty" role="group" aria-label="Quantity for ' + esc(i.name) + '">' +
          '<button type="button" data-act="dec" aria-label="Decrease quantity of ' + esc(i.name) + '">&minus;</button>' +
          '<span>' + i.qty + '</span>' +
          '<button type="button" data-act="inc" aria-label="Increase quantity of ' + esc(i.name) + '">+</button>' +
        '</div>';

    return '' +
      '<div class="cart-line" data-id="' + esc(i.id) + '">' +
        (imgSrc ? '<img class="cart-line__img" src="' + esc(imgSrc) + '" alt="' + esc(i.name) + '" loading="lazy">' : '') +
        '<div class="cart-line__body">' +
          '<p class="cart-line__name">' + esc(i.name) + '</p>' +
          (kindTag ? '<span class="cart-line__tag">' + kindTag + '</span>' : '') +
          prepBadgeHtml +
          (i.meta ? '<p class="cart-line__meta">' + esc(i.meta) + '</p>' : '') +
          '<div class="cart-line__foot">' +
            stepper +
            '<div class="cart-line__pricing">' +
              unitEach +
              '<span class="cart-line__price">' + lineTotal + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="cart-line__x" data-act="remove" aria-label="Remove ' + esc(i.name) + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        '</button>' +
      '</div>';
  }

  function render() {
    var cart = carts[scope];
    var prodCount = carts.product.count();
    var classCount = carts.class.count();
    var activeCount = cart.count();
    var headerCount = carts[pageScope].count() || (prodCount + classCount);

    // Header badge always shows the page's primary cart count, or the non-empty cart count
    document.querySelectorAll('.cart-btn [data-cart-count]').forEach(function (b) {
      b.textContent = headerCount;
      b.classList.toggle('is-empty', headerCount === 0);
    });

    // Drawer header count reflects currently active tab in drawer
    if (drawer) {
      drawer.classList.toggle('is-class', scope === 'class');
      drawer.classList.toggle('is-product', scope === 'product');
      var titleEl = drawer.querySelector('#cart-title');
      if (titleEl) {
        titleEl.textContent = scope === 'class' ? 'Your class booking' : 'Your product cart';
      }
      var kindLine = drawer.querySelector('.cart-kindline');
      if (kindLine) {
        kindLine.textContent = scope === 'class'
          ? 'Baking school courses only. Bundle discounts apply automatically when booking 2 or 3 classes in the same track.'
          : 'Bakery products & custom cakes. Classes are booked separately and never share this cart.';
      }
      drawer.querySelectorAll('.cart-head [data-cart-count]').forEach(function (b) {
        b.textContent = activeCount;
      });
      drawer.querySelectorAll('[data-cart-word]').forEach(function (w) {
        w.textContent = activeCount === 1
          ? (scope === 'class' ? 'class' : 'item')
          : (scope === 'class' ? 'classes' : 'items');
      });
      drawer.querySelectorAll('[data-cart-tab]').forEach(function (tabBtn) {
        var t = tabBtn.getAttribute('data-cart-tab');
        var isOn = t === scope;
        tabBtn.classList.toggle('is-on', isOn);
        tabBtn.setAttribute('aria-selected', isOn ? 'true' : 'false');
      });
      var prodBadge = drawer.querySelector('[data-tab-count="product"]');
      if (prodBadge) prodBadge.textContent = prodCount;
      var classBadge = drawer.querySelector('[data-tab-count="class"]');
      if (classBadge) classBadge.textContent = classCount;
    }

    document.querySelectorAll('[data-cart-open]').forEach(function (b) {
      b.setAttribute('aria-label', headerCount > 0
        ? 'Open cart (' + headerCount + ' ' + (headerCount === 1 ? 'item' : 'items') + ')'
        : 'Open your cart');
    });

    var rawSub = cart.subtotal();
    var discRow = drawer ? drawer.querySelector('#cart-discount-row') : null;
    var prepRow = drawer ? drawer.querySelector('#cart-prep-note') : null;
    if (scope === 'class') {
      var bundleInfo = computeClassBundleDiscount(cart.items());
      if (discRow) {
        discRow.hidden = bundleInfo.discount <= 0;
        var dLbl = drawer.querySelector('#cart-discount-label');
        var dVal = drawer.querySelector('#cart-discount-val');
        if (dLbl) dLbl.textContent = 'Bundle saving (' + bundleInfo.pctLabels.join(', ') + ')';
        if (dVal) dVal.textContent = '\u2212 ' + money(bundleInfo.discount);
      }
      if (prepRow) prepRow.hidden = true;
      if (subEl) subEl.textContent = money(Math.max(0, rawSub - bundleInfo.discount));
    } else {
      var prodInfo = computeProductCartDiscount(cart.items());
      if (discRow) {
        discRow.hidden = prodInfo.discount <= 0;
        var pLbl = drawer.querySelector('#cart-discount-label');
        var pVal = drawer.querySelector('#cart-discount-val');
        if (pLbl) pLbl.textContent = 'Product discount (' + prodInfo.pctLabels.join(', ') + ')';
        if (pVal) pVal.textContent = '\u2212 ' + money(prodInfo.discount);
      }
      if (subEl) subEl.textContent = money(prodInfo.discount > 0 ? prodInfo.netTotal : rawSub);
      if (prepRow) {
        var curItems = cart.items();
        if (!curItems.length) {
          prepRow.hidden = true;
        } else {
          var prepInfo = computeProductCartPrep(curItems);
          prepRow.hidden = false;
          if (prepInfo.maxPrepDays > 0) {
            prepRow.innerHTML =
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
              '<span><strong>Advance preparation required:</strong> Order at least ' + prepInfo.maxPrepDays + ' ' +
              (prepInfo.maxPrepDays === 1 ? 'day' : 'days') + ' ahead. Earliest available date: <strong>' +
              esc(prepInfo.earliestDateFormatted) + '</strong>.</span>';
          } else {
            prepRow.innerHTML =
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
              '<span><strong>Preferred order date:</strong> Select the day you want your pastries at checkout (earliest available: <strong>' +
              esc(prepInfo.earliestDateFormatted) + '</strong>).</span>';
          }
        }
      }
    }

    if (quoteEl) quoteEl.hidden = !cart.hasQuote();

    var other = document.querySelector('[data-cart-other]');
    var otherCart = carts[otherType()];
    if (other) {
      var on = otherCart.count();
      var onLabel = otherType() === 'class' ? 'class booking' : 'product cart';
      other.innerHTML = on
        ? 'Separately, you have <strong>' + on + '</strong> ' +
          (otherType() === 'class'
            ? (on === 1 ? 'class' : 'classes') + ' in your booking'
            : (on === 1 ? 'item' : 'items') + ' in your product cart') +
          '. <button type="button" class="link-underline cart-switch-link" data-cart-tab="' + otherType() + '">Switch to ' + onLabel + '</button>'
        : '';
      other.hidden = !on;
    }

    if (!listEl) return;

    if (!cart.items().length) {
      listEl.innerHTML = '<div class="cart-empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
        (scope === 'class'
          ? '<path d="M4 5.5A2.5 2.5 0 016.5 3H20v18H6.5A2.5 2.5 0 014 18.5z"/><path d="M8 7h8M8 11h6"/>'
          : '<path d="M6 6h15l-1.6 9.4a2 2 0 01-2 1.6H9.3a2 2 0 01-2-1.7L6 6z"/><path d="M6 6L5 2.6H2"/><circle cx="9.5" cy="20.4" r="1.5"/><circle cx="17.5" cy="20.4" r="1.5"/>') +
        '</svg>' +
        (scope === 'class'
          ? '<p>No classes selected.</p><span>Pick classes to see fees and any bundle saving.</span>' +
            '<a class="btn btn--gold btn--sm" href="classes.html">Browse Classes</a>'
          : '<p>Your cart is empty.</p><span>Add bakery items or build a custom cake and they will appear here.</span>' +
            '<a class="btn btn--gold btn--sm" href="products.html">Browse Products</a>') +
        '</div>';
    } else {
      listEl.innerHTML = cart.items().map(lineMarkup).join('');
    }

    document.querySelectorAll('a[data-cart-send]').forEach(function (b) {
      var empty = !cart.items().length;
      b.setAttribute('href', scope === 'class' ? 'booking.html' : 'checkout.html');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' +
        (scope === 'class' ? 'Continue to class booking' : 'Proceed to Checkout');
      b.setAttribute('aria-disabled', empty ? 'true' : 'false');
      b.classList.toggle('is-disabled', empty);
      b.style.opacity = empty ? '.5' : '';
      b.style.pointerEvents = empty ? 'none' : '';
    });
  }

  function renderAll() {
    carts.product.reload();
    carts.class.reload();
    render();
  }

  function openDrawer(preferredScope) {
    if (!drawer) return;
    if (preferredScope === 'product' || preferredScope === 'class') {
      scope = preferredScope;
    } else if (carts[scope].count() === 0 && carts[otherType()].count() > 0) {
      scope = otherType();
    }
    render();
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('[data-cart-open]').forEach(function (b) {
      b.setAttribute('aria-expanded', 'true');
    });
    document.body.classList.add('cart-drawer-open');
    document.body.style.overflow = 'hidden';
    var close = drawer.querySelector('[data-cart-close].cart-close') || drawer.querySelector('[data-cart-close]');
    if (close && close.focus) {
      setTimeout(function () { close.focus({ preventScroll: true }); }, 60);
    }
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('[data-cart-open]').forEach(function (b) {
      b.setAttribute('aria-expanded', 'false');
    });
    document.body.classList.remove('cart-drawer-open');
    document.body.style.overflow = '';
  }

  function toast(name, landedIn) {
    if (!toastEl) return;
    var label = landedIn === 'class' ? 'Added to your class booking' : 'Added to your cart';
    toastEl.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
      '<span><strong>' + label + '</strong>' + esc(name) + '</span>' +
      '<button type="button" class="toast__view" data-toast-open="' + landedIn + '">View cart</button>' +
      '<a href="' + (landedIn === 'class' ? 'booking.html' : 'checkout.html') + '">' +
        (landedIn === 'class' ? 'Book now' : 'Checkout') +
      '</a>';
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 4200);
  }

  /* ---------- scoped facade used by page scripts ---------- */
  function scoped() {
    var cart = carts[pageScope];
    return {
      scope: pageScope,
      add: function (payload) { return addItem(payload); },
      remove: cart.remove,
      setQty: cart.setQty,
      clear: cart.clear,
      open: openDrawer,
      close: closeDrawer,
      items: cart.items,
      orderItems: cart.orderItems,
      subtotal: cart.subtotal,
      count: cart.count,
      hasQuote: cart.hasQuote,
      money: money,
      refresh: render,
      config: function () { return config; }
    };
  }

  /* Adding is routed by item kind, so a class never lands in the product cart
     and a cake never lands in the booking, whichever page the click came from. */
  function addItem(payload) {
    var type = typeOf(payload && payload.kind) || pageScope;
    carts[type].add(payload);
    scope = type;
    render();
    return type;
  }

  function updateBadges() {
    render();
  }

  /* ---------- init ---------- */
  function init() {
    migrateLegacy();

    drawer = document.getElementById('cart-drawer');
    if (drawer) {
      pageScope = drawer.getAttribute('data-scope') === 'class' ? 'class' : 'product';
      scope = pageScope;
      drawer.classList.add('is-' + scope);
      ensureDrawerEnhancements();
    }
    listEl = document.getElementById('cart-items');
    subEl = document.getElementById('cart-subtotal');
    quoteEl = document.getElementById('cart-quote-note');
    toastEl = document.getElementById('cart-toast');

    render();

    document.addEventListener('click', function (e) {
      var openBtn = e.target.closest('[data-cart-open]');
      if (openBtn) {
        e.preventDefault();
        if (drawer && drawer.classList.contains('is-open')) closeDrawer();
        else openDrawer();
        return;
      }

      var toastOpenBtn = e.target.closest('[data-toast-open]');
      if (toastOpenBtn) {
        e.preventDefault();
        if (toastEl) toastEl.classList.remove('is-visible');
        openDrawer(toastOpenBtn.getAttribute('data-toast-open'));
        return;
      }

      var tabBtn = e.target.closest('[data-cart-tab]');
      if (tabBtn) {
        e.preventDefault();
        var nextScope = tabBtn.getAttribute('data-cart-tab');
        if (nextScope === 'product' || nextScope === 'class') {
          scope = nextScope;
          render();
        }
        return;
      }

      if (e.target.closest('[data-cart-close]') || e.target === drawer) {
        e.preventDefault();
        closeDrawer();
        return;
      }

      var addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        e.preventDefault();
        var payload;
        try { payload = JSON.parse(addBtn.getAttribute('data-add')); } catch (err) { return; }
        var landed = addItem(payload);
        toast(payload.name, landed);
        addBtn.classList.add('is-added');
        setTimeout(function () { addBtn.classList.remove('is-added'); }, 1400);
        return;
      }

      var actBtn = e.target.closest('[data-act]');
      if (actBtn) {
        var line = actBtn.closest('.cart-line');
        if (!line) return;
        var id = line.getAttribute('data-id');
        var cart = carts[scope];
        var item = cart.items().find(function (i) { return i.id === id; });
        if (!item) return;
        var act = actBtn.getAttribute('data-act');
        if (act === 'inc') cart.setQty(id, item.qty + 1);
        if (act === 'dec') cart.setQty(id, item.qty - 1);
        if (act === 'remove') cart.remove(id);
        render();
        return;
      }

      if (e.target.closest('[data-cart-clear]')) {
        carts[scope].clear();
        render();
        return;
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer && drawer.classList.contains('is-open')) closeDrawer();
    });

    window.addEventListener('storage', function (e) {
      if (e.key === STORES.product || e.key === STORES.class) {
        renderAll();
      } else if (e.key === 'mb-local-db-v1') {
        refreshCatalogue();
      }
    });

    window.addEventListener('mb-catalogue-updated', function () {
      refreshCatalogue();
    });

    refreshCatalogue();
  }

  function syncStorefrontWithCatalogue(data) {
    if (!data || !Array.isArray(data.products)) return;
    var bySku = {};
    var byName = {};
    var byCat = {};
    data.products.forEach(function (p) {
      bySku[String(p.sku || '').toLowerCase()] = p;
      byName[String(p.name || '').trim().toLowerCase()] = p;
      var cat = p.category || '';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(p);
    });

    /* 1. Sync [data-add] product rows (.vrow) and celebration cake cards (.cake-card) on products.html */
    document.querySelectorAll('[data-add]').forEach(function (btn) {
      var payload;
      try { payload = JSON.parse(btn.getAttribute('data-add')); } catch (e) { return; }
      if (!payload) return;
      var sku = String(payload.id || payload.sku || '').toLowerCase();
      var prod = bySku[sku];
      if (!prod || typeof prod.price !== 'number') return;

      var pct = Number(prod.discountPct) > 0 ? Math.round(Number(prod.discountPct)) : 0;
      var prepDays = (prod.prepDays !== undefined && prod.prepDays !== null)
        ? Math.max(0, Math.round(Number(prod.prepDays) || 0))
        : (window.MB && typeof window.MB.defaultPrepDaysForSku === 'function' ? window.MB.defaultPrepDaysForSku(prod.sku, prod.category) : 0);
      var base = prod.price;
      var cut = pct > 0 ? Math.round(base * pct / 100) : 0;
      var net = Math.max(0, base - cut);

      payload.unitPrice = base;
      payload.originalPrice = base;
      payload.discountPct = pct;
      payload.prepDays = prepDays;
      if (prod.image) {
        payload.image = prod.image.indexOf('assets/img/') === 0 ? prod.image : ('assets/img/' + prod.image);
      }
      btn.setAttribute('data-add', JSON.stringify(payload));

      var vrow = btn.closest('.vrow');
      if (vrow) {
        var vPrice = vrow.querySelector('.vrow__price');
        if (vPrice) {
          if (pct > 0) {
            vPrice.innerHTML =
              '<span class="price-old">' + money(base) + '</span> ' +
              '<span class="price-new">' + money(net) + '</span> ' +
              '<span class="disc-pill">\u2212' + pct + '%</span>';
          } else {
            vPrice.textContent = money(base);
          }
        }
        var vMeta = vrow.querySelector('.vrow__meta');
        if (vMeta) {
          var existingBadge = vMeta.querySelector('.prep-badge');
          if (prepDays > 0) {
            if (!existingBadge) {
              vMeta.insertAdjacentHTML('beforeend', ' <span class="prep-badge" data-prep-days="' + prepDays + '">' + esc(prepLabelText(prepDays)) + '</span>');
            } else {
              existingBadge.setAttribute('data-prep-days', String(prepDays));
              existingBadge.textContent = prepLabelText(prepDays);
              existingBadge.hidden = false;
            }
          } else if (existingBadge) {
            existingBadge.hidden = true;
          }
        }
      }

      var cakeCard = btn.closest('.cake-card');
      if (cakeCard) {
        var cPrice = cakeCard.querySelector('.cake-card__price');
        if (cPrice) {
          if (pct > 0) {
            cPrice.innerHTML =
              '<small>From <span class="disc-pill">\u2212' + pct + '%</span></small>' +
              '<span class="price-old">' + money(base) + '</span> ' +
              '<span class="price-new">' + money(net) + '</span>';
          } else {
            cPrice.innerHTML = '<small>From</small>' + money(base);
          }
        }
        var cBadge = cakeCard.querySelector('.prep-badge');
        if (prepDays > 0) {
          if (cBadge) {
            cBadge.setAttribute('data-prep-days', String(prepDays));
            cBadge.textContent = prepLabelText(prepDays);
            cBadge.hidden = false;
          }
        } else if (cBadge) {
          cBadge.hidden = true;
        }
      }
    });

    /* 2. Sync category cards (.menu-card) and celebration cards (.cake-card without [data-add]) on menu.html */
    document.querySelectorAll('.menu-card[href*="products.html#"]').forEach(function (card) {
      var href = card.getAttribute('href') || '';
      var catSlug = href.split('#')[1] || '';
      var list = byCat[catSlug];
      if (!list || !list.length) return;
      var priceEl = card.querySelector('.menu-card__price');
      if (!priceEl) return;

      var minNet = Infinity, maxNet = 0, maxPct = 0;
      list.forEach(function (p) {
        if (typeof p.price !== 'number') return;
        var pct = Number(p.discountPct) > 0 ? Math.round(Number(p.discountPct)) : 0;
        var net = Math.max(0, p.price - Math.round(p.price * pct / 100));
        if (net < minNet) minNet = net;
        if (net > maxNet) maxNet = net;
        if (pct > maxPct) maxPct = pct;
      });
      if (!isFinite(minNet)) return;
      priceEl.innerHTML = money(minNet) + ' to ' + money(maxNet) +
        (maxPct > 0 ? ' <span class="disc-pill">Up to \u2212' + maxPct + '%</span>' : '');
    });

    document.querySelectorAll('a.cake-card').forEach(function (card) {
      var nameEl = card.querySelector('.cake-card__name');
      var priceEl = card.querySelector('.cake-card__price');
      if (!nameEl || !priceEl) return;
      var prod = byName[String(nameEl.textContent || '').trim().toLowerCase()];
      if (!prod || typeof prod.price !== 'number') return;
      var pct = Number(prod.discountPct) > 0 ? Math.round(Number(prod.discountPct)) : 0;
      var base = prod.price;
      var net = Math.max(0, base - Math.round(base * pct / 100));
      if (pct > 0) {
        priceEl.innerHTML =
          '<small>From <span class="disc-pill">\u2212' + pct + '%</span></small>' +
          '<span class="price-old">' + money(base) + '</span> ' +
          '<span class="price-new">' + money(net) + '</span>';
      } else {
        priceEl.innerHTML = '<small>From</small>' + money(base);
      }
    });

    /* 3. Sync featured product cards (.pcard) on index.html */
    document.querySelectorAll('.pcard').forEach(function (card) {
      var link = card.querySelector('a[href*="products.html#"]');
      var priceEl = card.querySelector('.pcard__price');
      if (!link || !priceEl) return;
      var catSlug = (link.getAttribute('href') || '').split('#')[1] || '';
      var list = byCat[catSlug];
      if (!list || !list.length) return;
      var minBase = Infinity, minNet = Infinity, maxPct = 0;
      list.forEach(function (p) {
        if (typeof p.price !== 'number') return;
        var pct = Number(p.discountPct) > 0 ? Math.round(Number(p.discountPct)) : 0;
        var net = Math.max(0, p.price - Math.round(p.price * pct / 100));
        if (p.price < minBase) minBase = p.price;
        if (net < minNet) minNet = net;
        if (pct > maxPct) maxPct = pct;
      });
      if (!isFinite(minNet)) return;
      if (maxPct > 0) {
        priceEl.innerHTML =
          '<small>From <span class="disc-pill">\u2212' + maxPct + '%</span></small>' +
          (minNet < minBase ? '<span class="price-old">' + money(minBase) + '</span> ' : '') +
          '<span class="price-new">' + money(minNet) + '</span>';
      } else {
        priceEl.innerHTML = '<small>From</small>' + money(minNet);
      }
    });
  }

  function refreshCatalogue() {
    if (!window.MB || typeof window.MB.api !== 'function') return;
    window.MB.api('/api/catalogue')
      .then(function (d) {
        if (!d || !d.ok) return;
        catalogue = d;
        config = d.config || config;
        syncStorefrontWithCatalogue(d);
        renderAll();
      })
      .catch(function () { });
  }

  /* ---------- public api ---------- */
  window.MBCarts = {
    product: carts.product,
    class: carts.class,
    money: money,
    add: addItem,
    open: openDrawer,
    close: closeDrawer,
    refresh: render,
    updateBadges: updateBadges,
    resolveProductDiscount: resolveProductDiscountInfo,
    computeProductCartDiscount: computeProductCartDiscount,
    resolveItemPrepDays: resolveItemPrepDays,
    computeProductCartPrep: computeProductCartPrep,
    localIsoDate: localIsoDate,
    formatOrderDate: formatOrderDate
  };

  function boot() {
    init();
    window.MBCart = scoped();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
