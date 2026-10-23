/* ============================================================
   Mystery Bakebite: product checkout
   ------------------------------------------------------------
   Bakery products only. Classes have their own page.
   Payment is never taken here: the customer pays the bakery and
   submits a reference or screenshot, which stays under review
   until the baker verifies the funds.
   Enforces:
   - Required Preferred Order Date (eventDate) selection
   - Product-specific advance preparation lead times (max prepDays across cart)
   - Branded Thank-You confirmation experience on successful order submission
   ============================================================ */
(function () {
  'use strict';

  var state = {
    config: null,
    pricing: null,
    fulfilment: 'pickup',
    payment: '',
    submitting: false,
    idemKey: null,
    dateTouched: false
  };

  var el = {};

  function cart() {
    return window.MBCarts ? window.MBCarts.product : null;
  }

  function money(p) { return window.MBPay.money(p); }
  function esc(s) { return window.MBPay.esc(s); }
  function overThreshold() {
    return window.MBPay.overThreshold(state.config, state.pricing ? state.pricing.total : null);
  }

  function localIsoDate(daysOffset) {
    if (window.MBCarts && typeof window.MBCarts.localIsoDate === 'function') {
      return window.MBCarts.localIsoDate(daysOffset);
    }
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
    if (window.MBCarts && typeof window.MBCarts.formatOrderDate === 'function') {
      return window.MBCarts.formatOrderDate(ymd);
    }
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

  function resolveLinePrepDays(item) {
    if (window.MBCarts && typeof window.MBCarts.resolveItemPrepDays === 'function') {
      return window.MBCarts.resolveItemPrepDays(item);
    }
    if (item && item.prepDays !== undefined && item.prepDays !== null) {
      return Math.max(0, Math.round(Number(item.prepDays) || 0));
    }
    return item && item.kind === 'custom' ? 1 : 0;
  }

  function computeCartPrepInfo(items) {
    var base = (window.MBCarts && typeof window.MBCarts.computeProductCartPrep === 'function')
      ? window.MBCarts.computeProductCartPrep(items)
      : {
          maxPrepDays: 0,
          earliestDate: localIsoDate(0),
          earliestDateFormatted: formatOrderDate(localIsoDate(0)),
          todayDate: localIsoDate(0),
          prepItems: [],
          limitingItems: []
        };
    var srvMax = Number(state.pricing && state.pricing.max_prep_days) || 0;
    if (srvMax > base.maxPrepDays) {
      base.maxPrepDays = srvMax;
      base.earliestDate = localIsoDate(srvMax);
      base.earliestDateFormatted = formatOrderDate(base.earliestDate);
    }
    return base;
  }

  function alertBox(kind, message) {
    el.alert.hidden = false;
    el.alert.innerHTML = '<div class="alert alert--' + kind + '"><svg viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
      '<path d="M12 11v5M12 8h.01"/></svg><span>' + message + '</span></div>';
    el.alert.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function clearAlert() { el.alert.hidden = true; el.alert.innerHTML = ''; }

  /* ---------- modal ---------- */
  function openModal(title, body, actions, extraClass) {
    document.getElementById('pay-modal-body').innerHTML =
      '<h2 id="pay-modal-title">' + esc(title) + '</h2>' +
      '<div class="pay-modal__body' + (extraClass ? ' ' + extraClass : '') + '">' + body + '</div>' +
      (actions ? '<div class="pay-modal__actions">' + actions + '</div>' : '');
    document.getElementById('pay-modal').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    document.getElementById('pay-modal').classList.remove('is-open');
    document.body.style.overflow = '';
  }

  /* ---------- Preferred Order Date scheduling & validation ---------- */
  function renderDateScheduleUI(items) {
    if (!el.date) return;
    var prepInfo = computeCartPrepInfo(items || []);
    el.date.setAttribute('min', prepInfo.earliestDate);

    if (el.dateBanner) {
      if (!items || !items.length) {
        el.dateBanner.innerHTML =
          '<div class="prep-schedule-banner__inner">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
            '<div><strong>Select your preferred order date</strong><span>Add pastries to your cart to calculate the earliest available preparation date.</span></div>' +
          '</div>';
      } else if (prepInfo.maxPrepDays > 0) {
        var limNames = prepInfo.limitingItems.map(function (pi) { return esc(pi.name); });
        var limText = limNames.length
          ? ' (' + limNames.slice(0, 3).join(', ') + (limNames.length > 3 ? ', +' + (limNames.length - 3) + ' more' : '') + ')'
          : '';
        el.dateBanner.innerHTML =
          '<div class="prep-schedule-banner__inner prep-schedule-banner__inner--advance">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
            '<div>' +
              '<strong>Advance ordering recommended: order at least ' + prepInfo.maxPrepDays + ' ' + (prepInfo.maxPrepDays === 1 ? 'day' : 'days') + ' ahead</strong>' +
              '<span>Your cart includes freshly baked-to-order items' + limText + '. Earliest available collection or delivery date: <b>' + esc(prepInfo.earliestDateFormatted) + '</b>.</span>' +
            '</div>' +
          '</div>';
      } else {
        el.dateBanner.innerHTML =
          '<div class="prep-schedule-banner__inner">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
            '<div>' +
              '<strong>Choose the day you want your pastries</strong>' +
              '<span>Earliest available date for your current cart is <b>' + esc(prepInfo.earliestDateFormatted) + '</b>, or pick any future date below.</span>' +
            '</div>' +
          '</div>';
      }
    }

    if (el.dateQuick) {
      var curVal = (el.date.value || '').trim();
      var baseOffset = prepInfo.maxPrepDays;
      var quickOffsets = [
        { offset: baseOffset, label: baseOffset > 0 ? 'Earliest (' + formatOrderDate(localIsoDate(baseOffset)) + ')' : 'Today (' + formatOrderDate(localIsoDate(0)) + ')' },
        { offset: Math.max(1, baseOffset + 1), label: (baseOffset === 0 ? 'Tomorrow (' : '+' + (baseOffset + 1) + ' days (') + formatOrderDate(localIsoDate(Math.max(1, baseOffset + 1))) + ')' },
        { offset: baseOffset + 2, label: '+' + (baseOffset + 2) + ' days (' + formatOrderDate(localIsoDate(baseOffset + 2)) + ')' }
      ];
      el.dateQuick.innerHTML = quickOffsets.map(function (q) {
        var ymd = localIsoDate(q.offset);
        var isOn = curVal === ymd;
        return '<button type="button" class="date-quick-pill' + (isOn ? ' is-on' : '') + '" data-quick-date="' + esc(ymd) + '">' +
          esc(q.label) +
        '</button>';
      }).join('');
    }

    validateOrderDate(state.dateTouched);
  }

  function validateOrderDate(showFeedback) {
    var items = cart() ? cart().items() : [];
    var prepInfo = computeCartPrepInfo(items);
    var val = el.date ? (el.date.value || '').trim() : '';

    if (!val) {
      if (el.sumDate) {
        el.sumDate.textContent = 'Select a date (required)';
        el.sumDate.style.color = 'var(--caramel)';
      }
      if (showFeedback && el.dateFeedback) {
        el.dateFeedback.hidden = false;
        el.dateFeedback.innerHTML =
          '<div class="alert alert--warn" style="margin:0">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>' +
            '<span>Please select the preferred date you want your pastries ready. Earliest available date: <strong>' + esc(prepInfo.earliestDateFormatted) + '</strong>. ' +
              '<button type="button" class="link-underline" data-use-earliest="' + esc(prepInfo.earliestDate) + '" style="margin-left:6px;background:none;border:0;color:var(--caramel);cursor:pointer;font:inherit;font-weight:600">Select ' + esc(prepInfo.earliestDateFormatted) + '</button>' +
            '</span>' +
          '</div>';
      } else if (el.dateFeedback) {
        el.dateFeedback.hidden = true;
        el.dateFeedback.innerHTML = '';
      }
      return {
        valid: false,
        code: 'date_required',
        earliestDate: prepInfo.earliestDate,
        earliestDateFormatted: prepInfo.earliestDateFormatted,
        message: 'Please select your preferred order date (the day you want your pastries) before submitting your order. Earliest available date: ' + prepInfo.earliestDateFormatted + '.'
      };
    }

    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
    var parsed = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : null;
    var isRealDate = !!(
      parsed &&
      !isNaN(parsed.getTime()) &&
      parsed.getFullYear() === Number(m[1]) &&
      (parsed.getMonth() + 1) === Number(m[2]) &&
      parsed.getDate() === Number(m[3])
    );

    if (!isRealDate) {
      if (el.sumDate) {
        el.sumDate.textContent = 'Invalid date';
        el.sumDate.style.color = '#F2C3B8';
      }
      if (el.dateFeedback) {
        el.dateFeedback.hidden = false;
        el.dateFeedback.innerHTML =
          '<div class="alert alert--error" style="margin:0">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>' +
            '<span>Please enter a valid calendar date. Earliest available date: <strong>' + esc(prepInfo.earliestDateFormatted) + '</strong>.</span>' +
          '</div>';
      }
      return {
        valid: false,
        code: 'date_invalid',
        earliestDate: prepInfo.earliestDate,
        earliestDateFormatted: prepInfo.earliestDateFormatted,
        message: 'Please choose a valid calendar date for your order.'
      };
    }

    if (val < prepInfo.todayDate) {
      if (el.sumDate) {
        el.sumDate.textContent = 'Unavailable (' + formatOrderDate(val) + ')';
        el.sumDate.style.color = '#F2C3B8';
      }
      var pastMsg = 'The selected date (' + formatOrderDate(val) + ') is in the past. Earliest available date for your order is ' + prepInfo.earliestDateFormatted + '.';
      if (el.dateFeedback) {
        el.dateFeedback.hidden = false;
        el.dateFeedback.innerHTML =
          '<div class="alert alert--error" style="margin:0">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>' +
            '<span>' + esc(pastMsg) + ' ' +
              '<button type="button" class="link-underline" data-use-earliest="' + esc(prepInfo.earliestDate) + '" style="margin-left:6px;background:none;border:0;color:var(--caramel);cursor:pointer;font:inherit;font-weight:600">Use earliest available date (' + esc(prepInfo.earliestDateFormatted) + ')</button>' +
            '</span>' +
          '</div>';
      }
      return {
        valid: false,
        code: 'date_in_past',
        earliestDate: prepInfo.earliestDate,
        earliestDateFormatted: prepInfo.earliestDateFormatted,
        message: pastMsg
      };
    }

    if (val < prepInfo.earliestDate) {
      if (el.sumDate) {
        el.sumDate.textContent = 'Unavailable (' + formatOrderDate(val) + ')';
        el.sumDate.style.color = '#F2C3B8';
      }
      var limitingNames = prepInfo.limitingItems.map(function (pi) { return pi.name; });
      var itemDesc = limitingNames.length
        ? limitingNames.slice(0, 2).join(' and ') + (limitingNames.length > 2 ? ' (+' + (limitingNames.length - 2) + ' more)' : '')
        : 'items in your cart';
      var leadMsg = 'Selected date (' + formatOrderDate(val) + ') is unavailable because ' + itemDesc +
        ' ' + (limitingNames.length === 1 ? 'requires' : 'require') + ' at least ' +
        prepInfo.maxPrepDays + ' ' + (prepInfo.maxPrepDays === 1 ? 'day' : 'days') +
        ' of advance preparation. Earliest suitable date: ' + prepInfo.earliestDateFormatted + '.';
      if (el.dateFeedback) {
        el.dateFeedback.hidden = false;
        el.dateFeedback.innerHTML =
          '<div class="alert alert--error" style="margin:0">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>' +
            '<span>' + esc(leadMsg) + ' ' +
              '<button type="button" class="link-underline" data-use-earliest="' + esc(prepInfo.earliestDate) + '" style="margin-left:6px;background:none;border:0;color:var(--caramel);cursor:pointer;font:inherit;font-weight:600">Select ' + esc(prepInfo.earliestDateFormatted) + '</button>' +
            '</span>' +
          '</div>';
      }
      return {
        valid: false,
        code: 'date_too_early',
        earliestDate: prepInfo.earliestDate,
        earliestDateFormatted: prepInfo.earliestDateFormatted,
        message: leadMsg
      };
    }

    var formatted = formatOrderDate(val);
    if (el.sumDate) {
      el.sumDate.textContent = formatted;
      el.sumDate.style.color = '#9FD08A';
    }
    if (el.dateFeedback) {
      if (state.dateTouched) {
        el.dateFeedback.hidden = false;
        el.dateFeedback.innerHTML =
          '<div class="alert alert--ok" style="margin:0">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
            '<span>Preferred order date confirmed: <strong>' + esc(formatted) + '</strong> (' + esc(val) + ').</span>' +
          '</div>';
      } else {
        el.dateFeedback.hidden = true;
        el.dateFeedback.innerHTML = '';
      }
    }
    return {
      valid: true,
      date: val,
      formattedDate: formatted,
      earliestDate: prepInfo.earliestDate,
      earliestDateFormatted: prepInfo.earliestDateFormatted
    };
  }

  /* ---------- payment methods ---------- */
  function methodList() {
    var currentTotal = state.pricing ? state.pricing.total : (cart() ? cart().subtotal() : null);
    return window.MBPay.methods({
      config: state.config || {},
      total: currentTotal,
      kind: 'product',
      fulfilment: state.fulfilment
    });
  }

  function updateDeliveryRow() {
    var row = document.getElementById('sum-delivery-row');
    var lbl = document.getElementById('sum-delivery-label');
    var val = document.getElementById('sum-delivery');
    if (!row || !lbl || !val) return;
    if (state.fulfilment === 'delivery') {
      lbl.textContent = 'Delivery (Within Tamale)';
      val.textContent = 'Confirmed by baker';
    } else {
      lbl.textContent = 'Collection (Bakery pickup)';
      val.textContent = 'Free';
    }
  }

  function renderPayments() {
    var list = methodList();
    var over = overThreshold();
    var currentTotal = state.pricing ? state.pricing.total : (cart() ? cart().subtotal() : 0);

    // Ensure a valid default selection if none selected yet
    if (!state.payment) {
      var firstAvail = list.filter(function (m) { return m.available && !m.advanceRequired; })[0];
      if (firstAvail) state.payment = firstAvail.key;
    }

    el.payments.innerHTML = list.map(function (m) {
      var disabledReason = (!m.available && !m.advanceRequired) ? (m.reason || 'Not available.') : '';
      var isSelected = state.payment === m.key;

      var classes = ['pay-opt'];
      if (isSelected) classes.push('is-on');
      if (disabledReason) classes.push('is-disabled');
      if (m.advanceRequired) classes.push('is-locked');

      return '<button type="button" class="' + classes.join(' ') + '" data-pay="' + m.key + '"' +
        ' aria-pressed="' + (isSelected ? 'true' : 'false') + '"' +
        (disabledReason ? ' disabled aria-disabled="true"' : '') + '>' +
        '<span class="pay-opt__dot" aria-hidden="true"></span>' +
        '<span class="pay-opt__body">' +
          '<b>' + esc(m.title) +
            (m.recommended && m.available ? '<span class="pay-opt__rec">Recommended</span>' : '') +
            (isSelected ? '<span class="pay-opt__sel">Selected</span>' : '') +
          '</b>' +
          '<span>' + esc(disabledReason || m.sub) + '</span>' +
          (m.advanceRequired
            ? '<span class="pay-opt__tag">Advance payment required above ' +
              money(window.MBPay.threshold(state.config)) + '</span>' : '') +
        '</span>' +
      '</button>';
    }).join('');

    if (state.payment && window.MBPay.inlineSummary) {
      var inlineHtml = window.MBPay.inlineSummary({
        config: state.config,
        method: state.payment,
        total: currentTotal,
        kind: 'product'
      });
      if (inlineHtml && el.payments.insertAdjacentHTML) {
        el.payments.insertAdjacentHTML('beforeend', inlineHtml);
      }
    }

    if (over && el.payments.insertAdjacentHTML) {
      el.payments.insertAdjacentHTML('beforeend',
        '<p class="pay-rule">Orders above ' + money(window.MBPay.threshold(state.config)) +
        ' require advance payment. Choose Mobile Money or bank transfer to complete your payment.</p>');
    }
  }

  function syncFulfilmentUI(fulfil) {
    state.fulfilment = fulfil;
    document.querySelectorAll('[data-fulfil]').forEach(function (b) {
      var on = b.getAttribute('data-fulfil') === fulfil;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (el.addressField) el.addressField.hidden = fulfil !== 'delivery';
    updateDeliveryRow();
  }

  function openPaymentGuideModal(key) {
    var guide = window.MBPay.guide({
      config: state.config, method: key, total: total(), kind: 'product'
    });
    openModal(guide.title, guide.body,
      (guide.actions || '') +
      '<button type="button" class="btn btn--glass" data-modal-close>Understood</button>');
  }

  function choosePayment(key, showModalNow) {
    var option = methodList().filter(function (m) { return m.key === key; })[0];
    if (!option) return;

    if (option.advanceRequired) {
      var adv = window.MBPay.advance(state.config);
      openModal(adv.title, adv.body,
        '<button type="button" class="btn btn--gold" data-modal-close>Choose another method</button>');
      return;
    }

    if (!option.available) {
      var g = window.MBPay.guide({ config: state.config, method: key, total: total(), kind: 'product' });
      openModal(g.title, g.body,
        (g.actions || '') + '<button type="button" class="btn btn--glass" data-modal-close>Close</button>');
      return;
    }

    // Automatically sync fulfilment when choosing cash_on_delivery or cash_on_pickup
    if (key === 'cash_on_delivery' && state.fulfilment !== 'delivery') {
      syncFulfilmentUI('delivery');
    } else if (key === 'cash_on_pickup' && state.fulfilment !== 'pickup') {
      syncFulfilmentUI('pickup');
    }

    state.payment = key;
    renderPayments();
    clearAlert();

    if (showModalNow) {
      openPaymentGuideModal(key);
    }
  }

  function total() {
    if (state.pricing && typeof state.pricing.total === 'number') return state.pricing.total;
    return cart() ? cart().subtotal() : 0;
  }

  /* ---------- summary ---------- */
  function renderSummary() {
    var items = cart() ? cart().items() : [];
    updateDeliveryRow();

    if (!items.length) {
      state.pricing = { ok: true, subtotal: 0, discount: 0, total: 0, has_quote: false, max_prep_days: 0, earliest_date: localIsoDate(0) };
      el.summaryCount.textContent = 'Your cart is empty';
      el.summaryItems.innerHTML = '';
      el.sumSubtotal.textContent = money(0);
      el.sumTotal.textContent = money(0);
      if (el.sumDiscountRow) el.sumDiscountRow.hidden = true;
      el.place.disabled = true;
      el.sumNote.innerHTML = 'Add something from the <a class="link-underline" href="products.html">bakery catalogue</a> first. ' +
        'Baking classes are booked separately on the <a class="link-underline" href="classes.html">classes page</a>.';
      renderDateScheduleUI([]);
      renderPayments();
      return;
    }

    var count = items.reduce(function (n, i) { return n + i.qty; }, 0);
    el.summaryCount.textContent = count + ' item' + (count === 1 ? '' : 's');

    el.summaryItems.innerHTML = items.map(function (i) {
      var dInfo = (window.MBCarts && window.MBCarts.resolveProductDiscount)
        ? window.MBCarts.resolveProductDiscount(i)
        : { baseUnit: i.unitPrice, netUnit: i.unitPrice, discountPct: 0, lineDiscount: 0 };
      var prepDays = resolveLinePrepDays(i);
      var hasPrice = typeof dInfo.baseUnit === 'number';
      var hasDisc = hasPrice && dInfo.discountPct > 0;
      var lineGross = hasPrice ? dInfo.baseUnit * i.qty : null;
      var lineNet = hasPrice ? dInfo.netUnit * i.qty : null;
      var unitTxt = '';
      if (hasPrice && hasDisc) {
        unitTxt = money(dInfo.netUnit) + ' each (\u2212' + dInfo.discountPct + '% off)';
      } else if (hasPrice && i.qty > 1) {
        unitTxt = money(dInfo.baseUnit) + ' each';
      }
      var prepBadgeHtml = prepDays > 0
        ? '<span class="prep-badge prep-badge--sm" data-prep-days="' + prepDays + '">Order at least ' + prepDays + ' ' + (prepDays === 1 ? 'day' : 'days') + ' ahead</span>'
        : '';
      return '<div class="summary-line" data-sum-id="' + esc(i.id) + '">' +
        (i.image ? '<img class="summary-line__img" src="' + esc(i.image) + '" alt="" loading="lazy">' : '') +
        '<div class="summary-line__info">' +
          '<span class="summary-line__name">' + esc(i.name) + '</span>' +
          (i.meta ? '<span class="summary-line__meta">' + esc(i.meta) + '</span>' : '') +
          prepBadgeHtml +
          '<div class="summary-line__controls">' +
            '<div class="qty qty--sm" role="group" aria-label="Quantity for ' + esc(i.name) + '">' +
              '<button type="button" data-sum-act="dec" aria-label="Decrease quantity">&minus;</button>' +
              '<span>' + i.qty + '</span>' +
              '<button type="button" data-sum-act="inc" aria-label="Increase quantity">+</button>' +
            '</div>' +
            '<button type="button" class="summary-line__rm" data-sum-act="remove" aria-label="Remove ' + esc(i.name) + '">Remove</button>' +
          '</div>' +
        '</div>' +
        '<div class="summary-line__right">' +
          '<span class="summary-line__amt">' +
            (lineGross === null
              ? 'On request'
              : (hasDisc
                  ? '<s style="opacity:.52;font-weight:400;font-size:.78rem;margin-right:5px">' + money(lineGross) + '</s>' + money(lineNet)
                  : money(lineGross))) +
          '</span>' +
          (hasDisc ? '<span class="summary-line__cut" style="color:var(--caramel);font-size:.76rem">\u2212' + dInfo.discountPct + '% (\u2212 ' + money(dInfo.lineDiscount) + ')</span>' : '') +
          (unitTxt ? '<span class="summary-line__unit">' + esc(unitTxt) + '</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    // Immediate client-side calculation including any active product discounts & prep requirements
    var prodSummary = (window.MBCarts && window.MBCarts.computeProductCartDiscount)
      ? window.MBCarts.computeProductCartDiscount(items)
      : { subtotal: cart().subtotal(), discount: 0, netTotal: cart().subtotal(), pctLabels: [] };
    var localPrep = computeCartPrepInfo(items);
    var localSub = prodSummary.subtotal;
    var localDisc = prodSummary.discount;
    var localNet = prodSummary.netTotal;
    var localQuote = cart().hasQuote();
    state.pricing = {
      ok: true,
      subtotal: localSub,
      discount: localDisc,
      total: localNet,
      has_quote: localQuote,
      max_prep_days: localPrep.maxPrepDays,
      earliest_date: localPrep.earliestDate
    };
    el.sumSubtotal.textContent = money(localSub);
    if (el.sumDiscountRow) {
      el.sumDiscountRow.hidden = !localDisc;
      var discSpan = el.sumDiscountRow.querySelector('span');
      if (discSpan) {
        discSpan.textContent = prodSummary.pctLabels.length
          ? 'Product discount (' + prodSummary.pctLabels.join(', ') + ')'
          : 'Discount';
      }
      if (localDisc) el.sumDiscount.textContent = '\u2212 ' + money(localDisc);
    }
    el.sumTotal.textContent = money(localNet);
    el.place.disabled = false;
    renderDateScheduleUI(items);
    renderPayments();
    checkCashStillEligible();

    MB.api('/api/price', { method: 'POST', body: { items: cart().orderItems() } }).then(function (data) {
      if (!data || !data.ok) {
        return;
      }
      var effSubtotal = (typeof data.subtotal === 'number' && (data.subtotal > 0 || localSub === 0))
        ? data.subtotal
        : localSub;
      var effDiscount = typeof data.discount === 'number' ? data.discount : localDisc;
      var effTotal = (typeof data.total === 'number' && (data.total > 0 || localSub === 0))
        ? data.total
        : Math.max(0, effSubtotal - effDiscount);

      state.pricing = {
        ok: true,
        subtotal: effSubtotal,
        discount: effDiscount,
        total: effTotal,
        has_quote: !!(data.has_quote && localQuote),
        max_prep_days: Math.max(localPrep.maxPrepDays, Number(data.max_prep_days) || 0),
        earliest_date: data.earliest_date || localPrep.earliestDate
      };
      el.sumSubtotal.textContent = money(effSubtotal);
      if (el.sumDiscountRow) {
        el.sumDiscountRow.hidden = !effDiscount;
        var dSpan = el.sumDiscountRow.querySelector('span');
        if (dSpan) {
          var bPct = window.mbBundlePct ? window.mbBundlePct(data.bundles) : '';
          dSpan.textContent = bPct ? 'Product discount (' + bPct + ')' : 'Discount';
        }
        if (effDiscount) el.sumDiscount.textContent = '\u2212 ' + money(effDiscount);
      }
      el.sumTotal.textContent = money(effTotal);
      el.place.disabled = false;

      var notes = [];
      if (state.pricing.has_quote) {
        notes.push('Some items are priced by the baker and are not included in this total. They are confirmed before baking.');
      }
      notes.push('Class bundle discounts do not apply to bakery products. Classes are booked separately.');
      el.sumNote.innerHTML = notes.map(esc).join(' ');

      renderDateScheduleUI(cart().items());
      renderPayments();
      checkCashStillEligible();
    }).catch(function () {
      // Keep the accurate client-calculated subtotal/total if network RPC fails
      renderPayments();
    });
  }

  /* a cash choice cannot survive a total that now needs advance payment */
  function checkCashStillEligible() {
    if (!state.payment) return;
    if (window.MBPay.cashMethods[state.payment] && overThreshold()) {
      state.payment = '';
      renderPayments();
      var adv = window.MBPay.advance(state.config);
      openModal(adv.title, adv.body,
        '<button type="button" class="btn btn--gold" data-modal-close>Choose another method</button>');
    }
  }

  /* ---------- receipt (strictly for the order only, auto-downloaded to device) ---------- */
  function downloadReceipt(ref) {
    if (window.MB && typeof window.MB.downloadReceiptPdf === 'function') {
      window.MB.downloadReceiptPdf(state.placedOrder || ref, state.config || state.token);
      return true;
    }
    return false;
  }

  /* ---------- account requirement ----------
     A verified, signed-in customer account is required before an order can be
     submitted. The redirect is a convenience: the database RPC re-checks the
     session and e-mail verification independently. */
  var ACCOUNT_PAGE = 'account.html';
  var REDIRECT_KEY = 'mb-account-return-v1';

  function signedIn() {
    return !!(window.MB && typeof window.MB.isCustomerSignedIn === 'function' && window.MB.isCustomerSignedIn());
  }

  function currentActor() {
    if (!window.MB) return null;
    try {
      if (typeof window.MB.currentActor === 'function') return window.MB.currentActor();
    } catch (e) {}
    return null;
  }

  function rememberReturnTo() {
    try {
      localStorage.setItem(REDIRECT_KEY, 'checkout.html');
    } catch (e) {}
  }

  function goToAccount(reason) {
    rememberReturnTo();
    var target = ACCOUNT_PAGE + '?next=checkout.html';
    if (reason) target += '&reason=' + encodeURIComponent(reason);
    window.location.replace(target);
  }

  function renderAccountBar() {
    var bar = document.getElementById('checkout-account-bar');
    var text = document.getElementById('checkout-account-text');
    if (!bar || !text) return;
    if (!signedIn()) {
      bar.hidden = true;
      return;
    }
    var actor = currentActor() || {};
    var label = actor.fullName || (window.MB.customerDisplayName ? window.MB.customerDisplayName() : '') || actor.email || 'you';
    bar.hidden = false;
    text.innerHTML = 'Ordering as <strong>' + String(label).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    }) + '</strong>' + (actor.email ? ' &middot; ' + String(actor.email).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    }) : '');
  }

  function prefillFromAccount() {
    var actor = currentActor();
    if (!actor) return;
    if (el.name && !el.name.value) el.name.value = actor.fullName || '';
    if (el.phone && !el.phone.value) el.phone.value = actor.phone || '';
    if (el.email) {
      el.email.value = actor.email || '';
      el.email.readOnly = true;
      el.email.setAttribute('readonly', 'readonly');
    }
  }

  function handleAuthGateError(data) {
    if (!data) return false;
    if (data.code === 'auth_required') {
      setTimeout(function () { goToAccount('signin_required'); }, 1200);
      alertBox('error', 'Please sign in to your customer account to place this order. Taking you to sign in…');
      return true;
    }
    if (data.code === 'email_not_verified') {
      alertBox('error', esc(data.error || 'Please verify your email address before ordering.') +
        ' <a href="account.html?verify=1">Resend the confirmation email</a>.');
      return true;
    }
    return false;
  }

  /* ---------- submit ---------- */
  function submit() {
    if (state.submitting) return;
    clearAlert();

    /* Re-check the session immediately before creating the order. */
    if (!signedIn()) {
      return goToAccount('signin_required');
    }

    var name = (el.name.value || '').trim();
    var phone = (el.phone.value || '').trim();
    var email = (el.email.value || '').trim();
    var notes = (el.notes.value || '').trim();
    var address = (el.address.value || '').trim();

    if (!cart() || !cart().items().length) {
      return alertBox('error', 'Your cart is empty. Add something before submitting.');
    }
    if (name.length < 2) return alertBox('error', 'Please enter the name for the order.');
    if (!/^[0-9+()\-\s]{7,20}$/.test(phone)) return alertBox('error', 'Please enter a phone number the baker can reach you on.');
    if (email && !/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) return alertBox('error', 'That email address does not look right.');

    state.dateTouched = true;
    var dateCheck = validateOrderDate(true);
    if (!dateCheck.valid) {
      if (el.date && el.date.focus) el.date.focus();
      return alertBox('error', esc(dateCheck.message));
    }

    if (state.fulfilment === 'delivery' && address.length < 6) return alertBox('error', 'Please add the delivery address, or switch to collection.');
    if (!state.payment) return alertBox('error', 'Choose how you will pay, or message the kitchen if you are unsure.');
    if (window.MBPay.cashMethods[state.payment] && overThreshold()) {
      var adv = window.MBPay.advance(state.config);
      openModal(adv.title, adv.body, '<button type="button" class="btn btn--gold" data-modal-close>Choose another method</button>');
      return;
    }

    if (!state.idemKey) {
      state.idemKey = 'co-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    state.submitting = true;
    el.place.disabled = true;
    el.place.textContent = 'Submitting…';

    MB.api('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': state.idemKey },
      body: {
        name: name, phone: phone, email: email, notes: notes,
        customer: { name: name, phone: phone, email: email },
        fulfilment: state.fulfilment,
        address: state.fulfilment === 'delivery' ? address : '',
        eventDate: dateCheck.date,
        paymentMethod: state.payment,
        items: cart().orderItems()
      }
    }).then(function (data) {
      var res = { data: (data && data.data) ? data.data : data };
      if (!res.data || !res.data.ok || !res.data.order) {
        state.submitting = false;
        el.place.disabled = false;
        el.place.textContent = 'Submit order';
        if (res.data && res.data.earliestDate && el.date) {
          el.date.setAttribute('min', res.data.earliestDate);
          validateOrderDate(true);
        }
        if (res.data && res.data.code === 'advance_required') {
          var adv = window.MBPay.advance(state.config);
          openModal(adv.title, adv.body,
            '<button type="button" class="btn btn--gold" data-modal-close>Choose another method</button>');
          return;
        }
        if (handleAuthGateError(res.data)) return;
        return alertBox('error', esc((res.data && res.data.error) || 'The order could not be submitted.'));
      }
      showResult(res.data);
    }).catch(function () {
      state.submitting = false;
      el.place.disabled = false;
      el.place.textContent = 'Submit order';
      alertBox('error', 'We could not reach the server. Check your connection and try again. Your cart is still saved.');
    });
  }

  /* ---------- confirmation ---------- */
  function showResult(data) {
    if (!data || !data.order || !data.order.ref) return;
    var order = data.order;
    var ref = order.ref;
    state.placedOrder = order;
    state.token = data.token || '';
    var method = state.payment || order.paymentMethod || 'momo';
    var isAdvance = !!window.MBPay.advanceMethods[method];
    var totalTxt = money(order.total);
    var prefDateRaw = order.eventDate || order.event_date || '';
    var prefDateText = prefDateRaw ? formatOrderDate(prefDateRaw) : 'Confirmed with baker';
    var firstName = ((order.customer && order.customer.name) ? order.customer.name : 'Friend').split(/\s+/)[0];
    var receiptFilename = 'Mystery-Bakebite-Order-Receipt-' + ref + '.pdf';

    cart().clear();
    el.checkoutView.hidden = true;
    el.done.hidden = false;

    var statusSplitHtml = isAdvance
      ? '<div class="thankyou-card__status-split">' +
          '<div class="thankyou-status-pill thankyou-status-pill--order">' +
            '<span class="thankyou-status-pill__kicker">1. Order Confirmation</span>' +
            '<strong>Order Recorded (' + esc(ref) + ')</strong>' +
            '<span>Your pastry order and preferred date (<strong>' + esc(prefDateText) + '</strong>) have been saved.</span>' +
          '</div>' +
          '<div class="thankyou-status-pill thankyou-status-pill--payment">' +
            '<span class="thankyou-status-pill__kicker">2. Payment Confirmation</span>' +
            '<strong>Payment Awaiting Submission &amp; Baker Verification</strong>' +
            '<span>Your order is not marked paid until you complete the transfer below and the baker verifies the funds.</span>' +
          '</div>' +
        '</div>'
      : '<div class="thankyou-card__status-split">' +
          '<div class="thankyou-status-pill thankyou-status-pill--order">' +
            '<span class="thankyou-status-pill__kicker">1. Order Confirmation</span>' +
            '<strong>Order Recorded (' + esc(ref) + ')</strong>' +
            '<span>Your pastry order and preferred date (<strong>' + esc(prefDateText) + '</strong>) have been saved.</span>' +
          '</div>' +
          '<div class="thankyou-status-pill thankyou-status-pill--payment">' +
            '<span class="thankyou-status-pill__kicker">2. Payment Arrangement</span>' +
            '<strong>' + (method === 'cash_on_delivery' ? 'Cash on Delivery' : 'Cash on Collection') + '</strong>' +
            '<span>No online payment has been collected yet. The baker records the cash when the order is handed over.</span>' +
          '</div>' +
        '</div>';

    var payBlock = '';

    if (isAdvance) {
      var guide = window.MBPay.guide({
        config: state.config, method: method, total: order.total, kind: 'product', ref: ref
      });
      payBlock =
        '<div class="panel" id="pay-later" style="margin-top:1.2rem">' +
          '<h2>' + esc(guide.title) + '</h2>' +
          '<div class="pay-modal__body">' + guide.body + '</div>' +

          '<div class="proof-block" id="proof-block">' +
            '<h3 style="font-size:1.02rem;margin-bottom:.4rem">Submit your payment details</h3>' +
            '<p class="panel__hint">Send the money first. Then add the transaction reference, a screenshot, or both. ' +
            'This puts the payment under review; the baker confirms it after checking the funds.</p>' +
            '<div class="field">' +
              '<label for="pf-ref">Transaction reference or ID</label>' +
              '<input type="text" id="pf-ref" maxlength="80" placeholder="e.g. the reference in your Mobile Money or bank message" autocomplete="off">' +
            '</div>' +
            '<div class="field upload-field">' +
              '<span class="upload-field__label">Payment confirmation screenshot <small>(optional)</small></span>' +
              '<label class="upload" id="pf-zone" for="pf-file">' +
                '<input type="file" id="pf-file" accept="image/png,image/jpeg,image/webp">' +
                '<span class="upload__icon" aria-hidden="true">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0L8 8m4-4l4 4"/><path d="M4 16v2.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V16"/></svg>' +
                '</span>' +
                '<span class="upload__text">' +
                  '<b id="pf-title">Add a payment screenshot (optional)</b>' +
                  '<span>PNG, JPEG or WebP &middot; up to 5 MB &middot; click or drag &amp; drop</span>' +
                '</span>' +
                '<span class="upload__cta">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
                  '<span id="pf-cta-txt">Choose screenshot</span>' +
                '</span>' +
              '</label>' +
              '<div class="upload__meta" id="pf-file-meta" hidden>' +
                '<div class="upload__meta-info">' +
                  '<span class="upload__meta-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>' +
                  '<div class="upload__meta-text">' +
                    '<span class="upload__filename" id="pf-file-name"></span>' +
                    '<span class="upload__filesize" id="pf-file-size"></span>' +
                  '</div>' +
                '</div>' +
                '<button type="button" class="upload__remove" id="pf-file-clear" aria-label="Remove selected screenshot">Remove</button>' +
              '</div>' +
              '<div class="upload__preview-wrap" id="pf-preview-wrap" hidden>' +
                '<img class="upload__preview" id="pf-preview" alt="Preview of the screenshot you selected">' +
              '</div>' +
              '<div class="upload__msg" id="pf-file-msg" role="status" aria-live="polite" hidden></div>' +
            '</div>' +
            '<div class="alert alert--info" style="margin-top:1rem">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
              '<span>' + esc(window.MBPay.submittedMessage()) + '</span>' +
            '</div>' +
            '<button type="button" class="btn btn--gold" id="pf-send" style="width:100%;justify-content:center;margin-top:.8rem">Submit payment details</button>' +
          '</div>' +
        '</div>';
    } else {
      payBlock =
        '<div class="panel" style="margin-top:1.2rem">' +
          '<h2>' + (method === 'cash_on_delivery' ? 'Cash payment on delivery' : 'Cash payment on pickup') + '</h2>' +
          '<div class="pay-card">' +
            window.MBPay.detailRow('Amount to pay', totalTxt, false, true) +
            window.MBPay.detailRow('Order reference', ref, true) +
            window.MBPay.detailRow('Preferred order date', prefDateText) +
            window.MBPay.detailRow('Payment', method === 'cash_on_delivery' ? 'Cash on delivery' : 'Cash on pickup') +
          '</div>' +
          '<p class="pay-lead" style="margin-top:1rem">' + esc(window.MBPay.cashConfirmation(method, order.total)) + '</p>' +
          '<p class="pay-note">The baker or delivery person records the payment once the cash is received. ' +
          'No advance payment is needed for this amount.</p>' +
        '</div>';
    }

    el.done.innerHTML = '' +
      '<div class="panel thankyou-card" style="max-width:820px;margin:0 auto">' +
        '<div class="thankyou-card__hero">' +
          '<div class="thankyou-card__Seal">' +
            '<img src="assets/img/thank-you.webp" width="144" height="144" alt="Mystery Bakebite — Thank You for supporting my small business. Baked with love, especially for you!">' +
          '</div>' +
          '<div class="thankyou-card__copy">' +
            '<p class="eyebrow">Product order received &middot; Mystery Bakebite</p>' +
            '<h2 style="font-size:clamp(1.6rem,3vw,2.2rem);margin:.3rem 0 .5rem">Thank you, ' + esc(firstName) + '.</h2>' +
            '<p style="font-size:var(--s-3);line-height:1.7;color:rgba(245,230,214,.75)">' +
              'Baked with love, especially for you! Your reference is <strong class="mono" style="color:var(--caramel);font-size:1.05rem">' + esc(ref) + '</strong> ' +
              'for <strong style="color:var(--caramel)">' + esc(prefDateText) + '</strong>. ' +
              (isAdvance
                ? 'Pay the bakery, then submit your payment details below.'
                : 'Pay in cash when you ' + (method === 'cash_on_delivery' ? 'receive' : 'collect') + ' the order.') +
            '</p>' +
          '</div>' +
        '</div>' +

        statusSplitHtml +

        '<div class="alert alert--ok" id="receipt-autodownload-note" style="margin-top:1rem">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>' +
          '<span><strong>Order receipt downloaded automatically to your device:</strong> <span class="mono">' + esc(receiptFilename) + '</span> (strictly for order <span class="mono">' + esc(ref) + '</span>).</span>' +
        '</div>' +

        '<div class="pay-card" style="margin-top:1rem">' +
          window.MBPay.detailRow('Order reference', ref, true) +
          window.MBPay.detailRow('Preferred order date', prefDateText) +
          window.MBPay.detailRow('Fulfilment', order.fulfilment === 'delivery' ? 'Delivery within Tamale' + (order.address ? ' (' + order.address + ')' : '') : 'Collection from Bakery (Tamale)') +
          window.MBPay.detailRow('Total payable', totalTxt, false, true) +
        '</div>' +

        '<div class="alert alert--info" style="margin-top:1.1rem">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
          '<span><strong>This is a product order, not a class booking.</strong> It has its own reference, receipt and payment record. ' +
          'Baking classes are booked separately.</span>' +
        '</div>' +

        (isAdvance
          ? '<div class="alert alert--warn" style="margin-top:1rem" id="pay-state-alert">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
              '<span><strong>Payment is not confirmed yet.</strong> The order stays awaiting payment until the baker ' +
              'verifies the funds.</span>' +
            '</div>'
          : '<div class="alert alert--warn" style="margin-top:1rem">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
              '<span><strong>No payment has been received yet.</strong> The baker records the cash when the order is ' +
              (method === 'cash_on_delivery' ? 'delivered' : 'collected') + '.</span>' +
            '</div>') +

        payBlock +

        '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:1.4rem">' +
          '<a class="btn btn--glass" href="' + esc(data.statusUrl || ('order.html?ref=' + encodeURIComponent(ref))) + '">Track this order</a>' +
          '<button type="button" class="btn btn--glass" id="receipt-again">Download order receipt again (PDF)</button>' +
          '<a class="btn btn--glass" href="' + esc(window.MBPay.waLink(state.config,
            'Hello Mystery Bakebite, about order ' + ref + ' for ' + prefDateText + ' (' + totalTxt + ').')) + '" target="_blank" rel="noopener">Message the kitchen</a>' +
        '</div>' +
        '<p class="form-note">Keep your reference. Anyone with your order link can see its status, so treat it as private.</p>' +
      '</div>';

    var dlBtn = el.done.querySelector('#receipt-again');
    if (dlBtn && dlBtn.addEventListener) {
      dlBtn.addEventListener('click', function () {
        downloadReceipt(ref);
      });
    }

    /* Automatically download the receipt strictly for this order to the user's device */
    downloadReceipt(ref);

    if (isAdvance) bindProofForm(data, order, method);

    if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- proof submission ---------- */
  function formatFileSize(bytes) {
    if (!bytes || !isFinite(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function bindProofForm(data, order, method) {
    var fileEl = el.done.querySelector('#pf-file');
    var zone = el.done.querySelector('#pf-zone');
    var preview = el.done.querySelector('#pf-preview');
    var previewWrap = el.done.querySelector('#pf-preview-wrap');
    var metaBox = el.done.querySelector('#pf-file-meta');
    var metaName = el.done.querySelector('#pf-file-name');
    var metaSize = el.done.querySelector('#pf-file-size');
    var clearBtn = el.done.querySelector('#pf-file-clear');
    var msgBox = el.done.querySelector('#pf-file-msg');
    var ctaTxt = el.done.querySelector('#pf-cta-txt');
    var titleTxt = el.done.querySelector('#pf-title');
    var send = el.done.querySelector('#pf-send');
    var refInput = el.done.querySelector('#pf-ref');
    var file = null;
    var verifiedDataUrl = '';
    var isSubmitting = false;

    function lockProofBlock(submittedOrder) {
      var ord = submittedOrder || order || {};
      var alertEl = el.done.querySelector('#pay-state-alert');
      if (alertEl) {
        alertEl.className = 'alert alert--info';
        alertEl.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
          '<span><strong>Payment under review.</strong> ' + esc(window.MBPay.advanceConfirmation(method)) + '</span>';
      }
      var block = el.done.querySelector('#proof-block');
      if (block) {
        block.setAttribute('data-proof-state', 'locked');
        block.innerHTML =
          '<div class="alert alert--info" style="margin-top:.6rem">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
            '<span><strong>Payment details received and locked for verification.</strong> ' + esc(window.MBPay.submittedMessage()) + '</span>' +
          '</div>' +
          '<div class="pay-card" style="margin-top:.8rem">' +
            window.MBPay.detailRow('Submission status', 'Received — Pending Baker Verification') +
            window.MBPay.detailRow('Transaction reference', ord.paymentRef || 'Screenshot submitted', !!ord.paymentRef) +
            window.MBPay.detailRow('Payment screenshot', ord.hasProof ? 'Uploaded & attached on file' : 'Reference recorded') +
          '</div>' +
          '<p class="form-note" style="margin-top:.7rem">Additional payment submissions are locked for this order while the baker reviews your payment.</p>';
      }
    }

    function setUploadMsg(kind, text) {
      if (!msgBox) return;
      if (!text) {
        msgBox.hidden = true;
        msgBox.className = 'upload__msg';
        msgBox.textContent = '';
        return;
      }
      msgBox.hidden = false;
      msgBox.className = 'upload__msg upload__msg--' + kind;
      msgBox.textContent = text;
    }

    function clearFile() {
      file = null;
      verifiedDataUrl = '';
      if (fileEl) fileEl.value = '';
      if (preview) {
        preview.removeAttribute('src');
        preview.classList.remove('is-on');
      }
      if (previewWrap) previewWrap.hidden = true;
      if (metaBox) metaBox.hidden = true;
      if (zone) zone.classList.remove('has-file');
      if (ctaTxt) ctaTxt.textContent = 'Choose screenshot';
      if (titleTxt) titleTxt.textContent = 'Add a payment screenshot (optional)';
      setUploadMsg('', '');
    }

    function pick(f) {
      if (!f || isSubmitting) return;
      if (window.MB && typeof window.MB.validateImageFile === 'function') {
        window.MB.validateImageFile(f).then(function (v) {
          if (!v.ok) {
            clearFile();
            setUploadMsg('error', v.error);
            alertBox('error', esc(v.error));
            return;
          }
          file = f;
          verifiedDataUrl = v.dataUrl || '';
          if (zone) zone.classList.add('has-file');
          if (metaName) metaName.textContent = f.name || 'payment-screenshot.jpg';
          if (metaSize) metaSize.textContent = formatFileSize(f.size);
          if (metaBox) metaBox.hidden = false;
          if (ctaTxt) ctaTxt.textContent = 'Change screenshot';
          if (titleTxt) titleTxt.textContent = 'Screenshot attached & verified';
          setUploadMsg('ok', 'Screenshot verified (' + (f.name || 'image') + ', ' + formatFileSize(f.size) + ').');
          if (preview && verifiedDataUrl) {
            preview.src = verifiedDataUrl;
            preview.classList.add('is-on');
          }
          if (previewWrap && verifiedDataUrl) previewWrap.hidden = false;
        });
        return;
      }
      if (!/^image\/(png|jpe?g|webp)$/i.test(f.type)) {
        setUploadMsg('error', 'Invalid file format. Please choose a PNG, JPEG or WebP screenshot.');
        alertBox('error', 'Choose a PNG, JPEG or WebP screenshot.');
        return;
      }
      if (f.size > 5 * 1024 * 1024) {
        setUploadMsg('error', 'That file is ' + formatFileSize(f.size) + '. Please select a screenshot under 5 MB.');
        alertBox('error', 'That screenshot is larger than 5 MB. Try a smaller one.');
        return;
      }
      file = f;
      if (zone) zone.classList.add('has-file');
      if (metaName) metaName.textContent = f.name || 'payment-screenshot.jpg';
      if (metaSize) metaSize.textContent = formatFileSize(f.size);
      if (metaBox) metaBox.hidden = false;
      if (ctaTxt) ctaTxt.textContent = 'Change screenshot';
      if (titleTxt) titleTxt.textContent = 'Screenshot attached & ready';
      setUploadMsg('ok', 'Screenshot selected (' + (f.name || 'image') + ', ' + formatFileSize(f.size) + ').');

      var reader = new FileReader();
      reader.onload = function () {
        verifiedDataUrl = String(reader.result || '');
        if (preview) {
          preview.src = verifiedDataUrl;
          preview.classList.add('is-on');
        }
        if (previewWrap) previewWrap.hidden = false;
      };
      reader.readAsDataURL(f);
    }

    if (clearBtn && clearBtn.addEventListener) {
      clearBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!isSubmitting) clearFile();
      });
    }

    if (fileEl && fileEl.addEventListener) {
      fileEl.addEventListener('change', function () { pick(fileEl.files[0]); });
    }
    if (zone && zone.addEventListener) {
      ['dragenter', 'dragover'].forEach(function (e) {
        zone.addEventListener(e, function (ev) { ev.preventDefault(); if (!isSubmitting) zone.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (e) {
        zone.addEventListener(e, function (ev) { ev.preventDefault(); zone.classList.remove('is-over'); });
      });
      zone.addEventListener('drop', function (ev) {
        if (!isSubmitting && ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) pick(ev.dataTransfer.files[0]);
      });
    }

    if (send && send.addEventListener) {
      send.addEventListener('click', function () {
        if (isSubmitting) return;
        var refValue = (refInput.value || '').trim();
        if (!file && refValue.length < 4) {
          setUploadMsg('error', 'Enter your transaction reference ID (at least 4 characters) or attach a payment screenshot above.');
          return alertBox('error', 'Add the transaction reference from your payment message, or upload the screenshot.');
        }
        if (refValue && (refValue.length < 4 || refValue.length > 80 || !/^[A-Za-z0-9\-_./#: ]{4,80}$/.test(refValue))) {
          setUploadMsg('error', 'Transaction reference must be 4 to 80 alphanumeric characters.');
          return alertBox('error', 'Please enter a valid transaction reference ID (4 to 80 characters).');
        }
        setUploadMsg('', '');
        isSubmitting = true;
        send.disabled = true;
        send.textContent = 'Submitting…';
        if (fileEl) fileEl.disabled = true;
        if (refInput) refInput.disabled = true;

        var sendIt = function (imageDataUrl) {
          MB.api('/api/orders/' + encodeURIComponent(order.ref) + '/proof?token=' + encodeURIComponent(data.token), {
            method: 'POST',
            body: { image: imageDataUrl || '', reference: refValue }
          }).then(function (d) {
            if (!d || !d.ok) {
              isSubmitting = false;
              if (d && (d.code === 'duplicate_submission' || d.code === 'already_verified')) {
                lockProofBlock(order);
                return alertBox('info', esc(d.error));
              }
              send.disabled = false;
              send.textContent = 'Submit payment details';
              if (fileEl) fileEl.disabled = false;
              if (refInput) refInput.disabled = false;
              setUploadMsg('error', (d && d.error) || 'The payment details could not be submitted.');
              return alertBox('error', esc((d && d.error) || 'The payment details could not be submitted.'));
            }

            if (d.order) {
              state.placedOrder = d.order;
              downloadReceipt(order.ref);
            }
            lockProofBlock(d.order || { paymentRef: refValue, hasProof: !!imageDataUrl });

            openModal('Payment Details Received',
              '<p class="pay-lead">' + esc(window.MBPay.submittedMessage()) + '</p>',
              '<a class="btn btn--gold" href="' + esc(data.statusUrl) + '">Track this order</a>' +
              '<button type="button" class="btn btn--glass" data-modal-close>Close</button>');
          }).catch(function () {
            isSubmitting = false;
            send.disabled = false;
            send.textContent = 'Submit payment details';
            if (fileEl) fileEl.disabled = false;
            if (refInput) refInput.disabled = false;
            alertBox('error', 'We could not reach the server. Please try again.');
          });
        };

        if (file) {
          if (verifiedDataUrl) {
            sendIt(verifiedDataUrl);
          } else {
            var reader = new FileReader();
            reader.onload = function () { sendIt(reader.result); };
            reader.readAsDataURL(file);
          }
        } else {
          sendIt('');
        }
      });
    }
  }

  /* ---------- init ---------- */
  function init() {
    el.alert = document.getElementById('checkout-alert');
    el.checkoutView = document.getElementById('checkout-view');
    el.done = document.getElementById('checkout-done');
    el.summaryItems = document.getElementById('summary-items');
    el.summaryCount = document.getElementById('summary-count');
    el.sumDateRow = document.getElementById('sum-date-row');
    el.sumDate = document.getElementById('sum-date');
    el.sumSubtotal = document.getElementById('sum-subtotal');
    el.sumDiscount = document.getElementById('sum-discount');
    el.sumDiscountRow = document.getElementById('sum-discount-row');
    el.sumTotal = document.getElementById('sum-total');
    el.sumNote = document.getElementById('sum-note');
    el.payments = document.getElementById('payment-options');
    el.place = document.getElementById('place-order');
    el.name = document.getElementById('co-name');
    el.phone = document.getElementById('co-phone');
    el.email = document.getElementById('co-email');
    el.notes = document.getElementById('co-notes');
    el.date = document.getElementById('co-date');
    el.dateBanner = document.getElementById('co-date-lead-banner');
    el.dateQuick = document.getElementById('co-date-quick');
    el.dateFeedback = document.getElementById('co-date-feedback');
    el.address = document.getElementById('co-address');
    el.addressField = document.getElementById('address-field');

    if (!cart()) {
      el.summaryCount.textContent = 'Cart unavailable';
      return;
    }

    /* Customer accounts are required before checkout. A visitor without a
       verified session is sent to the account page, and the cart is preserved
       in local storage so nothing is lost while signing in. */
    if (!signedIn()) {
      goToAccount('signin_required');
      return;
    }

    renderAccountBar();
    prefillFromAccount();
    if (window.MB && typeof window.MB.refreshCustomerProfile === 'function') {
      window.MB.refreshCustomerProfile().then(function () {
        renderAccountBar();
        prefillFromAccount();
      }).catch(function () {});
    }

    renderPayments();
    renderSummary();

    MB.api('/api/config').then(function (d) {
      if (d && d.config) state.config = d.config;
      renderPayments();
      renderSummary();
    }).catch(function () { renderSummary(); });

    el.place.addEventListener('click', submit);

    if (el.date) {
      el.date.addEventListener('change', function () {
        state.dateTouched = true;
        renderDateScheduleUI(cart() ? cart().items() : []);
        clearAlert();
      });
      el.date.addEventListener('input', function () {
        state.dateTouched = true;
        validateOrderDate(true);
      });
    }

    document.addEventListener('click', function (e) {
      var quickBtn = e.target.closest('[data-quick-date]');
      if (quickBtn && el.date) {
        e.preventDefault();
        el.date.value = quickBtn.getAttribute('data-quick-date') || '';
        state.dateTouched = true;
        renderDateScheduleUI(cart() ? cart().items() : []);
        clearAlert();
        return;
      }

      var useEarliestBtn = e.target.closest('[data-use-earliest]');
      if (useEarliestBtn && el.date) {
        e.preventDefault();
        el.date.value = useEarliestBtn.getAttribute('data-use-earliest') || '';
        state.dateTouched = true;
        renderDateScheduleUI(cart() ? cart().items() : []);
        clearAlert();
        return;
      }

      var payGuideBtn = e.target.closest('[data-pay-guide]');
      if (payGuideBtn) {
        e.preventDefault();
        openPaymentGuideModal(payGuideBtn.getAttribute('data-pay-guide'));
        return;
      }

      var payBtn = e.target.closest('[data-pay]');
      if (payBtn) {
        e.preventDefault();
        choosePayment(payBtn.getAttribute('data-pay'), false);
        return;
      }

      var sumActBtn = e.target.closest('[data-sum-act]');
      if (sumActBtn && cart()) {
        e.preventDefault();
        var sumLine = sumActBtn.closest('[data-sum-id]');
        if (!sumLine) return;
        var itemId = sumLine.getAttribute('data-sum-id');
        var curItem = cart().items().filter(function (i) { return i.id === itemId; })[0];
        if (!curItem) return;
        var sumAct = sumActBtn.getAttribute('data-sum-act');
        if (sumAct === 'inc') cart().setQty(itemId, curItem.qty + 1);
        else if (sumAct === 'dec') cart().setQty(itemId, curItem.qty - 1);
        else if (sumAct === 'remove') cart().remove(itemId);
        if (window.MBCarts && window.MBCarts.refresh) window.MBCarts.refresh();
        renderSummary();
        return;
      }

      if (e.target.closest('[data-modal-close]')) {
        closeModal();
        return;
      }

      var fulfilBtn = e.target.closest('[data-fulfil]');
      if (fulfilBtn) {
        var nextFulfil = fulfilBtn.getAttribute('data-fulfil');
        syncFulfilmentUI(nextFulfil);
        if (state.payment === 'cash_on_delivery' && nextFulfil !== 'delivery' && !overThreshold()) {
          state.payment = 'cash_on_pickup';
        } else if (state.payment === 'cash_on_pickup' && nextFulfil === 'delivery' && !overThreshold()) {
          state.payment = 'cash_on_delivery';
        }
        renderPayments();
        if (state.pricing) checkCashStillEligible();
        return;
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });

    ['input', 'change'].forEach(function (evt) {
      var form = document.getElementById('checkout-form');
      if (form) form.addEventListener(evt, clearAlert);
    });

    document.addEventListener('mb-cart-updated', renderSummary);
    document.addEventListener('mb-booking-updated', renderSummary);
    window.addEventListener('mb-catalogue-updated', renderSummary);
    window.addEventListener('storage', function (e) {
      if (e.key === 'mb-local-db-v1') renderSummary();
    });
    window.addEventListener('mb-auth-changed', function (ev) {
      var detail = ev && ev.detail;
      if (detail && detail.signedIn === false) {
        goToAccount('signed_out');
        return;
      }
      renderAccountBar();
      prefillFromAccount();
    });
    setTimeout(renderSummary, 300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
