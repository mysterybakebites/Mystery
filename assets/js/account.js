/* ============================================================
   Mystery Bakebite: customer account page
   ------------------------------------------------------------
   Registration, sign-in, password recovery, profile editing and
   personal order / class-booking history.

   Security notes
   --------------
   * Credentials are owned by Supabase Auth. This file never stores a
     password, a password hash or a long-lived token of its own.
   * Every authenticated read and write is authorised again inside the
     database (RLS + SECURITY DEFINER RPCs). The redirects and hidden
     panels below are convenience only, never the security boundary.
   * The customer id is never taken from the URL or a form field; the
     database derives it from auth.uid().
   ============================================================ */
(function () {
  'use strict';

  var MB = window.MB;
  var el = {};
  var state = {
    mode: 'signin',          // signin | register | reset
    recovery: false,
    next: '',
    busy: false,
    lastOrderRefs: {}
  };

  var RETURN_KEY = 'mb-account-return-v1';

  /* ---------- tiny helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function money(pesewas) {
    var v = Number(pesewas);
    if (!isFinite(v)) return 'GH\u20B5 0.00';
    var neg = v < 0;
    var fixed = Math.abs(v / 100).toFixed(2).split('.');
    fixed[0] = fixed[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '\u2212 ' : '') + 'GH\u20B5 ' + fixed.join('.');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function qs(name) {
    try {
      return new URLSearchParams(window.location.search).get(name) || '';
    } catch (e) { return ''; }
  }

  function alertBox(kind, html) {
    if (!el.alert) return;
    var cls = kind === 'ok' ? 'ok' : (kind === 'success' ? 'ok' : kind);
    var icon = cls === 'ok'
      ? '<path d="M20 6L9 17l-5-5"/>'
      : '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>';
    el.alert.innerHTML = '<div class="alert alert--' + cls + '" role="status">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' + icon + '</svg>' +
      '<span>' + html + '</span></div>';
    el.alert.hidden = false;
    if (el.alert.scrollIntoView) el.alert.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function clearAlert() {
    if (!el.alert) return;
    el.alert.hidden = true;
    el.alert.innerHTML = '';
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.textContent = busyLabel || 'Please wait…';
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  function show(elNode, visible) {
    if (!elNode) return;
    if (visible) {
      elNode.hidden = false;
      elNode.removeAttribute('hidden');
    } else {
      elNode.hidden = true;
      elNode.setAttribute('hidden', '');
    }
  }

  /* ---------- view switching ---------- */
  function setTab(mode) {
    state.mode = mode;
    ['signin', 'register'].forEach(function (m) {
      var tab = document.getElementById('tab-' + m);
      var panel = document.getElementById('acct-' + m + '-panel');
      var on = (m === mode);
      if (tab) {
        tab.classList.toggle('is-on', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      show(panel, on);
    });
  }

  function renderSignedOut() {
    show(el.loading, false);
    show(el.auth, true);
    show(el.dashboard, false);
    setTab(state.mode === 'register' ? 'register' : 'signin');
    if (state.recovery) {
      show(el.resetForm, false);
      show(el.newPasswordForm, true);
      if (el.resetIntro) {
        el.resetIntro.innerHTML = 'You opened a password reset link. Choose a new password for your account.';
      }
      if (el.newPassword && el.newPassword.focus) el.newPassword.focus();
    } else {
      show(el.resetForm, true);
      show(el.newPasswordForm, false);
    }
  }

  function renderSignedIn(profile) {
    show(el.loading, false);
    show(el.auth, false);
    show(el.dashboard, true);

    var name = (profile && profile.fullName) || (MB && MB.customerDisplayName && MB.customerDisplayName()) || 'Customer';
    var email = (profile && profile.email) || (MB && MB.user && MB.user() && MB.user().email) || '';
    var verified = !!(profile && profile.emailVerified);

    if (el.welcome) el.welcome.innerHTML = 'Signed in as <strong>' + esc(name) + '</strong>' + (email ? ' &middot; ' + esc(email) : '');
    if (el.nameDisplay) el.nameDisplay.textContent = name;
    if (el.emailDisplay) el.emailDisplay.textContent = email;
    if (el.avatar) el.avatar.textContent = (name.trim().charAt(0) || 'M').toUpperCase();
    if (el.fullName) el.fullName.value = (profile && profile.fullName) || '';
    if (el.phone) el.phone.value = (profile && profile.phone) || '';
    if (el.emailField) el.emailField.value = email;

    if (el.verifyChip) {
      el.verifyChip.className = 'acct-chip ' + (verified ? 'acct-chip--ok' : 'acct-chip--warn');
      el.verifyChip.textContent = verified ? 'Email verified' : 'Email not verified';
    }
    show(el.verifyBanner, !verified);
    if (!verified && el.verifyText) {
      el.verifyText.innerHTML = 'Confirm <strong>' + esc(email) + '</strong> before placing an order or booking a class. ' +
        '<button type="button" class="acct-inline-link" data-acct-resend style="appearance:none;background:none;border:0;padding:0;color:var(--caramel);font:inherit;text-decoration:underline;cursor:pointer">Resend the confirmation link</button>.';
    }
  }

  /* ---------- data ---------- */
  function loadProfile() {
    if (!MB || !MB.isCustomerSignedIn || !MB.isCustomerSignedIn()) {
      renderSignedOut();
      return Promise.resolve(null);
    }
    if (typeof MB.consumeAuthRedirect === 'function') MB.consumeAuthRedirect();
    return MB.refreshCustomerProfile().then(function (res) {
      if (res && res.ok !== false && res.signedIn === false) {
        renderSignedOut();
        return null;
      }
      if (!res || res.ok === false) {
        /* The session is still valid but the profile service did not answer
           (for example before the migration is applied). Show what the signed
           session already knows instead of dumping the customer back to sign-in. */
        if (MB.isCustomerSignedIn && MB.isCustomerSignedIn()) {
          var u = (MB.user && MB.user()) || {};
          renderSignedIn({
            fullName: (MB.customerDisplayName && MB.customerDisplayName()) || u.name || '',
            email: u.email || '',
            phone: u.phone || '',
            emailVerified: u.emailVerified === true
          });
          return null;
        }
        renderSignedOut();
        return null;
      }
      renderSignedIn(res.profile);
      return loadHistory();
    }).catch(function () {
      if (MB.isCustomerSignedIn && MB.isCustomerSignedIn()) {
        var u2 = (MB.user && MB.user()) || {};
        renderSignedIn({
          fullName: (MB.customerDisplayName && MB.customerDisplayName()) || u2.name || '',
          email: u2.email || '',
          phone: u2.phone || '',
          emailVerified: u2.emailVerified === true
        });
        return null;
      }
      renderSignedOut();
      return null;
    });
  }

  function statusChip(label, variant) {
    return '<span class="acct-chip ' + (variant || '') + '">' + esc(label) + '</span>';
  }

  function paymentChip(status) {
    var map = {
      payment_verified: ['Payment verified', 'acct-chip--ok'],
      payment_submitted: ['Payment under review', 'acct-chip--warn'],
      payment_rejected: ['Payment rejected — resend', 'acct-chip--warn'],
      awaiting_payment: ['Awaiting payment', ''],
      pay_on_collection: ['Pay on collection', ''],
      not_required: ['No payment required', '']
    };
    var row = map[status] || [String(status || 'Payment pending').replace(/_/g, ' '), ''];
    return statusChip(row[0], row[1]);
  }

  function orderChip(status) {
    var map = {
      submitted: 'Submitted',
      confirmed: 'Confirmed',
      in_preparation: 'In preparation',
      ready: 'Ready',
      completed: 'Completed',
      cancelled: 'Cancelled'
    };
    return statusChip(map[status] || String(status || '').replace(/_/g, ' '), status === 'cancelled' ? 'acct-chip--warn' : 'acct-chip--muted');
  }

  function itemsMarkup(order) {
    var items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return '';
    return '<ul class="acct-order__items">' + items.map(function (it) {
      var qty = Number(it.qty) || 1;
      var line = (it.lineTotal === null || it.lineTotal === undefined) ? 'Quote to follow' : money(it.lineTotal);
      var spec = '';
      if (it.custom && it.custom.type) {
        var bits = [];
        if (it.custom.type === 'celebration' && it.custom.variety) bits.push(String(it.custom.variety));
        if (it.custom.size) bits.push(it.custom.size + '-inch');
        if (it.custom.flavour) bits.push(String(it.custom.flavour));
        if (it.custom.decor) bits.push(String(it.custom.decor) + ' decoration');
        if (Array.isArray(it.custom.addons) && it.custom.addons.length) bits.push(it.custom.addons.join(', '));
        if (bits.length) spec = ' <span style="opacity:.72">(' + esc(bits.join(' · ')) + ')</span>';
      }
      return '<li><span>' + esc(it.name || 'Item') + ' &times; ' + qty + spec + '</span><span>' + esc(line) + '</span></li>';
    }).join('') + '</ul>';
  }

  function orderMarkup(order) {
    var ref = String(order.ref || '');
    var date = order.eventDate || order.event_date || '';
    var created = order.createdAt || order.created_at || '';
    var total = order.total;
    var payStatus = order.paymentStatus || order.payment_status;
    var orderStatus = String(order.orderStatus || order.order_status || 'submitted').toLowerCase();
    var canPay = (payStatus === 'awaiting_payment' || payStatus === 'payment_rejected');
    var token = state.lastOrderRefs[ref] || '';
    var trackHref = 'order.html?ref=' + encodeURIComponent(ref) + (token ? '&token=' + encodeURIComponent(token) : '');

    return '<article class="acct-order" data-order-ref="' + esc(ref) + '">' +
      '<div class="acct-order__top">' +
        '<div>' +
          '<div class="acct-order__ref">' + esc(ref) + '</div>' +
          '<div class="acct-order__meta">Placed ' + esc(fmtDate(created)) +
            (date ? ' &middot; Wanted ' + esc(fmtDate(date)) : '') +
            (order.fulfilment ? ' &middot; ' + esc(order.fulfilment === 'delivery' ? 'Delivery' : 'Collection') : '') +
          '</div>' +
        '</div>' +
        '<div class="acct-order__total">' + esc(money(total)) + '</div>' +
      '</div>' +
      '<div class="acct-order__pills">' + orderChip(orderStatus) + paymentChip(payStatus) +
        (order.advanceRequired || order.advance_required ? statusChip('Advance payment required', 'acct-chip--warn') : '') +
      '</div>' +
      itemsMarkup(order) +
      (order.rejectReason ? '<p class="acct-order__meta" style="color:#F2C3B8;margin-top:.6rem">Baker note: ' + esc(order.rejectReason) + '</p>' : '') +
      '<div class="acct-order__actions">' +
        '<a class="btn btn--ghost btn--sm" href="' + esc(trackHref) + '">Open order</a>' +
        (canPay ? '<a class="btn btn--gold btn--sm" href="' + esc(trackHref) + '">Submit payment details</a>' : '') +
      '</div>' +
    '</article>';
  }

  function bookingMarkup(order) {
    var ref = String(order.ref || '');
    var payStatus = order.paymentStatus || order.payment_status;
    var orderStatus = String(order.orderStatus || order.order_status || 'submitted').toLowerCase();
    var token = state.lastOrderRefs[ref] || '';
    var href = 'order.html?ref=' + encodeURIComponent(ref) + (token ? '&token=' + encodeURIComponent(token) : '');

    return '<article class="acct-order" data-booking-ref="' + esc(ref) + '">' +
      '<div class="acct-order__top">' +
        '<div>' +
          '<div class="acct-order__ref">' + esc(ref) + '</div>' +
          '<div class="acct-order__meta">Booked ' + esc(fmtDate(order.createdAt || order.created_at)) + '</div>' +
        '</div>' +
        '<div class="acct-order__total">' + esc(money(order.total)) + '</div>' +
      '</div>' +
      '<div class="acct-order__pills">' + orderChip(orderStatus) + paymentChip(payStatus) + '</div>' +
      itemsMarkup(order) +
      '<div class="acct-order__actions">' +
        '<a class="btn btn--ghost btn--sm" href="' + esc(href) + '">Open booking</a>' +
      '</div>' +
    '</article>';
  }

  function loadHistory() {
    if (!MB || !MB.api) return Promise.resolve();
    return MB.api('/api/account/orders').then(function (res) {
      if (!res || res.ok === false) {
        if (res && res.code === 'auth_required') {
          renderSignedOut();
          return;
        }
        if (el.ordersList) {
          el.ordersList.innerHTML = '<div class="acct-empty">We could not load your orders right now. ' +
            '<a href="#" data-acct-retry>Try again</a>.</div>';
        }
        return;
      }
      /* Remember tokens for orders created in this browser so the tracking page opens. */
      (res.orders || []).forEach(function (o) {
        if (o.ref && o.token) state.lastOrderRefs[o.ref] = o.token;
      });
      (res.bookings || []).forEach(function (o) {
        if (o.ref && o.token) state.lastOrderRefs[o.ref] = o.token;
      });

      var orders = res.orders || [];
      var bookings = res.bookings || [];

      if (el.ordersList) {
        el.ordersList.innerHTML = orders.length
          ? orders.map(orderMarkup).join('')
          : '<div class="acct-empty">No product orders yet.<br><a href="products.html">Browse the bakery counter</a> and your first order will appear here.</div>';
      }
      if (el.bookingsList) {
        el.bookingsList.innerHTML = bookings.length
          ? bookings.map(bookingMarkup).join('')
          : '<div class="acct-empty">No class bookings yet.<br><a href="classes.html">See the bread and pastry tracks</a>.</div>';
      }
    }).catch(function () {
      if (el.ordersList) {
        el.ordersList.innerHTML = '<div class="acct-empty">We could not load your orders right now. ' +
          '<a href="#" data-acct-retry>Try again</a>.</div>';
      }
    });
  }

  /* ---------- after sign-in ---------- */
  function finishSignIn() {
    var next = state.next || '';
    try { next = next || localStorage.getItem(RETURN_KEY) || ''; } catch (e) {}
    if (!/^[a-z0-9._-]+\.html(\?[^"'<>]*)?$/i.test(next)) next = '';
    try { localStorage.removeItem(RETURN_KEY); } catch (e) {}
    if (next) {
      window.location.replace(next);
      return;
    }
    loadProfile();
  }

  /* ---------- forms ---------- */
  function bindSignIn() {
    if (!el.signInForm) return;
    el.signInForm.addEventListener('submit', function (e) {
      e.preventDefault();
      clearAlert();
      if (state.busy) return;
      var email = (el.signInEmail.value || '').trim();
      var password = el.signInPassword.value || '';
      if (!email || !password) {
        return alertBox('error', 'Enter your email address and password.');
      }
      state.busy = true;
      setBusy(el.signInSubmit, true, 'Signing in…');
      MB.signInCustomer(email, password, el.remember ? !!el.remember.checked : true).then(function (res) {
        state.busy = false;
        setBusy(el.signInSubmit, false);
        if (!res || !res.ok) {
          if (res && res.code === 'email_not_verified') {
            alertBox('warn', esc(res.error || 'Confirm your email address first.') +
              ' <button type="button" class="acct-inline-link" data-acct-resend data-email="' + esc(email) + '" ' +
              'style="appearance:none;background:none;border:0;padding:0;color:var(--caramel);font:inherit;text-decoration:underline;cursor:pointer">Resend the link</button>.');
            return;
          }
          return alertBox('error', esc((res && res.error) || 'We could not sign you in.'));
        }
        alertBox('ok', 'Signed in. Loading your account…');
        setTimeout(finishSignIn, 220);
      }).catch(function () {
        state.busy = false;
        setBusy(el.signInSubmit, false);
        alertBox('error', 'We could not reach the sign-in service. Check your connection and try again.');
      });
    });
  }

  function bindRegister() {
    if (!el.registerForm) return;
    el.registerForm.addEventListener('submit', function (e) {
      e.preventDefault();
      clearAlert();
      if (state.busy) return;
      var payload = {
        fullName: (el.regFullName.value || '').trim(),
        email: (el.regEmail.value || '').trim(),
        phone: (el.regPhone.value || '').trim(),
        password: el.regPassword.value || '',
        passwordConfirm: el.regConfirm.value || ''
      };
      state.busy = true;
      setBusy(el.registerSubmit, true, 'Creating account…');
      MB.signUpCustomer(payload).then(function (res) {
        state.busy = false;
        setBusy(el.registerSubmit, false);
        if (!res || !res.ok) {
          return alertBox('error', esc((res && res.error) || 'The account could not be created.'));
        }
        if (res.needsVerification) {
          alertBox('ok', esc(res.message || 'Check your inbox and confirm your email address.') +
            ' <button type="button" class="acct-inline-link" data-acct-resend data-email="' + esc(payload.email) + '" ' +
            'style="appearance:none;background:none;border:0;padding:0;color:var(--caramel);font:inherit;text-decoration:underline;cursor:pointer">Resend the link</button>.');
          el.registerForm.reset();
          setTab('signin');
          if (el.signInEmail) el.signInEmail.value = payload.email;
          return;
        }
        alertBox('ok', esc(res.message || 'Your account is ready.'));
        if (MB.isCustomerSignedIn && MB.isCustomerSignedIn()) {
          setTimeout(finishSignIn, 300);
        } else {
          setTab('signin');
          if (el.signInEmail) el.signInEmail.value = payload.email;
        }
      }).catch(function () {
        state.busy = false;
        setBusy(el.registerSubmit, false);
        alertBox('error', 'We could not create the account. Check your connection and try again.');
      });
    });

    if (el.regPassword) {
      el.regPassword.addEventListener('input', function () {
        var v = el.regPassword.value || '';
        var checks = [
          v.length >= 10,
          /[A-Z]/.test(v) && /[a-z]/.test(v),
          /[0-9]/.test(v)
        ];
        var score = checks.filter(Boolean).length;
        if (!el.strength) return;
        el.strength.classList.toggle('is-good', score === 3);
        el.strength.textContent = score === 3
          ? 'Strong enough. Keep it somewhere safe.'
          : 'Use 10+ characters with upper and lower case letters and a number.';
      });
    }
  }

  function bindReset() {
    if (el.resetForm) {
      el.resetForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var email = (el.resetEmail.value || '').trim();
        if (!email) return alertBox('error', 'Enter the email address on your account.');
        setBusy(el.resetSubmit, true, 'Sending…');
        MB.requestCustomerPasswordReset(email).then(function (res) {
          setBusy(el.resetSubmit, false);
          if (!res || !res.ok) {
            return alertBox('error', esc((res && res.error) || 'The reset email could not be sent.'));
          }
          alertBox('ok', esc(res.message || 'If an account exists for that address, a reset link is on its way.'));
        }).catch(function () {
          setBusy(el.resetSubmit, false);
          alertBox('error', 'We could not reach the reset service. Try again in a moment.');
        });
      });
    }

    if (el.newPasswordForm) {
      el.newPasswordForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var pw = el.newPassword.value || '';
        var confirm = el.newConfirm.value || '';
        if (pw !== confirm) return alertBox('error', 'Both passwords must match.');
        setBusy(el.newPasswordSubmit, true, 'Saving…');
        MB.updateCustomerPassword(pw, confirm).then(function (res) {
          setBusy(el.newPasswordSubmit, false);
          if (!res || !res.ok) {
            return alertBox('error', esc((res && res.error) || 'The password could not be updated.'));
          }
          state.recovery = false;
          alertBox('ok', esc(res.message || 'Password updated.'));
          el.newPasswordForm.reset();
          setTimeout(function () {
            if (MB.isCustomerSignedIn && MB.isCustomerSignedIn()) {
              window.location.replace('account.html');
            } else {
              renderSignedOut();
            }
          }, 900);
        }).catch(function () {
          setBusy(el.newPasswordSubmit, false);
          alertBox('error', 'We could not update the password. Open the reset link again.');
        });
      });
    }
  }

  function bindProfile() {
    if (el.profileForm) {
      el.profileForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var fullName = (el.fullName.value || '').trim();
        var phone = (el.phone.value || '').trim();
        if (fullName.length < 2) return alertBox('error', 'Please enter your full name.');
        if (phone.replace(/\D+/g, '').length < 7) return alertBox('error', 'Please enter a reachable phone number.');
        setBusy(el.profileSubmit, true, 'Saving…');
        MB.api('/api/account/profile', {
          method: 'PATCH',
          body: { fullName: fullName, phone: phone }
        }).then(function (res) {
          setBusy(el.profileSubmit, false);
          if (!res || res.ok === false) {
            return alertBox('error', esc((res && res.error) || 'Your details could not be saved.'));
          }
          renderSignedIn(res.profile);
          alertBox('ok', 'Your details are saved.');
        }).catch(function () {
          setBusy(el.profileSubmit, false);
          alertBox('error', 'We could not save your details. Check your connection.');
        });
      });
    }

    if (el.passwordForm) {
      el.passwordForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var pw = el.curPassword.value || '';
        var confirm = el.curConfirm.value || '';
        if (pw !== confirm) return alertBox('error', 'Both passwords must match.');
        setBusy(el.passwordSubmit, true, 'Updating…');
        MB.updateCustomerPassword(pw, confirm).then(function (res) {
          setBusy(el.passwordSubmit, false);
          if (!res || !res.ok) return alertBox('error', esc((res && res.error) || 'The password could not be updated.'));
          el.passwordForm.reset();
          alertBox('ok', esc(res.message || 'Password updated.'));
        }).catch(function () {
          setBusy(el.passwordSubmit, false);
          alertBox('error', 'We could not update the password. Try again.');
        });
      });
    }
  }

  function bindResend() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-acct-resend]');
      if (!btn) return;
      e.preventDefault();
      var email = btn.getAttribute('data-email') ||
        (el.emailField && el.emailField.value) ||
        (el.signInEmail && el.signInEmail.value) || '';
      clearAlert();
      MB.resendVerificationEmail(email).then(function (res) {
        alertBox(res && res.ok === false ? 'error' : 'ok', esc((res && res.message) || 'Confirmation email sent.'));
      }).catch(function () {
        alertBox('error', 'We could not send the confirmation email just now.');
      });
    });
  }

  /* ---------- init ---------- */
  function init() {
    el.alert = document.getElementById('acct-alert');
    el.loading = document.getElementById('acct-loading');
    el.auth = document.getElementById('acct-auth');
    el.dashboard = document.getElementById('acct-dashboard');

    el.signInForm = document.getElementById('acct-signin-form');
    el.signInEmail = document.getElementById('acct-signin-email');
    el.signInPassword = document.getElementById('acct-signin-password');
    el.signInSubmit = document.getElementById('acct-signin-submit');
    el.remember = document.getElementById('acct-remember');

    el.registerForm = document.getElementById('acct-register-form');
    el.regFullName = document.getElementById('acct-reg-fullname');
    el.regEmail = document.getElementById('acct-reg-email');
    el.regPhone = document.getElementById('acct-reg-phone');
    el.regPassword = document.getElementById('acct-reg-password');
    el.regConfirm = document.getElementById('acct-reg-confirm');
    el.registerSubmit = document.getElementById('acct-register-submit');
    el.strength = document.getElementById('acct-strength');

    el.resetForm = document.getElementById('acct-reset-form');
    el.resetEmail = document.getElementById('acct-reset-email');
    el.resetSubmit = document.getElementById('acct-reset-submit');
    el.resetIntro = document.getElementById('acct-reset-intro');
    el.newPasswordForm = document.getElementById('acct-newpassword-form');
    el.newPassword = document.getElementById('acct-new-password');
    el.newConfirm = document.getElementById('acct-new-confirm');
    el.newPasswordSubmit = document.getElementById('acct-newpassword-submit');

    el.welcome = document.getElementById('acct-welcome');
    el.nameDisplay = document.getElementById('acct-name-display');
    el.emailDisplay = document.getElementById('acct-email-display');
    el.avatar = document.getElementById('acct-avatar');
    el.verifyChip = document.getElementById('acct-verify-chip');
    el.verifyBanner = document.getElementById('acct-verify-banner');
    el.verifyText = document.getElementById('acct-verify-text');

    el.profileForm = document.getElementById('acct-profile-form');
    el.fullName = document.getElementById('acct-fullname');
    el.phone = document.getElementById('acct-phone');
    el.emailField = document.getElementById('acct-email');
    el.profileSubmit = document.getElementById('acct-profile-submit');

    el.passwordForm = document.getElementById('acct-password-form');
    el.curPassword = document.getElementById('acct-cur-password');
    el.curConfirm = document.getElementById('acct-cur-confirm');
    el.passwordSubmit = document.getElementById('acct-password-submit');

    el.ordersList = document.getElementById('acct-orders-list');
    el.bookingsList = document.getElementById('acct-bookings-list');
    el.refreshOrders = document.getElementById('acct-refresh-orders');

    if (!MB) {
      alertBox('error', 'The account service did not load. Refresh the page and try again.');
      return;
    }

    /* Recovery / confirmation links land here with a token in the fragment. */
    var redirectInfo = (typeof MB.consumeAuthRedirect === 'function') ? MB.consumeAuthRedirect() : { type: '', error: '' };
    state.recovery = redirectInfo.type === 'recovery' || qs('mode') === 'reset';
    state.next = qs('next');
    if (redirectInfo.error) {
      alertBox('error', esc(redirectInfo.error));
    }

    /* Tabs */
    document.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-acct-tab]');
      if (tab) {
        e.preventDefault();
        setTab(tab.getAttribute('data-acct-tab'));
        return;
      }
      var showReset = e.target.closest('[data-acct-show-reset]');
      if (showReset) {
        e.preventDefault();
        document.getElementById('acct-reset-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (el.resetEmail) el.resetEmail.focus();
        return;
      }
      var showSignin = e.target.closest('[data-acct-show-signin]');
      if (showSignin) {
        e.preventDefault();
        setTab('signin');
        return;
      }
      var retry = e.target.closest('[data-acct-retry]');
      if (retry) {
        e.preventDefault();
        loadHistory();
        return;
      }
      var signoutReset = e.target.closest('[data-acct-signout-reset]');
      if (signoutReset) {
        e.preventDefault();
        MB.signOutCustomer().then(function () {
          state.mode = 'signin';
          renderSignedOut();
          document.getElementById('acct-reset-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        return;
      }
    });

    bindSignIn();
    bindRegister();
    bindReset();
    bindProfile();
    bindResend();

    if (el.refreshOrders) {
      el.refreshOrders.addEventListener('click', function () {
        el.refreshOrders.disabled = true;
        loadHistory().then(function () { el.refreshOrders.disabled = false; });
      });
    }

    window.addEventListener('mb-auth-changed', function (ev) {
      var detail = ev && ev.detail;
      if (detail && detail.signedIn === false) renderSignedOut();
    });

    /* Deep links: ?verify=1 opens the resend helper, ?mode=register opens sign-up. */
    if (qs('verify') === '1') {
      var email = qs('email') || '';
      alertBox('info', 'Need another confirmation email? ' +
        '<button type="button" class="acct-inline-link" data-acct-resend data-email="' + esc(email) + '" ' +
        'style="appearance:none;background:none;border:0;padding:0;color:var(--caramel);font:inherit;text-decoration:underline;cursor:pointer">Send it again</button>.');
    }
    if (qs('mode') === 'register') state.mode = 'register';
    if (qs('reason') === 'signin_required') {
      alertBox('info', 'Sign in or create a free account to continue. Your cart has been kept exactly as you left it.');
    }

    loadProfile();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
