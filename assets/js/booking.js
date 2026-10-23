/* ============================================================
   Mystery Bakebite: class booking
   ------------------------------------------------------------
   Classes only. Payment is manual: the customer pays the bakery
   and submits a reference or screenshot, which stays under review
   until the baker verifies the funds.
   ============================================================ */
(function () {
  'use strict';

  var state = {
    config: null,
    pricing: null,
    payment: '',
    submitting: false,
    idemKey: null
  };

  var el = {};

  function cart() { return window.MBCarts ? window.MBCarts.class : null; }
  function money(p) { return window.MBPay.money(p); }
  function esc(s) { return window.MBPay.esc(s); }
  function total() { return state.pricing ? state.pricing.total : null; }
  function overThreshold() { return window.MBPay.overThreshold(state.config, total()); }

  function alertBox(kind, message) {
    el.alert.hidden = false;
    el.alert.innerHTML = '<div class="alert alert--' + kind + '"><svg viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
      '<path d="M12 11v5M12 8h.01"/></svg><span>' + message + '</span></div>';
    el.alert.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function clearAlert() { el.alert.hidden = true; el.alert.innerHTML = ''; }

  function openModal(title, body, actions) {
    document.getElementById('pay-modal-body').innerHTML =
      '<h2 id="pay-modal-title">' + esc(title) + '</h2>' +
      '<div class="pay-modal__body">' + body + '</div>' +
      (actions ? '<div class="pay-modal__actions">' + actions + '</div>' : '');
    document.getElementById('pay-modal').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    document.getElementById('pay-modal').classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function total() {
    if (state.pricing && typeof state.pricing.total === 'number') return state.pricing.total;
    return cart() ? cart().subtotal() : 0;
  }

  /* ---------- payment methods ---------- */
  function methodList() {
    return window.MBPay.methods({
      config: state.config || {}, total: total(), kind: 'class'
    });
  }

  function renderPayments() {
    var list = methodList();
    var currentTotal = total();

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
        kind: 'class'
      });
      if (inlineHtml) {
        el.payments.insertAdjacentHTML('beforeend', inlineHtml);
      }
    }
  }

  function openPaymentGuideModal(key) {
    var guide = window.MBPay.guide({ config: state.config, method: key, total: total(), kind: 'class' });
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
      var g = window.MBPay.guide({ config: state.config, method: key, total: total(), kind: 'class' });
      openModal(g.title, g.body,
        (g.actions || '') + '<button type="button" class="btn btn--glass" data-modal-close>Close</button>');
      return;
    }

    state.payment = key;
    renderPayments();
    clearAlert();

    if (showModalNow) {
      openPaymentGuideModal(key);
    }
  }

  /* ---------- summary ---------- */

  function bundleSentence() {
    var c = state.config || {};
    var two = Number(c.bundle_two_pct), three = Number(c.bundle_three_pct);
    var bits = [];
    if (two > 0) bits.push('two classes in one track save ' + two + '%');
    if (three > 0) bits.push('all three save ' + three + '%');
    if (!bits.length) return '';
    return 'Bundle: ' + bits.join(', ') + '.';
  }

  function renderSummary() {
    var c = cart();
    var items = c ? c.items() : [];

    if (!items.length) {
      el.summaryCount.textContent = 'No classes selected';
      el.summaryItems.innerHTML = '';
      el.sumSubtotal.textContent = money(0);
      el.sumTotal.textContent = money(0);
      el.sumDiscountRow.hidden = true;
      el.flags.innerHTML = '';
      el.place.disabled = true;
      el.sumNote.innerHTML = 'Pick your classes on the <a class="link-underline" href="classes.html">classes page</a> ' +
        'first. ' + bundleSentence() + '';
      return;
    }

    el.summaryCount.textContent = items.length + ' class' + (items.length === 1 ? '' : 'es') + ' selected';

    el.summaryItems.innerHTML = items.map(function (i) {
      var line = typeof i.unitPrice === 'number' ? i.unitPrice : null;
      return '<div class="summary-line" data-sum-id="' + esc(i.id) + '">' +
        (i.image ? '<img class="summary-line__img" src="' + esc(i.image) + '" alt="" loading="lazy">' : '') +
        '<div class="summary-line__info">' +
          '<span class="summary-line__name">' + esc(i.name) + '</span>' +
          (i.meta ? '<span class="summary-line__meta">' + esc(i.meta) + '</span>' : '') +
          '<div class="summary-line__controls">' +
            '<button type="button" class="summary-line__rm" data-sum-remove="' + esc(i.id) + '" aria-label="Remove ' + esc(i.name) + '">Remove</button>' +
          '</div>' +
        '</div>' +
        '<div class="summary-line__right">' +
          '<span class="summary-line__amt">' + (line === null ? 'On request' : money(line)) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    var localSub = c.subtotal();
    el.sumSubtotal.textContent = money(localSub);
    el.sumTotal.textContent = money(localSub);
    el.place.disabled = false;
    renderPayments();

    MB.api('/api/price/booking', { method: 'POST', body: { items: c.orderItems() } }).then(function (data) {
      if (!data.ok) {
        el.sumNote.textContent = data.error || 'One of the classes is no longer available.';
        el.place.disabled = true;
        return;
      }
      state.pricing = data;
      el.sumSubtotal.textContent = money(data.subtotal);
      el.sumDiscountRow.hidden = !data.discount;
      el.sumDiscount.textContent = '\u2212 ' + money(data.discount);
      if (el.sumDiscountLabel) {
        var pct = window.mbBundlePct ? window.mbBundlePct(data.bundles) : '';
        el.sumDiscountLabel.textContent = pct ? 'Class bundle discount (' + pct + ')' : 'Class bundle discount';
      }
      el.sumTotal.textContent = money(data.total);
      el.place.disabled = false;

      el.flags.innerHTML = (data.bundles || []).map(function (b) {
        return '<div class="discount-flag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M12 3l2.2 5.2L19 10l-4.8 1.8L12 17l-2.2-5.2L5 10l4.8-1.8z"/></svg>' +
          '<span><strong>' + b.percent + '% ' + b.track + ' bundle applied.</strong> ' +
          b.classes + ' classes in this track save ' + money(b.amount) + '.</span></div>';
      }).join('');

      el.sumNote.innerHTML = esc('The bundle discount is calculated on class fees only and never on bakery products.') +
        ' ' + esc('Class places are held once the baker confirms your dates.');

      renderPayments();
      checkCashStillEligible();
    }).catch(function () {
      el.sumNote.textContent = 'We could not confirm today\u2019s fees. Please refresh before submitting.';
      el.place.disabled = true;
    });
  }

  /* Class fees are paid at the first session, so there is no advance rule to
     re-check here. A booking never becomes a cash delivery order. */
  function checkCashStillEligible() { }

  /* ---------- account requirement ----------
     Class bookings are customer records too, so a verified signed-in account is
     required. The database RPC re-checks the session and e-mail verification. */
  var ACCOUNT_PAGE = 'account.html';
  var REDIRECT_KEY = 'mb-account-return-v1';

  function signedIn() {
    return !!(window.MB && typeof window.MB.isCustomerSignedIn === 'function' && window.MB.isCustomerSignedIn());
  }

  function goToBookingAccount() {
    try { localStorage.setItem(REDIRECT_KEY, 'booking.html'); } catch (e) {}
    window.location.replace(ACCOUNT_PAGE + '?next=booking.html&reason=signin_required');
  }

  function prefillFromAccount() {
    if (!window.MB || typeof window.MB.currentActor !== 'function') return;
    var actor = window.MB.currentActor();
    if (!actor) return;
    if (el.name && !el.name.value) el.name.value = actor.fullName || '';
    if (el.phone && !el.phone.value) el.phone.value = actor.phone || '';
    if (el.email) {
      el.email.value = actor.email || '';
      el.email.readOnly = true;
      el.email.setAttribute('readonly', 'readonly');
    }
  }

  /* ---------- submit ---------- */
  function submit() {
    if (state.submitting) return;
    clearAlert();

    if (!signedIn()) {
      return goToBookingAccount();
    }

    var name = (el.name.value || '').trim();
    var phone = (el.phone.value || '').trim();
    var email = (el.email.value || '').trim();
    var notes = (el.notes.value || '').trim();
    var c = cart();

    if (!c || !c.items().length) return alertBox('error', 'No classes are selected. Choose them on the classes page first.');
    if (name.length < 2) return alertBox('error', 'Please enter the name for the booking.');
    if (!/^[0-9+()\-\s]{7,20}$/.test(phone)) return alertBox('error', 'Please enter a phone number the baker can reach you on.');
    if (email && !/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) return alertBox('error', 'That email address does not look right.');
    if (!state.payment) return alertBox('error', 'Choose how you will pay, or message the kitchen if you are unsure.');

    if (!state.idemKey) {
      state.idemKey = 'bk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    state.submitting = true;
    el.place.disabled = true;
    el.place.textContent = 'Submitting…';

    MB.api('/api/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': state.idemKey },
      body: {
        name: name, phone: phone, email: email, notes: notes,
        paymentMethod: state.payment,
        items: c.orderItems()
      }
    }).then(function (data) {
      var res = { data: data };
      if (!res.data.ok) {
        state.submitting = false;
        el.place.disabled = false;
        el.place.textContent = 'Submit booking';
        if (res.data.code === 'advance_required') {
          var adv = window.MBPay.advance(state.config);
          openModal(adv.title, adv.body,
            '<button type="button" class="btn btn--gold" data-modal-close>Choose another method</button>');
          return;
        }
        if (res.data.code === 'auth_required') {
          alertBox('error', 'Please sign in to your customer account to book this class. Taking you to sign in…');
          setTimeout(goToBookingAccount, 1200);
          return;
        }
        if (res.data.code === 'email_not_verified') {
          alertBox('error', esc(res.data.error || 'Please verify your email address before booking.') +
            ' <a href="account.html?verify=1">Resend the confirmation email</a>.');
          return;
        }
        return alertBox('error', esc(res.data.error || 'The booking could not be submitted.'));
      }
      showResult(res.data);
    }).catch(function () {
      state.submitting = false;
      el.place.disabled = false;
      el.place.textContent = 'Submit booking';
      alertBox('error', 'We could not reach the server. Check your connection and try again. Your booking is still saved.');
    });
  }

  /* ---------- confirmation ---------- */
  function showResult(data) {
    var order = data.order;
    var ref = order.ref;
    state.token = data.token || '';
    var method = state.payment;
    var isAdvance = !!window.MBPay.advanceMethods[method];
    var totalTxt = money(order.total);

    cart().clear();
    el.checkoutView.hidden = true;
    el.done.hidden = false;

    var payBlock = '';

    if (isAdvance) {
      var guide = window.MBPay.guide({
        config: state.config, method: method, total: order.total, kind: 'class', ref: ref
      });
      payBlock =
        '<div class="panel" style="margin-top:1.2rem">' +
          '<h2>' + esc(guide.title) + '</h2>' +
          '<div class="pay-modal__body">' + guide.body + '</div>' +
          '<div class="proof-block" id="proof-block">' +
            '<h3 style="font-size:1.02rem;margin-bottom:.4rem">Submit your payment details</h3>' +
            '<p class="panel__hint">Send the money first. Then add the transaction reference, a screenshot, or both. ' +
            'This puts the payment under review; the baker confirms it after checking the funds.</p>' +
            '<div class="field"><label for="pf-ref">Transaction reference or ID</label>' +
              '<input type="text" id="pf-ref" maxlength="80" placeholder="e.g. the reference in your Mobile Money or bank message" autocomplete="off"></div>' +
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
          '<h2>Cash payment at your first session</h2>' +
          '<div class="pay-card">' +
            window.MBPay.detailRow('Amount to pay', totalTxt, false, true) +
            window.MBPay.detailRow('Booking reference', ref, true) +
            window.MBPay.detailRow('Payment', 'Cash at your first session') +
          '</div>' +
          '<p class="pay-lead" style="margin-top:1rem">Pay the class fee in cash when your course starts. ' +
          'The baker records the payment once the cash is received.</p>' +
          '<p class="pay-note">No advance payment is needed for this amount.</p>' +
        '</div>';
    }

    el.done.innerHTML = '' +
      '<div class="panel thankyou-card" style="max-width:820px;margin:0 auto">' +
        '<div class="thankyou-card__hero">' +
          '<div class="thankyou-card__Seal">' +
            '<img src="assets/img/thank-you.webp" width="144" height="144" alt="Mystery Bakebite — Thank You for supporting my small business. Baked with love, especially for you!">' +
          '</div>' +
          '<div class="thankyou-card__copy">' +
            '<p class="eyebrow">Booking received &middot; Mystery Bakebite</p>' +
            '<h2 style="font-size:clamp(1.6rem,3vw,2.2rem);margin:.3rem 0 .6rem">Thank you, ' + esc(order.customer.name.split(' ')[0]) + '.</h2>' +
            '<p style="font-size:var(--s-3);line-height:1.7;color:rgba(245,230,214,.75)">' +
              'Your booking reference is <strong class="mono" style="color:var(--caramel);font-size:1.05rem">' + esc(ref) + '</strong>. ' +
              (isAdvance ? 'Pay the bakery, then submit your payment details below.'
                         : 'Pay the class fee in cash at your first session.') +
            '</p>' +
          '</div>' +
        '</div>' +

        '<div class="alert alert--info" style="margin-top:1.2rem">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
          '<span><strong>This is a class booking, not a product order.</strong> It has its own reference and payment record. ' +
          (order.discount
            ? 'Your class bundle discount of ' + money(order.discount) +
              (window.mbBundlePct && window.mbBundlePct(order.bundles) ? ' (' + window.mbBundlePct(order.bundles) + ')' : '') +
              ' is applied. '
            : '') +
          'Bakery items are ordered separately.</span>' +
        '</div>' +

        (isAdvance
          ? '<div class="alert alert--warn" style="margin-top:1rem" id="pay-state-alert">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
              '<span><strong>Your place is not confirmed yet.</strong> It stays awaiting payment until the baker verifies the money.</span>' +
            '</div>'
          : '<div class="alert alert--warn" style="margin-top:1rem">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>' +
              '<span><strong>Your place is not confirmed yet.</strong> No payment has been received: pay the class fee in cash at your first session and the baker will record it.</span>' +
            '</div>') +

        payBlock +

        '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:1.4rem">' +
          '<a class="btn btn--glass" href="' + esc(data.statusUrl) + '">Track this booking</a>' +
          '<a class="btn btn--glass" href="' + esc(window.MBPay.waLink(state.config,
            'Hello Mystery Bakebite, about booking ' + ref + ' (' + totalTxt + ').')) + '" target="_blank" rel="noopener">Message the kitchen</a>' +
        '</div>' +
        '<p class="form-note">Keep your reference. Anyone with your booking link can see its status, so treat it as private.</p>' +
      '</div>';

    if (isAdvance) bindProofForm(data, order, method);

    window.scrollTo({ top: 0, behavior: 'smooth' });
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
          '<p class="form-note" style="margin-top:.7rem">Additional payment submissions are locked for this booking while the baker reviews your payment.</p>';
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
          if (metaName) metaName.textContent = f.name || 'payment-screenshot.' + (v.ext || 'jpg');
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
        return alertBox('error', 'Choose a PNG, JPEG or WebP screenshot.');
      }
      if (f.size > 5 * 1024 * 1024) {
        setUploadMsg('error', 'That file is ' + formatFileSize(f.size) + '. Please select a screenshot under 5 MB.');
        return alertBox('error', 'That screenshot is larger than 5 MB. Try a smaller one.');
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

    if (clearBtn) {
      clearBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!isSubmitting) clearFile();
      });
    }

    if (fileEl) {
      fileEl.addEventListener('change', function () { pick(fileEl.files[0]); });
    }
    if (zone) {
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

          lockProofBlock(d.order || { paymentRef: refValue, hasProof: !!imageDataUrl });

          openModal('Payment Details Received',
            '<p class="pay-lead">' + esc(window.MBPay.submittedMessage()) + '</p>',
            '<a class="btn btn--gold" href="' + esc(data.statusUrl) + '">Track this booking</a>' +
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

  /* ---------- init ---------- */
  function init() {
    el.alert = document.getElementById('checkout-alert');
    el.checkoutView = document.getElementById('checkout-view');
    el.done = document.getElementById('checkout-done');
    el.summaryItems = document.getElementById('summary-items');
    el.summaryCount = document.getElementById('summary-count');
    el.sumSubtotal = document.getElementById('sum-subtotal');
    el.sumDiscount = document.getElementById('sum-discount');
    el.sumDiscountRow = document.getElementById('sum-discount-row');
    el.sumTotal = document.getElementById('sum-total');
    el.sumDiscountLabel = document.getElementById('sum-discount-label');
    el.sumNote = document.getElementById('sum-note');
    el.flags = document.getElementById('sum-flags');
    el.payments = document.getElementById('payment-options');
    el.place = document.getElementById('place-order');
    el.name = document.getElementById('co-name');
    el.phone = document.getElementById('co-phone');
    el.email = document.getElementById('co-email');
    el.notes = document.getElementById('co-notes');

    if (!cart()) {
      el.summaryCount.textContent = 'Booking unavailable';
      return;
    }

    if (!signedIn()) {
      goToBookingAccount();
      return;
    }

    prefillFromAccount();
    if (window.MB && typeof window.MB.refreshCustomerProfile === 'function') {
      window.MB.refreshCustomerProfile().then(prefillFromAccount).catch(function () {});
    }

    renderPayments();
    renderSummary();

    MB.api('/api/config').then(function (d) {
      state.config = d.config;
      renderPayments();
      renderSummary();
    }).catch(function () { renderSummary(); });

    el.place.addEventListener('click', submit);

    document.addEventListener('click', function (e) {
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
      var rmBtn = e.target.closest('[data-sum-remove]');
      if (rmBtn && cart()) {
        e.preventDefault();
        cart().remove(rmBtn.getAttribute('data-sum-remove'));
        if (window.MBCarts && window.MBCarts.refresh) window.MBCarts.refresh();
        renderSummary();
        return;
      }
      if (e.target.closest('[data-modal-close]')) closeModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });

    ['input', 'change'].forEach(function (evt) {
      var form = document.getElementById('checkout-form');
      if (form) form.addEventListener(evt, clearAlert);
    });

    document.addEventListener('mb-booking-updated', renderSummary);
    document.addEventListener('mb-cart-updated', renderSummary);
    setTimeout(renderSummary, 300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
