/* ============================================================================
   Mystery Bakebite · Official Branded Receipt & Booking Statement
   Renders an authentic, print-ready Mystery Bakebite document from the live
   order or class booking payload. Enforces role-based authorization when
   opened in administrator mode (?admin=1).
   ========================================================================== */
(function () {
  'use strict';

  var MB = window.MB;
  var params = new URLSearchParams(window.location.search);
  var ref = (params.get('ref') || '').trim().toUpperCase();
  var token = (params.get('token') || '').trim();
  var isAdminView = params.get('admin') === '1';

  var el = {
    state: document.getElementById('receipt-state'),
    paper: document.getElementById('receipt-paper'),
    kind: document.getElementById('receipt-kind'),
    ref: document.getElementById('receipt-ref'),
    stamps: document.getElementById('receipt-stamps'),
    meta: document.getElementById('receipt-meta'),
    itemsTitle: document.getElementById('receipt-items-title'),
    itemsCount: document.getElementById('receipt-items-count'),
    items: document.getElementById('receipt-items'),
    totals: document.getElementById('receipt-totals'),
    pay: document.getElementById('receipt-pay'),
    contact: document.getElementById('receipt-foot-contact'),
    note: document.getElementById('receipt-foot-note'),
    print: document.getElementById('receipt-print'),
    back: document.getElementById('receipt-back')
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function money(p) {
    if (typeof p !== 'number' || !isFinite(p)) return 'On request';
    var val = p / 100;
    var neg = val < 0;
    var fixed = Math.abs(val).toFixed(2);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '\u2212 ' : '') + 'GH\u20B5 ' + parts.join('.');
  }

  function dateText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) +
      ' at ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  var PAY_META = {
    awaiting_payment: {
      short: 'Payment Pending',
      stamp: 'pending',
      banner: 'pending',
      desc: 'Payment pending: no payment has been verified yet. Please complete payment using the reference on this receipt.'
    },
    payment_submitted: {
      short: 'Under Review',
      stamp: 'review',
      banner: 'review',
      desc: 'Payment submitted: your transaction details were received and the baker is verifying the funds.'
    },
    payment_verified: {
      short: 'Payment Verified',
      stamp: 'verified',
      banner: 'verified',
      desc: 'Payment verified: the baker has confirmed receipt of funds for this transaction.'
    },
    payment_rejected: {
      short: 'Not Verified',
      stamp: 'rejected',
      banner: 'rejected',
      desc: 'The last payment proof could not be verified. Please submit updated payment details on your order page.'
    },
    pay_on_collection: {
      short: 'Pay on Handover',
      stamp: 'pending',
      banner: 'pending',
      desc: 'Pay in cash upon collection, delivery, or first session. No advance payment has been collected yet.'
    },
    not_required: {
      short: 'No Payment Required',
      stamp: 'neutral',
      banner: 'pending',
      desc: 'No advance payment is required for this item.'
    }
  };

  var ORD_META = {
    submitted: { label: 'Submitted', stamp: 'pending' },
    confirmed: { label: 'Confirmed', stamp: 'review' },
    in_preparation: { label: 'In Preparation', stamp: 'review' },
    completed: { label: 'Completed', stamp: 'verified' },
    cancelled: { label: 'Cancelled', stamp: 'rejected' }
  };

  function methodName(method, isClass) {
    var m = String(method || '').toLowerCase();
    if (m === 'momo') return 'Mobile Money (MTN MoMo / Telecel Cash)';
    if (m === 'bank_transfer') return 'Bank Transfer';
    if (m === 'cash_on_delivery') return 'Cash on Delivery';
    if (m === 'cash_on_pickup') return isClass ? 'Cash at First Class Session' : 'Cash on Bakery Collection';
    return m ? m.replace(/_/g, ' ') : 'Standard Payment';
  }

  function bundlePct(bundles) {
    var pcts = [];
    (bundles || []).forEach(function (b) {
      var pct = parseInt((b && (b.percent || b.pct)), 10);
      if (pct > 0 && pcts.indexOf(pct) === -1) pcts.push(pct);
    });
    return pcts.map(function (p) { return p + '%'; }).join(' & ');
  }

  function bundleLabel(bundles, isClass) {
    var pct = bundlePct(bundles);
    var prefix = isClass ? 'Class bundle discount' : 'Promotional discount';
    return pct ? prefix + ' (' + pct + ' off)' : prefix;
  }

  function render(order, config, extra) {
    extra = extra || {};
    var isClass = (order.kind || (/^MC-/.test(order.ref) ? 'class' : 'product')) === 'class';
    var payStatus = order.paymentStatus || order.payment_status || 'awaiting_payment';
    var ordStatus = order.orderStatus || order.order_status || 'submitted';
    var payMethod = order.paymentMethod || order.payment_method || 'cash_on_pickup';
    var payInfo = PAY_META[payStatus] || { short: payStatus, stamp: 'neutral', banner: 'pending', desc: payStatus };
    var ordInfo = ORD_META[ordStatus] || { label: ordStatus, stamp: 'neutral' };
    var cust = order.customer || { name: order.customer_name || 'Valued Customer', phone: order.phone || '', email: order.email || '' };

    el.kind.textContent = isClass ? 'Official Booking Receipt' : 'Official Order Receipt';
    el.ref.textContent = order.ref;
    document.title = (isClass ? 'Booking Receipt ' : 'Receipt ') + order.ref + ' | Mystery Bakebite';

    if (el.stamps) {
      el.stamps.innerHTML =
        '<span class="r-stamp r-stamp--' + esc(payInfo.stamp) + '"><span class="r-stamp__dot"></span>' + esc(payInfo.short) + '</span>' +
        '<span class="r-stamp r-stamp--' + esc(ordInfo.stamp) + '">' + esc((isClass ? 'Booking: ' : 'Order: ') + ordInfo.label) + '</span>';
    }

    var fulfilText = isClass
      ? 'In-Person Practical Training · Tamale'
      : (order.fulfilment === 'delivery' ? 'Delivery within Tamale' : 'Bakery Collection · Tamale');

    var eventDateRaw = order.eventDate || order.event_date || '';
    var eventDateFormatted = (window.MB && typeof window.MB.formatOrderDate === 'function' && eventDateRaw)
      ? window.MB.formatOrderDate(eventDateRaw)
      : eventDateRaw;
    var scheduleSubParts = [];
    if (eventDateFormatted) scheduleSubParts.push('Preferred date: ' + esc(eventDateFormatted));
    if (order.address) scheduleSubParts.push('Address: ' + esc(order.address));
    if (!scheduleSubParts.length) {
      scheduleSubParts.push(isClass ? 'Monday – Friday · dates agreed with baker' : 'Tamale, Northern Region, Ghana');
    }

    var metaCards = [
      {
        label: isClass ? 'Student / Issued To' : 'Customer / Billed To',
        value: esc(cust.name || 'Customer'),
        sub: [cust.phone ? esc(cust.phone) : '', cust.email ? esc(cust.email) : ''].filter(Boolean).join(' · ')
      },
      {
        label: 'Date & Time Issued',
        value: esc(dateText(order.createdAt || order.created_at) || 'Recorded'),
        sub: 'Receipt No. ' + esc(order.ref) + ' · Version v' + esc(order.receiptVersion || 1)
      },
      {
        label: isClass ? 'Attendance & Location' : 'Fulfilment & Preferred Date',
        value: esc(fulfilText),
        sub: scheduleSubParts.join(' · ')
      },
      {
        label: 'Payment Method & Status',
        value: esc(methodName(payMethod, isClass)),
        sub: esc(payInfo.short) + (order.paymentRef ? ' · Ref: ' + esc(order.paymentRef) : '')
      }
    ];

    el.meta.innerHTML = metaCards.map(function (c) {
      return '<dl class="paper__pair">' +
        '<dt>' + c.label + '</dt>' +
        '<dd>' + c.value + (c.sub ? '<small>' + c.sub + '</small>' : '') + '</dd>' +
      '</dl>';
    }).join('');

    var itemsList = order.items || [];
    var totalQty = itemsList.reduce(function (sum, it) { return sum + (Number(it.qty) || 1); }, 0);
    if (el.itemsTitle) {
      el.itemsTitle.textContent = isClass ? 'Enrolled Baking School Courses' : 'Purchased Bakery Items & Specifications';
    }
    if (el.itemsCount) {
      el.itemsCount.textContent = itemsList.length + (itemsList.length === 1 ? ' line item' : ' line items') +
        ' (' + totalQty + (totalQty === 1 ? ' unit' : ' units') + ')';
    }

    el.items.innerHTML = itemsList.map(function (i, idx) {
      var numStr = idx < 9 ? '0' + (idx + 1) : String(idx + 1);
      var q = Number(i.qty) || 1;
      var unitP = typeof i.unitPrice === 'number' ? i.unitPrice : null;
      var grossLine = unitP !== null ? unitP * q : null;
      var itemDisc = Number(i.discount) || 0;
      var netLine = typeof i.lineTotal === 'number'
        ? i.lineTotal
        : (grossLine !== null ? Math.max(0, grossLine - itemDisc) : null);
      var discBadge = '';
      if (itemDisc > 0) {
        var pctTxt = i.discountPct ? i.discountPct + '% off · ' : '';
        discBadge = '<span class="paper__item-disc">Saved ' + pctTxt + money(itemDisc) + '</span>';
      }

      var amountCell = netLine !== null
        ? (itemDisc > 0 && grossLine !== null
            ? '<span class="paper__old-line">' + money(grossLine) + '</span><span class="paper__net-line">' + money(netLine) + '</span>'
            : '<span class="paper__net-line">' + money(netLine) + '</span>')
        : 'On request';

      return '<tr>' +
        '<td>' +
          '<div class="paper__item-row">' +
            '<span class="paper__item-idx">' + numStr + '</span>' +
            '<div>' +
              '<span class="paper__item">' + esc(i.name) + '</span>' +
              (i.meta ? '<span class="paper__item-meta">' + esc(i.meta) + '</span>' : '') +
              discBadge +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td><span class="paper__qty-pill">' + esc(q) + '</span></td>' +
        '<td>' + (unitP !== null ? money(unitP) : 'On request') + '</td>' +
        '<td>' + amountCell + '</td>' +
      '</tr>';
    }).join('');

    /* Financial Summary */
    var subtotalVal = typeof order.subtotal === 'number' ? order.subtotal : 0;
    var discountVal = Number(order.discount) || 0;
    var deliveryFeeVal = typeof order.deliveryFee === 'number' ? order.deliveryFee : null;
    var totalVal = typeof order.total === 'number' ? order.total : Math.max(0, subtotalVal - discountVal + (deliveryFeeVal || 0));

    var deliveryRowLabel = isClass
      ? 'Ingredients & Toolkit'
      : (order.fulfilment === 'delivery' ? 'Delivery Charge (Tamale)' : 'Bakery Collection');
    var deliveryRowVal = isClass
      ? 'Included in tuition'
      : (deliveryFeeVal !== null
          ? (deliveryFeeVal === 0 ? 'Complimentary' : money(deliveryFeeVal))
          : (order.fulfilment === 'delivery' ? 'Confirmed by baker' : 'GH\u20B5 0.00 (Pickup)'));

    var isPaid = payStatus === 'payment_verified';
    var rows = '<h2 class="paper__h2" style="margin-bottom:.55rem">Financial Summary</h2>';
    rows += '<div class="paper__row"><span>Subtotal</span><span>' + money(subtotalVal) + '</span></div>';
    if (discountVal > 0) {
      rows += '<div class="paper__row paper__row--cut"><span>' + esc(bundleLabel(order.bundles, isClass)) +
        '</span><span>\u2212 ' + money(discountVal) + '</span></div>';
    } else {
      rows += '<div class="paper__row"><span>Discounts applied</span><span>GH\u20B5 0.00</span></div>';
    }
    rows += '<div class="paper__row paper__row--delivery"><span>' + esc(deliveryRowLabel) + '</span><span>' + esc(deliveryRowVal) + '</span></div>';
    rows += '<div class="paper__row paper__row--total"><span>Total Amount</span><span>' + money(totalVal) + '</span></div>';
    rows += '<div class="paper__row paper__row--balance">' +
      '<span>' + (isPaid ? 'Amount Verified Paid' : 'Balance Status') + '</span>' +
      '<span>' + (isPaid ? money(totalVal) + ' (Paid in Full)' : money(totalVal) + ' (' + esc(payInfo.short) + ')') + '</span>' +
    '</div>';
    el.totals.innerHTML = rows;

    /* Payment & Verification Section */
    var bannerIcon = isPaid
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>';

    var payHtml = '<h2 class="paper__h2">Payment &amp; Verification Record</h2>';
    payHtml += '<div class="paper__pay-banner paper__pay-banner--' + esc(payInfo.banner) + '">' +
      bannerIcon +
      '<div>' + esc(payInfo.desc) + '</div>' +
    '</div>';

    payHtml += '<div class="paper__pay-grid">' +
      '<div class="paper__pay-kv"><span>Payment Method</span><b>' + esc(methodName(payMethod, isClass)) + '</b></div>' +
      '<div class="paper__pay-kv"><span>Verification Status</span><b>' + esc(payInfo.short) + '</b></div>' +
      '<div class="paper__pay-kv"><span>Transaction Reference</span><b class="mono">' + esc(order.paymentRef || 'Not yet recorded') + '</b></div>' +
      '<div class="paper__pay-kv"><span>Verified Timestamp</span><b>' + esc(order.verifiedAt ? dateText(order.verifiedAt) : (isPaid ? 'Verified by Baker' : 'Pending baker verification')) + '</b></div>' +
    '</div>';

    var cfg = config || {};
    var momo = extra.momo || cfg.momo || cfg.momo_details || null;
    var bank = extra.bank || cfg.bank || cfg.bank_details || null;
    if (!isPaid && payMethod === 'momo' && momo && momo.number) {
      payHtml += '<div class="paper__remit">' +
        '<strong>Mobile Money Remittance Details:</strong> Send <strong>' + money(totalVal) + '</strong> to ' +
        '<strong>' + esc(momo.number) + '</strong> (' + esc(momo.name || 'Mystery Bakebite') +
        (momo.provider ? ' · ' + esc(momo.provider) : '') + ') using reference <strong class="mono">' + esc(order.ref) + '</strong>.' +
      '</div>';
    } else if (!isPaid && payMethod === 'bank_transfer' && bank && bank.accountNumber) {
      payHtml += '<div class="paper__remit">' +
        '<strong>Bank Transfer Remittance Details:</strong> Transfer <strong>' + money(totalVal) + '</strong> to ' +
        '<strong>' + esc(bank.name) + '</strong> · Account <strong>' + esc(bank.accountNumber) + '</strong> (' +
        esc(bank.accountName || 'Mystery Bakebite') + ') using reference <strong class="mono">' + esc(order.ref) + '</strong>.' +
      '</div>';
    }

    if (order.notes) {
      payHtml += '<p class="paper__line"><strong>Customer notes:</strong> ' + esc(order.notes) + '</p>';
    }
    if (isClass) {
      payHtml += '<p class="paper__line">Class seats are confirmed once the baker verifies payment and agrees your training week.</p>';
    }
    el.pay.innerHTML = payHtml;

    var contactParts = [
      '+233 55 452 0532',
      'mysterybakebites@gmail.com',
      '@mysterybakebites'
    ];
    if (cfg.email && contactParts.indexOf(cfg.email) === -1) contactParts.push(esc(cfg.email));
    el.contact.innerHTML = contactParts.join(' &middot; ');
    el.note.textContent = 'Keep reference ' + order.ref + ' safe. Thank you for choosing Mystery Bakebite!';

    if (el.paper && el.paper.classList) {
      if (itemsList.length > 3) {
        el.paper.classList.add('paper--compact');
      } else {
        el.paper.classList.remove('paper--compact');
      }
    }
  }

  var currentOrder = null;
  var currentConfig = null;
  var currentExtra = null;

  function fail(message, redirectUrl) {
    el.state.hidden = false;
    el.paper.hidden = true;
    el.state.className = 'receipt__state alert alert--error';
    el.state.textContent = message;
    if (redirectUrl) {
      setTimeout(function () {
        window.location.replace(redirectUrl);
      }, 1400);
    }
  }

  function triggerOrderReceiptDownload() {
    if (!currentOrder) return false;
    if (currentOrder.kind === 'class' || /^MC-/i.test(String(currentOrder.ref || ''))) return false;
    if (MB && typeof MB.downloadReceiptPdf === 'function') {
      MB.downloadReceiptPdf(currentOrder, currentConfig || {}, currentExtra || {});
      return true;
    }
    return false;
  }

  function loadReceiptData() {
    if (/^MC-/i.test(ref)) {
      fail('Receipts are strictly available for product orders only.');
      return;
    }
    var orderCall = isAdminView
      ? MB.api('/api/admin/orders/' + encodeURIComponent(ref))
      : MB.api('/api/orders/' + encodeURIComponent(ref) + '?token=' + encodeURIComponent(token));

    Promise.all([orderCall, MB.api('/api/config')]).then(function (out) {
      var res = out[0];
      var cfg = out[1] && out[1].config ? out[1].config : null;
      if (!res || !res.ok) {
        if (res && (res.code === 'unauthorised' || res.auth)) {
          fail('Unauthorised: administrator sign-in is required to view admin receipts. Redirecting to login…', 'admin.html');
        } else if (res && res.code === 'token') {
          fail('That receipt link is missing or has an invalid security code. Open the receipt from your order page.');
        } else if (res && res.code === 'not_found') {
          fail('We could not find an order with reference ' + ref + '.');
        } else {
          fail((res && res.error) || 'The receipt could not be loaded.');
        }
        return;
      }
      if (!res.order || res.order.kind === 'class' || /^MC-/i.test(String(res.order.ref || ''))) {
        fail('Receipts are strictly available for product orders only.');
        return;
      }
      currentOrder = res.order;
      currentConfig = cfg;
      currentExtra = { momo: res.momo, bank: res.bank };
      el.state.hidden = true;
      el.paper.hidden = false;
      render(res.order, cfg, currentExtra);
      /* Automatically download the order receipt PDF directly to the user's device */
      triggerOrderReceiptDownload();
    }).catch(function () {
      fail('The receipt could not be loaded. Check your connection and try again.');
    });
  }

  function load() {
    if (!ref && !isAdminView) {
      try {
        var lastRaw = localStorage.getItem('mb-last-order-v1');
        if (lastRaw) {
          var lastObj = JSON.parse(lastRaw);
          if (lastObj && lastObj.ref && lastObj.token && /^MB-/i.test(String(lastObj.ref).trim())) {
            ref = String(lastObj.ref).trim().toUpperCase();
            token = String(lastObj.token).trim();
          }
        }
      } catch (_) {}
    }
    if (!ref) {
      fail('No order reference was provided. Open your receipt from the Track Order page using your order reference and phone number.');
      return;
    }
    if (/^MC-/i.test(ref)) {
      fail('Receipts are strictly available for product orders only.');
      return;
    }
    if (isAdminView) {
      /* Enforce role-based access control on ?admin=1 receipt URLs */
      if (!MB || typeof MB.verifyAdminSession !== 'function') {
        fail('Unauthorised access. Redirecting to login…', 'admin.html');
        return;
      }
      MB.verifyAdminSession().then(function (auth) {
        if (!auth || !auth.isAdmin) {
          if (auth && auth.signedIn && !auth.isAdmin) {
            fail('Access denied: administrator privileges are required. Redirecting to the storefront…', 'index.html');
          } else {
            fail('Please sign in as an administrator to view this receipt. Redirecting to login…', 'admin.html');
          }
          return;
        }
        loadReceiptData();
      });
      return;
    }
    if (!token) {
      fail('This link is missing its security code. Open the receipt from your order page, or find your order with its reference and phone number.');
      return;
    }
    loadReceiptData();
  }

  if (el.print) {
    el.print.addEventListener('click', function () {
      triggerOrderReceiptDownload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
