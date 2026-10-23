/* ============================================================
   Mystery Bakebite: payment methods and payment messaging
   ------------------------------------------------------------
   One place defines how each payment method is described, when it
   may be offered, and the exact pop-up the customer sees.

     mobile money   advance payment, verified details, then the
                    customer submits a reference or screenshot and
                    the baker verifies the funds
     bank transfer  the same rule, against the business account
     cash delivery  paid on delivery, only at or below the
                    advance-payment threshold
     cash pickup    paid at collection, same threshold

   Nothing here decides that money arrived. Submitting details moves
   a payment to "Payment Under Review"; only the baker confirms it.
   ============================================================ */
(function () {
  'use strict';

  var LABEL = {
    momo: 'Mobile Money',
    bank_transfer: 'Bank transfer',
    cash_on_delivery: 'Cash on delivery',
    cash_on_pickup: 'Cash on pickup'
  };

  function label(key) { return LABEL[key] || String(key || '').replace(/_/g, ' '); }

  function money(p) {
    if (typeof p !== 'number' || !isFinite(p)) return 'the amount shown';
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

  function threshold(config) {
    var t = config && typeof config.advance_threshold === 'number' && isFinite(config.advance_threshold)
      ? config.advance_threshold
      : 70000;
    /* pesewas are the stored unit; normalise a legacy cedi value so the
       "strictly greater than GH₵ 700.00" comparison stays correct */
    if (t > 0 && t < 1000) t = Math.round(t * 100);
    return t;
  }

  function overThreshold(config, total) {
    return typeof total === 'number' && total > threshold(config);
  }

  var DEFAULT_MOMO = {
    name: 'Mystery Bakebite',
    number: '055 452 0532',
    provider: 'MTN MoMo / Telecel Cash',
    note: 'Use your order or booking reference as the payment reference.'
  };

  var DEFAULT_BANK = {
    name: 'GCB Bank — Tamale Main Branch',
    accountName: 'Mystery Bakebite',
    accountNumber: '9011010048291'
  };

  function resolveMomo(config) {
    if (config && config.momo === false) return null;
    if (config && config.momo && config.momo.name && config.momo.number) return config.momo;
    return DEFAULT_MOMO;
  }

  function resolveBank(config) {
    if (config && config.bank === false) return null;
    if (config && config.bank && config.bank.name && config.bank.accountNumber) return config.bank;
    return DEFAULT_BANK;
  }

  function resolveCash(config) {
    var c = (config && config.cash) || {};
    return {
      delivery: c.delivery !== undefined ? !!c.delivery : true,
      pickup: c.pickup !== undefined ? !!c.pickup : true
    };
  }

  /* ---------- which methods may be chosen ---------- */
  function methods(ctx) {
    var config = ctx.config || {};
    var isClass = ctx.kind === 'class';
    var momo = resolveMomo(config);
    var bank = resolveBank(config);
    var cash = resolveCash(config);
    var total = ctx.total;
    var over = overThreshold(config, total);
    var list = [];

    list.push({
      key: 'momo',
      title: 'Mobile Money',
      recommended: true,
      available: !!momo,
      reason: momo ? '' : 'Verified Mobile Money details are not published yet.',
      sub: momo
        ? 'Pay ' + momo.name + ' on ' + momo.number + ' (' + (momo.provider || 'MTN MoMo') + '), then submit your reference or screenshot.'
        : 'The baker has not published verified Mobile Money details yet.'
    });

    list.push({
      key: 'bank_transfer',
      title: 'Bank transfer',
      available: !!bank,
      reason: bank ? '' : 'Verified bank details are not published yet.',
      sub: bank
        ? 'Transfer to ' + bank.name + ' · ' + bank.accountName + ' (' + bank.accountNumber + '), then submit your reference or slip.'
        : 'The baker has not published verified bank details yet.'
    });

    if (!isClass) {
      list.push({
        key: 'cash_on_delivery',
        title: 'Cash on delivery',
        available: !!cash.delivery && !over,
        advanceRequired: !!cash.delivery && over,
        reason: !cash.delivery ? 'Cash on delivery is switched off.' : '',
        sub: over
          ? 'Orders above ' + money(threshold(config)) + ' need advance payment.'
          : 'Pay the exact total in cash when your order is delivered within Tamale.'
      });
    }

    list.push({
      key: 'cash_on_pickup',
      title: isClass ? 'Pay at your first session' : 'Cash on pickup',
      available: !!cash.pickup && (!over || isClass),
      advanceRequired: !!cash.pickup && over && !isClass,
      reason: !cash.pickup ? 'Cash on pickup is switched off.' : '',
      sub: (over && !isClass)
        ? 'Orders above ' + money(threshold(config)) + ' need advance payment.'
        : (isClass ? 'Pay the class fee in cash when your course starts at the Tamale studio.'
                   : 'Pay the exact total in cash when you collect from the bakery.')
    });

    return list;
  }

  /* ---------- shared bits of pop-up markup ---------- */
  function detailRow(labelText, value, mono, big) {
    return '<div class="pay-detail"><span>' + esc(labelText) + '</span><b' +
      (mono ? ' class="mono"' : '') + (big ? ' style="font-size:1.2rem"' : '') + '>' +
      esc(value) + '</b></div>';
  }

  function stepList(steps) {
    return '<ol class="pay-steps">' + steps.map(function (s, i) {
      return '<li><span class="pay-steps__n">' + (i + 1) + '</span><span class="pay-steps__t">' +
        s + '</span></li>';
    }).join('') + '</ol>';
  }

  function waLink(config, text) {
    var number = (config && config.whatsapp) || '233554520532';
    return 'https://wa.me/' + number + '?text=' + encodeURIComponent(text);
  }

  function waButton(href, labelText) {
    return '<a class="btn btn--gold" href="' + esc(href) + '" target="_blank" rel="noopener">' +
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.2-1.8-.9-2.1-1-.3-.1-.5-.2-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.5-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.3-.4.4-.6.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5 0-.2-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4 0 1.4 1 2.8 1.2 3 .2.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.6-.1 1.8-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.2-.6-.4z"/><path d="M12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.3 4.9L2 22l5.2-1.3c1.4.8 3 1.2 4.8 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3.1.8.8-3-.2-.3C4 15 3.6 13.5 3.6 12 3.6 7.4 7.4 3.6 12 3.6S20.4 7.4 20.4 12 16.6 20.2 12 20.2z"/></svg>' +
      esc(labelText) + '</a>';
  }

  /* ---------- the guide shown when a method is chosen ---------- */
  function guide(ctx) {
    var config = ctx.config || {};
    var method = ctx.method;
    var total = ctx.total;
    var isClass = ctx.kind === 'class';
    var ref = ctx.ref || '';
    var amount = money(total);

    if (method === 'momo') {
      var m = resolveMomo(config);
      if (!m) {
        return {
          title: 'Mobile Money Is Not Available Yet',
          body:
            '<p class="pay-lead">The bakery has not published verified Mobile Money details, so none are shown here. ' +
            'Nothing has been charged.</p>' +
            '<p class="pay-lead">Choose bank transfer or cash, or send the ' + (isClass ? 'booking' : 'order') +
            ' on WhatsApp and the baker will confirm how to pay.</p>',
          actions: waButton(waLink(config, 'Hello Mystery Bakebite, how can I pay for my ' +
            (isClass ? 'class booking' : 'order') + '?'), 'Ask the bakery')
        };
      }
      return {
        title: 'Complete Your Mobile Money Payment',
        body:
          '<p class="pay-lead">Send ' + amount + ' by Mobile Money from your own phone using the verified details ' +
          'below. Payment is made to the bakery, not on this website.</p>' +
          '<div class="pay-card">' +
            detailRow('Recipient name', m.name) +
            detailRow('Mobile Money number', m.number, true) +
            (m.provider ? detailRow('Network', m.provider) : '') +
            detailRow('Amount due', amount, false, true) +
            (ref ? detailRow('Reference', ref, true) : '') +
          '</div>' +
          stepList([
            'Transfer the exact amount from your phone.',
            'Keep the transaction reference or the payment screenshot.',
            'Submit the reference or screenshot' + (ref ? ' on this ' + (isClass ? 'booking page' : 'order page') : '') +
              ' so the baker can match it.',
            'The baker checks that the funds arrived, then confirms your payment.'
          ]) +
          (m.note ? '<p class="pay-note">' + esc(m.note) + '</p>' : '') +
          '<p class="pay-note">Your payment is not confirmed by sending the reference. It stays under review until ' +
          'the baker verifies the funds.</p>',
        actions: waButton(waLink(config,
          'Hello Mystery Bakebite, I have paid for my ' + (isClass ? 'class booking' : 'order') +
          ' by Mobile Money. I am sending my payment receipt here for confirmation.'), 'Send the receipt on WhatsApp')
      };
    }

    if (method === 'bank_transfer') {
      var b = resolveBank(config);
      if (!b) {
        return {
          title: 'Bank Transfer Is Not Available Yet',
          body: '<p class="pay-lead">The bakery has not published verified bank details, so none are shown here. ' +
            'Nothing has been charged.</p>' +
            '<p class="pay-lead">Choose Mobile Money or cash, or ask the bakery on WhatsApp.</p>',
          actions: waButton(waLink(config, 'Hello Mystery Bakebite, how can I pay by bank transfer?'), 'Ask the bakery')
        };
      }
      return {
        title: 'Complete Your Bank Transfer',
        body:
          '<p class="pay-lead">Transfer ' + amount + ' to the bakery account below, then submit the transfer reference ' +
          'or proof of payment.</p>' +
          '<div class="pay-card">' +
            detailRow('Bank', b.name) +
            detailRow('Account name', b.accountName) +
            detailRow('Account number', b.accountNumber, true) +
            detailRow('Amount due', amount, false, true) +
            (ref ? detailRow('Reference', ref, true) : '') +
          '</div>' +
          stepList([
            'Make the transfer for the exact amount.',
            'Use the ' + (isClass ? 'booking' : 'order') + ' reference as the transfer description if your bank asks for one.',
            'Submit the transfer reference or a photo of the transfer slip' +
              (ref ? ' on this ' + (isClass ? 'booking page' : 'order page') : '') + '.',
            'The baker checks the business bank account and confirms the payment.'
          ]) +
          '<p class="pay-note">Submitting a reference or slip does not confirm payment. It is verified by hand.</p>',
        actions: waButton(waLink(config,
          'Hello Mystery Bakebite, I have made a bank transfer for my ' + (isClass ? 'class booking' : 'order') +
          '. I am sending the transfer receipt here for confirmation.'), 'Send the receipt on WhatsApp')
      };
    }

    if (method === 'cash_on_delivery') {
      return {
        title: 'Cash Payment on Delivery',
        body:
          '<p class="pay-lead">You will pay ' + amount + ' in cash when your order is delivered.</p>' +
          '<div class="pay-card">' +
            detailRow('Amount to prepare', amount, false, true) +
            (ref ? detailRow('Order reference', ref, true) : '') +
            detailRow('Delivery', 'Within Tamale, arranged with the baker') +
          '</div>' +
          stepList([
            'Place the order: no advance payment is needed for this amount.',
            'Have the exact amount ready when the order arrives.',
            'The baker or the delivery person records the payment once the cash is received.',
            'The order is then marked as paid and confirmed.'
          ]) +
          '<p class="pay-note">Cash on delivery is only offered for orders of ' +
          money(threshold(config)) + ' or less.</p>'
      };
    }

    return {
      title: 'Cash Payment on Pickup',
      body:
        '<p class="pay-lead">' +
        (isClass
          ? 'You will pay the class fee of ' + amount + ' in cash when your course starts.'
          : 'You will pay ' + amount + ' in cash when you collect your order.') +
        '</p>' +
        '<div class="pay-card">' +
          detailRow('Amount to prepare', amount, false, true) +
          (ref ? detailRow(isClass ? 'Booking reference' : 'Order reference', ref, true) : '') +
          detailRow(isClass ? 'Where' : 'Collection', isClass ? 'In person, Tamale' : 'Agreed with the baker') +
        '</div>' +
        stepList([
          isClass ? 'Place the booking: no advance payment is needed for this amount.'
                  : 'Place the order: no advance payment is needed for this amount.',
          isClass ? 'Pay the fee in cash at your first session.'
                  : 'Pay the exact total when you collect.',
          'The baker records the payment once the cash is received.',
          isClass ? 'Your place is then marked as paid and confirmed.' : 'Your order is then marked as paid and confirmed.'
        ]) +
        (isClass
          ? '<p class="pay-note">Class fees are paid in cash at your first session. Places are held once the ' +
            'baker confirms your start date.</p>'
          : '<p class="pay-note">Cash on pickup is only offered for orders of ' +
            money(threshold(config)) + ' or less.</p>')
    };
  }

  /* ---------- fixed messages ---------- */
  function advance(config) {
    return {
      title: 'Advance Payment Required',
      body:
        '<p class="pay-lead">Orders above ' + money(threshold(config)) + ' require advance payment before ' +
        'confirmation. Please select Mobile Money or bank transfer to complete your payment. Your order will ' +
        'remain unconfirmed until payment has been verified.</p>' +
        '<p class="pay-note">Cash on delivery and cash on pickup cannot be used above ' +
        money(threshold(config)) + '.</p>'
    };
  }

  function cashConfirmation(method, total) {
    if (method === 'cash_on_delivery') {
      return 'You have selected cash on delivery. Please have the exact order amount ready when your order arrives.';
    }
    return 'You have selected cash on pickup. Please pay the displayed order total when collecting your order.';
  }

  function advanceConfirmation(method) {
    if (method === 'bank_transfer') {
      return 'Your transfer details have been submitted for review. Your order will be confirmed once the baker ' +
        'verifies receipt of the funds.';
    }
    return 'Your payment details have been submitted and are awaiting verification. Your order will be confirmed ' +
      'once the baker verifies that the payment has been received.';
  }

  function submittedMessage() {
    return 'Your payment details have been received and are awaiting verification. Submitting payment proof does ' +
      'not automatically confirm payment. The baker will verify the transaction and update your order status.';
  }

  function verifiedMessage() {
    return 'Your payment has been verified successfully. Your order can now proceed to the next stage of processing.';
  }

  function inlineSummary(ctx) {
    var config = ctx.config || {};
    var method = ctx.method;
    var isClass = ctx.kind === 'class';
    var amount = money(ctx.total);

    if (method === 'momo') {
      var m = resolveMomo(config);
      if (!m) return '';
      return '' +
        '<div class="pay-inline" data-pay-inline="momo">' +
          '<div class="pay-inline__head">' +
            '<strong>Mobile Money details</strong>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-pay-guide="momo">Full payment guide</button>' +
          '</div>' +
          '<div class="pay-card">' +
            detailRow('Recipient name', m.name) +
            detailRow('Mobile Money number', m.number, true) +
            (m.provider ? detailRow('Network', m.provider) : '') +
            detailRow('Amount due', amount, false, true) +
          '</div>' +
          '<p class="pay-inline__note">Submit your order below first to get your reference, then send ' + esc(amount) + ' and upload your reference or screenshot.</p>' +
        '</div>';
    }

    if (method === 'bank_transfer') {
      var b = resolveBank(config);
      if (!b) return '';
      return '' +
        '<div class="pay-inline" data-pay-inline="bank_transfer">' +
          '<div class="pay-inline__head">' +
            '<strong>Bank transfer details</strong>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-pay-guide="bank_transfer">Full payment guide</button>' +
          '</div>' +
          '<div class="pay-card">' +
            detailRow('Bank', b.name) +
            detailRow('Account name', b.accountName) +
            detailRow('Account number', b.accountNumber, true) +
            detailRow('Amount due', amount, false, true) +
          '</div>' +
          '<p class="pay-inline__note">Submit your order below first to get your reference, then complete the transfer and upload your reference or slip.</p>' +
        '</div>';
    }

    if (method === 'cash_on_delivery') {
      return '' +
        '<div class="pay-inline" data-pay-inline="cash_on_delivery">' +
          '<div class="pay-inline__head">' +
            '<strong>Cash on delivery selected</strong>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-pay-guide="cash_on_delivery">How it works</button>' +
          '</div>' +
          '<p class="pay-inline__note">No advance payment required. Prepare <strong>' + esc(amount) + '</strong> in cash when your order is delivered within Tamale.</p>' +
        '</div>';
    }

    if (method === 'cash_on_pickup') {
      return '' +
        '<div class="pay-inline" data-pay-inline="cash_on_pickup">' +
          '<div class="pay-inline__head">' +
            '<strong>' + (isClass ? 'Pay at your first session selected' : 'Cash on pickup selected') + '</strong>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-pay-guide="cash_on_pickup">How it works</button>' +
          '</div>' +
          '<p class="pay-inline__note">' +
            (isClass
              ? 'No advance payment required. Pay the course fee of <strong>' + esc(amount) + '</strong> in cash when your first session begins.'
              : 'No advance payment required. Pay <strong>' + esc(amount) + '</strong> in cash when you collect your order from the bakery.') +
          '</p>' +
        '</div>';
    }

    return '';
  }

  window.MBPay = {
    label: label,
    money: money,
    esc: esc,
    methods: methods,
    guide: guide,
    inlineSummary: inlineSummary,
    advance: advance,
    threshold: threshold,
    overThreshold: overThreshold,
    cashConfirmation: cashConfirmation,
    advanceConfirmation: advanceConfirmation,
    submittedMessage: submittedMessage,
    verifiedMessage: verifiedMessage,
    waLink: waLink,
    waButton: waButton,
    detailRow: detailRow,
    stepList: stepList,
    advanceMethods: { momo: 1, bank_transfer: 1 },
    cashMethods: { cash_on_delivery: 1, cash_on_pickup: 1 }
  };
})();
