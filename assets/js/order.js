/* ============================================================
   Mystery Bakebite: customer status page
   One page serves both transaction types but never blurs them:
   a product order (MB-) reads as an order, a class booking (MC-)
   reads as a booking, with the wording, steps and receipt that
   belong to that type.
   ============================================================ */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var ref = (params.get('ref') || '').trim().toUpperCase();
  var token = (params.get('token') || '').trim();

  var el = {};
  var state = { order: null, config: null, events: [], momo: null, bank: null, kind: 'product' };

  /* the two transaction types, in words */
  var WORDS = {
    product: {
      noun: 'order', Noun: 'Order', REF: 'Order reference',
      items: 'Your items', submitted: 'Order submitted',
      paymentPending: 'Unpaid orders are printed as <strong>Payment Pending</strong> on the receipt.',
      confirm: 'Baker confirms', made: 'Prepared',
      madeSub: 'The order is made and prepared for handover.',
      done: 'Completed', doneSub: 'Collected or delivered.',
      talk: 'about order '
    },
    class: {
      noun: 'booking', Noun: 'Booking', REF: 'Booking reference',
      items: 'Your classes', submitted: 'Booking submitted',
      paymentPending: 'Unpaid bookings are printed as <strong>Payment Pending</strong> on the booking receipt.',
      confirm: 'Baker confirms dates', made: 'Place reserved',
      madeSub: 'Your place is held for the weeks agreed with the baker.',
      done: 'Classes attended', doneSub: 'The course is finished.',
      talk: 'about booking '
    }
  };

  function words() {
    return WORDS[state.kind] || WORDS.product;
  }

  var PAY_LABEL = {
    awaiting_payment: ['Awaiting payment', 'amber', 'Payment has not been received yet.'],
    payment_submitted: ['Payment under review', 'blue',
      'Your payment details were received and are being checked against the funds.'],
    payment_verified: ['Payment confirmed', 'green', 'The baker has verified that the payment was received.'],
    payment_rejected: ['Payment not verified', 'red', 'The details could not be matched. Please submit them again.'],
    pay_on_collection: ['Pay in person', 'grey', 'Nothing has been paid in advance.'],
    not_required: ['No payment required', 'grey', '']
  };

  var ORDER_LABEL = {
    submitted: ['Submitted', 'amber', 'Waiting for the baker to review the order.'],
    confirmed: ['Confirmed', 'blue', 'The baker has accepted the order.'],
    in_preparation: ['In preparation', 'blue', 'Your order is being made.'],
    completed: ['Completed', 'green', 'The order has been fulfilled.'],
    cancelled: ['Cancelled', 'red', '']
  };

  function money(p) {
    if (typeof p !== 'number' || !isFinite(p)) return 'On request';
    var val = p / 100;
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

  function badge(map, key) {
    var m = map[key] || [key, 'grey', ''];
    return '<span class="badge badge--' + m[1] + '">' + esc(m[0]) + '</span>';
  }

  function alertBox(kind, msg) {
    el.alert.hidden = false;
    el.alert.innerHTML = '<div class="alert alert--' + kind + '"><svg viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
      '<path d="M12 11v5M12 8h.01"/></svg><span>' + msg + '</span></div>';
  }

  function receiptUrl() {
    return window.MB.receiptUrl(ref, token);
  }

  /* Strictly for product orders only: downloads the A6 PDF receipt directly to the user's device */
  function download() {
    if (state.kind === 'class' || (state.order && state.order.kind === 'class')) return false;
    if (window.MB && typeof window.MB.downloadReceiptPdf === 'function' && state.order) {
      window.MB.downloadReceiptPdf(state.order, state.config || {}, { momo: state.momo, bank: state.bank });
      return true;
    }
    return false;
  }

  /* the percentage this order actually received, not today's setting */
  function discountLabel(o) {
    var pct = window.mbBundlePct ? window.mbBundlePct(o.bundles) : '';
    if (o.kind === 'class') return pct ? 'Class bundle discount (' + pct + ')' : 'Class bundle discount';
    return pct ? 'Discount (' + pct + ')' : 'Discount';
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

  function render() {
    var o = state.order;
    if (!o || !o.ref) return;
    var W = words();
    var pay = PAY_LABEL[o.paymentStatus] || [o.paymentStatus, 'grey', ''];
    var ord = ORDER_LABEL[o.orderStatus] || [o.orderStatus, 'grey', ''];
    var isCash = !!window.MBPay.cashMethods[o.paymentMethod];
    var showPaymentSection = o.orderStatus !== 'cancelled';
    var momo = state.momo;
    var prefDate = o.eventDate || o.event_date || '';
    var prefDateText = prefDate ? formatOrderDate(prefDate) : '';
    var firstName = ((o.customer && o.customer.name) ? o.customer.name : 'Friend').split(/\s+/)[0];

    var items = o.items.map(function (i) {
      var line = typeof i.unitPrice === 'number' ? i.unitPrice * i.qty : null;
      var prepDays = Number(i.prepDays) > 0 ? Math.round(Number(i.prepDays)) : 0;
      var prepTag = prepDays > 0
        ? '<br><span class="prep-badge prep-badge--sm">Order at least ' + prepDays + ' ' + (prepDays === 1 ? 'day' : 'days') + ' ahead</span>'
        : '';
      return '<div class="summary-line">' +
        '<span><span class="summary-line__name">' + esc(i.name) + (i.qty > 1 ? ' &times; ' + i.qty : '') + '</span>' +
        (i.meta ? '<span class="summary-line__meta">' + esc(i.meta) + '</span>' : '') + prepTag + '</span>' +
        '<span class="summary-line__amt">' + (line === null ? 'On request' : money(line)) +
        (i.discount ? '<span class="summary-line__cut">\u2212 ' + money(i.discount) + '</span>' : '') +
        '</span></div>';
    }).join('');

    var thankYouHeader = o.orderStatus !== 'cancelled'
      ? '<div class="thankyou-card__hero" style="margin-bottom:1.1rem;padding-bottom:1.1rem;border-bottom:1px solid var(--line-dark)">' +
          '<div class="thankyou-card__Seal">' +
            '<img src="assets/img/thank-you.webp" width="124" height="124" alt="Mystery Bakebite — Thank You for supporting my small business. Baked with love, especially for you!">' +
          '</div>' +
          '<div class="thankyou-card__copy">' +
            '<p class="eyebrow" style="margin-bottom:.25rem">Thank you, ' + esc(firstName) + ' &middot; ' + W.REF + '</p>' +
            '<h2 class="mono" style="font-size:clamp(1.3rem,2.6vw,1.7rem);letter-spacing:.02em;margin-bottom:.35rem">' + esc(o.ref) + '</h2>' +
            '<p style="color:rgba(245,230,214,.74);font-size:var(--s-1);margin-bottom:.55rem">' +
              'Baked with love, especially for you.' +
              (prefDateText ? ' Preferred order date: <strong style="color:var(--caramel)">' + esc(prefDateText) + '</strong>.' : '') +
            '</p>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' + badge(PAY_LABEL, o.paymentStatus) + badge(ORDER_LABEL, o.orderStatus) + '</div>' +
          '</div>' +
        '</div>'
      : '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">' +
          '<div>' +
            '<p class="eyebrow" style="margin-bottom:.3rem">' + W.REF + '</p>' +
            '<h2 class="mono" style="font-size:clamp(1.3rem,2.6vw,1.7rem);letter-spacing:.02em">' + esc(o.ref) + '</h2>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' + badge(PAY_LABEL, o.paymentStatus) + badge(ORDER_LABEL, o.orderStatus) + '</div>' +
        '</div>';

    el.view.hidden = false;
    el.view.innerHTML = '' +
      '<div class="checkout" style="align-items:start">' +
        '<div>' +
          '<div class="panel thankyou-card">' +
            thankYouHeader +
            '<p class="panel__hint" style="margin:.4rem 0 0">Placed ' + esc(o.createdAt.replace('T', ' ').replace('Z', ' UTC')) +
              ' &middot; ' + esc(o.customer.name) + ' &middot; ' + esc(o.customer.phone) +
              (prefDateText ? ' &middot; Preferred date: <strong style="color:var(--caramel)">' + esc(prefDateText) + '</strong>' : '') +
            '</p>' +
            '<p style="font-size:var(--s-2);line-height:1.65;color:rgba(245,230,214,.72);margin-top:.8rem">' +
              esc(pay[2] || ord[2] || '') + '</p>' +
            (o.paymentStatus === 'payment_rejected' && o.rejectReason
              ? '<div class="alert alert--error" style="margin-top:1rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span>The baker could not verify your last proof: <strong>' + esc(o.rejectReason) + '</strong></span></div>'
              : '') +
            '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:1.2rem">' +
              (state.kind !== 'class' && o.kind !== 'class'
                ? '<button type="button" class="btn btn--gold" id="dl-receipt">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>' +
                    'Download order receipt (PDF)</button>'
                : '') +
              '<a class="btn btn--glass" href="' + esc(whatsappLink(o)) + '" target="_blank" rel="noopener">Message the kitchen</a>' +
            '</div>' +
            (state.kind !== 'class' && o.kind !== 'class'
              ? '<p class="form-note">' + W.paymentPending + ' Your order receipt PDF downloads automatically to your device and updates once the baker verifies the money.</p>'
              : '') +
          '</div>' +

          (showPaymentSection ? proofPanel(o) : '') +

          '<div class="panel">' +
            '<h2>What happens next</h2>' +
            '<div class="steps">' +
              renderNextSteps(o, W, isCash) +
            '</div>' +
          '</div>' +
        '</div>' +

        '<aside class="panel">' +
          '<h2>' + W.items + '</h2>' +
          items +
          '<div class="booking__rows" style="margin-top:1rem">' +
            (prefDateText
              ? '<div class="brow"><span>Preferred order date</span><b style="color:var(--caramel)">' + esc(prefDateText) + '</b></div>'
              : '') +
            '<div class="brow"><span>Subtotal</span><b>' + money(o.subtotal) + '</b></div>' +
            (o.discount
              ? '<div class="brow brow--save"><span>' + discountLabel(o) +
                '</span><b>\u2212 ' + money(o.discount) + '</b></div>'
              : '') +
            '<div class="brow brow--total"><span>Total</span><b>' + money(o.total) + '</b></div>' +
          '</div>' +
          '<div style="margin-top:1.1rem;display:flex;flex-direction:column;gap:.55rem;font-size:var(--s-2);color:rgba(245,230,214,.72)">' +
            (prefDateText
              ? '<div style="display:flex;justify-content:space-between;gap:10px"><span>Preferred date</span><b style="color:var(--caramel)">' + esc(prefDateText) + '</b></div>'
              : '') +
            '<div style="display:flex;justify-content:space-between;gap:10px"><span>Payment method</span><b style="color:var(--cream)">' +
              esc(o.paymentMethod === 'momo' ? 'Mobile Money'
                : o.paymentMethod === 'bank_transfer' ? 'Bank transfer'
                : o.paymentMethod === 'cash_on_delivery' ? 'Cash on delivery'
                : (state.kind === 'class' ? 'Cash at first session' : 'Cash on pickup')) + '</b></div>' +
            '<div style="display:flex;justify-content:space-between;gap:10px"><span>' +
              (state.kind === 'class' ? 'Attendance' : 'Fulfilment') + '</span><b style="color:var(--cream)">' +
              esc(state.kind === 'class'
                ? 'In person, Tamale'
                : (o.fulfilment === 'delivery' ? 'Delivery within Tamale' : 'Collection')) + '</b></div>' +
          '</div>' +
          (o.paymentRef ? '<p class="form-note">Payment reference on file: <span class="mono">' + esc(o.paymentRef) + '</span></p>' : '') +
          (o.notes ? '<p class="form-note">Your note: ' + esc(o.notes) + '</p>' : '') +
        '</aside>' +
      '</div>';

    var dlReceiptBtn = el.view.querySelector('#dl-receipt');
    if (dlReceiptBtn && dlReceiptBtn.addEventListener) {
      dlReceiptBtn.addEventListener('click', download);
    }
    if (!state.autoDownloadedReceipt && state.kind !== 'class' && o.kind !== 'class') {
      state.autoDownloadedReceipt = true;
      download();
    }
    bindUpload();
    maybeVerifiedPopup(o);
    if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function step(n, title, sub, done, isNow) {
    var cls = 'step-row' + (done ? ' is-done' : (isNow ? ' is-now' : ''));
    return '<div class="' + cls + '">' +
      '<span class="step-dot" aria-hidden="true">' +
        (done
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
          : '<span class="step-dot__num">' + n + '</span>') +
      '</span>' +
      '<div class="step-row__body"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></div></div>';
  }

  function renderNextSteps(o, W, isCash) {
    var s2Title = !isCash ? 'Payment' : (o.paymentMethod === 'cash_on_delivery' ? 'Pay on delivery' : 'Pay on collection');
    var s2Sub = o.paymentStatus === 'payment_verified'
      ? 'Payment verified by the baker.'
      : (o.paymentStatus === 'payment_submitted'
          ? 'Proof received, waiting to be checked.'
          : (!isCash
              ? 'Send the amount, then upload the screenshot or reference.'
              : (o.paymentMethod === 'cash_on_delivery' ? 'Have the amount ready upon delivery.' : 'Bring payment when you collect.')));

    var list = [
      { n: 1, title: W.submitted, sub: 'The kitchen has your ' + W.noun + ' and reference.', done: true },
      { n: 2, title: s2Title, sub: s2Sub, done: o.paymentStatus === 'payment_verified' },
      { n: 3, title: W.confirm, sub: 'The baker confirms the ' + W.noun + ' after the payment check.', done: o.orderStatus !== 'submitted' && o.orderStatus !== 'cancelled' },
      { n: 4, title: W.made, sub: W.madeSub, done: ['in_preparation', 'completed'].indexOf(o.orderStatus) !== -1 },
      { n: 5, title: W.done, sub: W.doneSub, done: o.orderStatus === 'completed' }
    ];

    var foundNow = false;
    return list.map(function (it) {
      var isNow = false;
      if (!it.done && !foundNow && o.orderStatus !== 'cancelled') {
        isNow = true;
        foundNow = true;
      }
      return step(it.n, it.title, it.sub, it.done, isNow);
    }).join('');
  }

  function methodDetails(o) {
    var momo = state.momo;
    var bank = state.bank;

    if (o.paymentMethod === 'momo') {
      if (!momo) {
        return '<div class="alert alert--warn" style="margin-bottom:1rem">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
          '<span>Verified Mobile Money details are not published yet. Message the kitchen and the baker will confirm how to pay.</span></div>';
      }
      return '<div class="pay-card" style="margin-bottom:1rem">' +
        window.MBPay.detailRow('Recipient name', momo.name) +
        window.MBPay.detailRow('Mobile Money number', momo.number, true) +
        (momo.provider ? window.MBPay.detailRow('Network', momo.provider) : '') +
        window.MBPay.detailRow('Amount due', money(o.total), false, true) +
        window.MBPay.detailRow('Reference', o.ref, true) +
        '</div>';
    }

    if (o.paymentMethod === 'bank_transfer') {
      if (!bank) {
        return '<div class="alert alert--warn" style="margin-bottom:1rem">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
          '<span>Verified bank details are not published yet. Message the kitchen and the baker will confirm how to pay.</span></div>';
      }
      return '<div class="pay-card" style="margin-bottom:1rem">' +
        window.MBPay.detailRow('Bank', bank.name) +
        window.MBPay.detailRow('Account name', bank.accountName) +
        window.MBPay.detailRow('Account number', bank.accountNumber, true) +
        window.MBPay.detailRow('Amount due', money(o.total), false, true) +
        window.MBPay.detailRow('Reference', o.ref, true) +
        '</div>';
    }

    return '<div class="alert alert--info" style="margin-bottom:1rem">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
      '<span>' + (o.paymentMethod === 'cash_on_delivery'
        ? 'This order is paid in cash on delivery. The baker or delivery person records the payment when the cash is received.'
        : (state.kind === 'class'
            ? 'This booking is paid in cash at your first session. The baker records the payment when the cash is received.'
            : 'This order is paid in cash on collection. The baker records the payment when the cash is received.')) +
      '</span></div>';
  }

  function formatFileSize(bytes) {
    if (!bytes || !isFinite(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function proofPanel(o) {
    var cash = window.MBPay.cashMethods[o.paymentMethod];

    if (cash) {
      return '<div class="panel" id="proof-panel">' +
        '<h2>Payment</h2>' +
        '<p class="panel__hint">Paying in cash needs no proof. The baker records the payment in the dashboard once ' +
        'the cash changes hands.</p>' +
        methodDetails(o) +
        '</div>';
    }

    if (o.paymentStatus === 'payment_verified') {
      return '<div class="panel" id="proof-panel" data-proof-state="verified">' +
        '<h2>Payment Verified</h2>' +
        '<div class="alert alert--info" style="margin-top:.6rem">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
          '<span><strong>Payment confirmed by the baker.</strong> Your payment details have been verified and recorded on your official receipt. No further payment submission is needed.</span>' +
        '</div>' +
        '<div class="pay-card" style="margin-top:1rem">' +
          window.MBPay.detailRow('Verification status', 'Payment Verified & Confirmed') +
          (o.paymentRef ? window.MBPay.detailRow('Transaction reference', o.paymentRef, true) : '') +
          (o.verifiedAt ? window.MBPay.detailRow('Verified at', o.verifiedAt.replace('T', ' ').slice(0, 16) + ' UTC') : '') +
        '</div>' +
      '</div>';
    }

    if (o.paymentStatus === 'payment_submitted' || (o.proofLocked && o.paymentStatus !== 'payment_rejected')) {
      var subTime = (o.proofSubmittedAt || o.createdAt || '').replace('T', ' ').slice(0, 16);
      return '<div class="panel" id="proof-panel" data-proof-state="locked">' +
        '<h2>Payment Details Received</h2>' +
        '<div class="alert alert--info" id="proof-submitted-banner" style="margin-top:.6rem">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
          '<span><strong>Your payment details have been received and are under review.</strong> ' +
          esc(window.MBPay.submittedMessage()) + '</span>' +
        '</div>' +
        '<div class="pay-card" style="margin-top:1rem">' +
          window.MBPay.detailRow('Submission status', 'Received — Pending Baker Verification') +
          window.MBPay.detailRow('Transaction reference', o.paymentRef || 'Screenshot submitted', !!o.paymentRef) +
          window.MBPay.detailRow('Payment screenshot', o.hasProof ? 'Uploaded & attached on file' : 'Not attached (reference only)') +
          (subTime ? window.MBPay.detailRow('Submitted at', subTime + ' UTC') : '') +
        '</div>' +
        '<p class="form-note" style="margin-top:.9rem">' +
          'To protect your ' + words().noun + ' against duplicate records, the payment submission form is now locked. ' +
          'Submitting a reference or screenshot does not automatically mark the ' + words().noun + ' as paid — the baker will verify the funds and update your receipt. ' +
          'If a correction is ever needed, the baker can unlock resubmission from the dashboard.' +
        '</p>' +
      '</div>';
    }

    if (o.orderStatus === 'completed' || o.orderStatus === 'cancelled') {
      return '';
    }

    return '<div class="panel" id="proof-panel" data-proof-state="open">' +
      '<h2>' + (o.paymentStatus === 'payment_rejected' ? 'Resubmit corrected payment details' : 'Submit your payment details') + '</h2>' +
      '<p class="panel__hint">Send the money first, then add the transaction reference, a screenshot, or both. ' +
      'This puts the payment under review. It does not confirm the payment: the baker checks the funds and ' +
      'confirms it.</p>' +
      methodDetails(o) +
      '<div class="field">' +
        '<label for="proof-ref">Transaction reference or ID</label>' +
        '<input type="text" id="proof-ref" maxlength="80" value="" ' +
          'placeholder="e.g. the reference in your Mobile Money or bank message" autocomplete="off">' +
      '</div>' +
      '<div class="field upload-field">' +
        '<span class="upload-field__label">Payment confirmation screenshot <small>(optional)</small></span>' +
        '<label class="upload" id="upload-zone" for="proof-file">' +
          '<input type="file" id="proof-file" accept="image/png,image/jpeg,image/webp">' +
          '<span class="upload__icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0L8 8m4-4l4 4"/><path d="M4 16v2.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V16"/></svg>' +
          '</span>' +
          '<span class="upload__text">' +
            '<b id="upload-title">Add a payment screenshot (optional)</b>' +
            '<span id="upload-sub">PNG, JPEG or WebP &middot; up to 5 MB &middot; click or drag &amp; drop</span>' +
          '</span>' +
          '<span class="upload__cta">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
            '<span id="upload-cta-txt">Choose screenshot</span>' +
          '</span>' +
        '</label>' +
        '<div class="upload__meta" id="proof-file-meta" hidden>' +
          '<div class="upload__meta-info">' +
            '<span class="upload__meta-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>' +
            '<div class="upload__meta-text">' +
              '<span class="upload__filename" id="proof-file-name"></span>' +
              '<span class="upload__filesize" id="proof-file-size"></span>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="upload__remove" id="proof-file-clear" aria-label="Remove selected screenshot">Remove</button>' +
        '</div>' +
        '<div class="upload__preview-wrap" id="proof-preview-wrap" hidden>' +
          '<img class="upload__preview" id="proof-preview" alt="Preview of the screenshot you selected">' +
        '</div>' +
        '<div class="upload__msg" id="proof-file-msg" role="status" aria-live="polite" hidden></div>' +
      '</div>' +
      '<div class="field">' +
        '<label for="proof-note">Optional note</label>' +
        '<input type="text" id="proof-note" maxlength="200" placeholder="e.g. paid from 055****532 at 2:15pm">' +
      '</div>' +
      '<button type="button" class="btn btn--gold" id="proof-send" style="width:100%;justify-content:center">Submit payment details</button>' +
      '<p class="form-note">Your payment stays under review until the baker verifies the funds. A reference or ' +
      'screenshot on its own never marks a ' + words().noun + ' as paid.</p>' +
    '</div>';
  }

  function bindUpload() {
    var input = document.getElementById('proof-file');
    var zone = document.getElementById('upload-zone');
    var send = document.getElementById('proof-send');
    var preview = document.getElementById('proof-preview');
    var previewWrap = document.getElementById('proof-preview-wrap');
    var metaBox = document.getElementById('proof-file-meta');
    var metaName = document.getElementById('proof-file-name');
    var metaSize = document.getElementById('proof-file-size');
    var clearBtn = document.getElementById('proof-file-clear');
    var msgBox = document.getElementById('proof-file-msg');
    var ctaTxt = document.getElementById('upload-cta-txt');
    var titleTxt = document.getElementById('upload-title');
    if (!send) return;
    var file = null;
    var verifiedDataUrl = '';
    var isSubmitting = false;

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
      if (input) input.value = '';
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
          if (metaName) metaName.textContent = f.name || 'payment-screenshot.' + (v.ext || 'jpg');
          if (metaSize) metaSize.textContent = formatFileSize(f.size);
          if (metaBox) metaBox.hidden = false;
          if (ctaTxt) ctaTxt.textContent = 'Change screenshot';
          if (titleTxt) titleTxt.textContent = 'Screenshot attached & verified';
          setUploadMsg('ok', 'Screenshot verified (' + (f.name || 'image') + ', ' + formatFileSize(f.size) + '). Click "Submit payment details" below to send.');
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
      setUploadMsg('ok', 'Screenshot selected (' + (f.name || 'image') + ', ' + formatFileSize(f.size) + '). Click "Submit payment details" below to send.');

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

    if (clearBtn) {
      clearBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!isSubmitting) clearFile();
      });
    }

    if (input) {
      input.addEventListener('change', function () { pick(input.files[0]); });
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

    send.addEventListener('click', function () {
      if (isSubmitting) return;
      if (state.order && (state.order.paymentStatus === 'payment_submitted' || state.order.paymentStatus === 'payment_verified')) {
        render();
        return;
      }
      var refEl = document.getElementById('proof-ref');
      var noteEl = document.getElementById('proof-note');
      var refValue = (refEl && refEl.value || '').trim();
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
      if (input) input.disabled = true;
      if (refEl) refEl.disabled = true;
      if (noteEl) noteEl.disabled = true;

      var sendIt = function (imageDataUrl) {
        MB.api('/api/orders/' + encodeURIComponent(ref) + '/proof?token=' + encodeURIComponent(token), {
          method: 'POST',
          body: {
            image: imageDataUrl || '',
            reference: refValue,
            note: (noteEl && noteEl.value || '').slice(0, 200)
          }
        }).then(function (d) {
          if (!d || !d.ok) {
            isSubmitting = false;
            if (d && (d.code === 'duplicate_submission' || d.code === 'already_verified')) {
              alertBox('info', esc(d.error));
              load();
              return;
            }
            send.disabled = false;
            send.textContent = 'Submit payment details';
            if (input) input.disabled = false;
            if (refEl) refEl.disabled = false;
            if (noteEl) noteEl.disabled = false;
            setUploadMsg('error', (d && d.error) || 'The payment details could not be submitted.');
            return alertBox('error', esc((d && d.error) || 'The payment details could not be submitted.'));
          }

          if (d.order) {
            state.order = d.order;
          }
          render();
          payModal('Payment Details Received',
            '<p class="pay-lead">' + esc(window.MBPay.submittedMessage()) + '</p>',
            '<button type="button" class="btn btn--gold" data-modal-close>Understood</button>');
        }).catch(function () {
          isSubmitting = false;
          send.disabled = false;
          send.textContent = 'Submit payment details';
          if (input) input.disabled = false;
          if (refEl) refEl.disabled = false;
          if (noteEl) noteEl.disabled = false;
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

  /* a plain modal on this page, for the payment messages */
  function payModal(title, body, actions) {
    var host = document.getElementById('order-modal');
    if (!host) return;
    document.getElementById('order-modal-body').innerHTML =
      '<h2 id="order-modal-title">' + esc(title) + '</h2>' +
      '<div class="pay-modal__body">' + body + '</div>' +
      (actions ? '<div class="pay-modal__actions">' + actions + '</div>' : '');
    host.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  /* Payment Confirmed is shown only after the baker has verified the funds. */
  function maybeVerifiedPopup(o) {
    if (o.paymentStatus !== 'payment_verified') return;
    var key = 'mb-verified-seen-' + o.ref + '-' + (o.verifiedAt || '');
    var seen = false;
    try { seen = sessionStorage.getItem(key) === '1'; } catch (e) { }
    if (seen) return;
    try { sessionStorage.setItem(key, '1'); } catch (e) { }
    payModal('Payment Confirmed',
      '<p class="pay-lead">' + esc(window.MBPay.verifiedMessage()) + '</p>',
      '<button type="button" class="btn btn--gold" data-modal-close>Continue</button>');
  }

  function whatsappLink(o) {
    var wa = (state.config && state.config.whatsapp) || '233554520532';
    var text = 'Hello Mystery Bakebite, about ' + words().noun + ' ' + o.ref + ' (' + money(o.total) + ').';
    return 'https://wa.me/' + wa + '?text=' + encodeURIComponent(text);
  }

  function load() {
    el.loading.hidden = false;
    el.view.hidden = true;
    MB.api('/api/orders/' + encodeURIComponent(ref) + '?token=' + encodeURIComponent(token))
      .then(function (d) {
        var res = { d: d };
        el.loading.hidden = true;
        if (!res.d.ok) {
          el.lookup.hidden = false;
          if (res.d.code === 'token') alertBox('error', 'That link is not valid. Find your ' + words().noun + ' below using the reference and phone number.');
          else if (res.d.code === 'not_found') el.lookup.hidden = false;
          else alertBox('error', esc(res.d.error || 'The order could not be loaded.'));
          return;
        }
        state.order = res.d.order;
        state.momo = res.d.momo;
        state.bank = res.d.bank;
        state.kind = res.d.kind || res.d.order.kind || (/^MC-/.test(ref) ? 'class' : 'product');
        render();
      })
      .catch(function () {
        el.loading.hidden = true;
        el.lookup.hidden = false;
        alertBox('error', 'We could not load that order. Enter your reference below, or message the kitchen.');
      });
  }

  function init() {
    state.kind = /^MC-/.test(ref) ? 'class' : 'product';

    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-modal-close]')) {
        var host = document.getElementById('order-modal');
        if (host) host.classList.remove('is-open');
        document.body.style.overflow = '';
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var host = document.getElementById('order-modal');
      if (host) host.classList.remove('is-open');
      document.body.style.overflow = '';
    });
    el.alert = document.getElementById('order-alert');
    el.loading = document.getElementById('order-loading');
    el.lookup = document.getElementById('order-lookup');
    el.view = document.getElementById('order-view');

    MB.api('/api/config').then(function (d) { if (d && d.config) state.config = d.config; });

    /* A signed-in customer may open their own order by reference alone; the
       database still verifies ownership. Everyone else needs the order token. */
    var ownerSession = !!(window.MB && typeof window.MB.isCustomerSignedIn === 'function' && window.MB.isCustomerSignedIn());
    if (ref && (token || ownerSession)) {
      load();
    } else {
      el.loading.hidden = true;
      el.lookup.hidden = false;
      if (ref) {
        document.getElementById('lk-ref').value = ref;
        alertBox('info', 'Your order link is missing its security code. Enter the phone number you used and we will find it, or sign in to your account.');
      }
    }

    window.addEventListener('storage', function (e) {
      if (!ref || !token) return;
      if (e && (e.key === 'mb-proof-sync-v1' || e.key === 'mb-local-db-v1')) {
        load();
      }
    });
    window.addEventListener('mb-proof-submitted', function (e) {
      if (!ref || !token) return;
      var dRef = e && e.detail && e.detail.ref;
      if (!dRef || String(dRef).toUpperCase() === ref) {
        if (e && e.detail && e.detail.order) {
          state.order = e.detail.order;
          render();
        } else {
          load();
        }
      }
    });

    document.getElementById('lk-go').addEventListener('click', function () {
      var r = (document.getElementById('lk-ref').value || '').trim().toUpperCase();
      var p = (document.getElementById('lk-phone').value || '').trim();
      MB.api('/api/orders/lookup', {
        method: 'POST',
        body: { ref: r, phone: p }
      }).then(function (d) {
        if (!d.ok) return alertBox('error', esc(d.error));
        window.location.href = d.statusUrl;
      }).catch(function () { alertBox('error', 'Could not reach the server. Try again.'); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
