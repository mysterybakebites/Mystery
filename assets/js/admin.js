/* ============================================================
   Mystery Bakebite: admin dashboard
   Orders, payment verification, catalogue and pricing.
   All writes send the X-MB-Admin header, which a cross-site
   request cannot set, so the session cookie alone is not enough.
   ============================================================ */
(function () {
  'use strict';

  var el = {};
  var state = {
    tab: 'overview',
    orders: [],
    filters: { q: '', status: '', payment: '', kind: '' },
    catalogue: null,
    dashboard: null,
    currentOrder: null,
    username: '',
    email: '',
    role: 'administrator',
    isSuperAdmin: false,
    mustChangePassword: false,
    permissions: null,
    days: 7,
    metric: 'revenue',
    // when a panel was last filled, so moving between tabs reuses the render
    // instead of refetching and flashing
    loadedAt: {}
  };

  var CACHE_MS = 20000;
  var TAB_LOADERS = {};

  /* ---------- helpers ---------- */
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
  function label(v) {
    var t = String(v || '').replace(/_/g, ' ');
    if (t === 'momo') return 'Mobile Money';
    if (t === 'bank transfer') return 'Bank transfer';
    if (t === 'cash on pickup') return 'Cash on pickup';
    if (t === 'cash on delivery') return 'Cash on delivery';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function typeBadge(kind) {
    var cls = kind === 'class' ? 'badge--blush' : 'badge--amber';
    return '<span class="badge ' + cls + '">' + (kind === 'class' ? 'Booking' : 'Order') + '</span>';
  }
  function noun(kind) { return kind === 'class' ? 'Booking' : 'Order'; }
  function when(iso) {
    if (!iso) return '';
    return iso.replace('T', ' ').replace('Z', '');
  }

  var PAY = {
    awaiting_payment: ['Awaiting payment', 'amber'],
    payment_submitted: ['Proof to check', 'blue'],
    payment_verified: ['Payment verified', 'green'],
    payment_rejected: ['Not verified', 'red'],
    pay_on_collection: ['Pay on collection', 'grey'],
    not_required: ['No payment', 'grey']
  };
  var ORD = {
    submitted: ['Submitted', 'amber'],
    confirmed: ['Confirmed', 'blue'],
    in_preparation: ['In preparation', 'blue'],
    completed: ['Completed', 'green'],
    cancelled: ['Cancelled', 'red']
  };
  function payBadge(k) { var m = PAY[k] || [k, 'grey']; return '<span class="badge badge--' + m[1] + '">' + esc(m[0]) + '</span>'; }
  function ordBadge(k) { var m = ORD[k] || [k, 'grey']; return '<span class="badge badge--' + m[1] + '">' + esc(m[0]) + '</span>'; }

  /* ---------- transport ------------------------------------------------
     Every call goes to the database as the signed-in user. Supabase Auth holds
     the session; the database decides whether that session is on the baker
     roster. A signed-in stranger gets a permission error, not a screen. */
  function api(path, opts) {
    return MB.api(path, opts || {}).then(function (d) {
      if (d && d.code === 'password_change_required') {
        showFirstLoginGate({ email: state.email || (MB.user() && MB.user().email) || '', role: state.role || 'super_admin' });
        throw new Error('password_change_required');
      }
      if (d && d.auth) { showLogin(d.error || ''); throw new Error('unauthorised'); }
      return d;
    });
  }

  function flash(kind, msg) {
    el.alert.hidden = false;
    el.alert.innerHTML = '<div class="alert alert--' + kind + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span>' + msg + '</span></div>';
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { el.alert.hidden = true; }, 6000);
  }

  function refreshSuperAdminSetupBanner() {
    var box = document.getElementById('super-admin-setup-box');
    if (!box || typeof MB.getSuperAdminSetupStatus !== 'function') return;
    var st = MB.getSuperAdminSetupStatus();
    if (st && !st.isProvisioned) {
      box.hidden = false;
      var loginUser = document.getElementById('login-user');
      if (loginUser && !loginUser.value) loginUser.value = st.email || 'mysterybakebite@gmail.com';
    } else {
      box.hidden = true;
    }
  }

  /* ---------- auth ---------- */
  function showLogin(unauthMessage) {
    el.login.hidden = false;
    if (el.firstLogin) el.firstLogin.hidden = true;
    if (el.forgot) el.forgot.hidden = true;
    el.app.hidden = true;
    el.app.setAttribute('aria-hidden', 'true');
    state.orders = [];
    state.catalogue = null;
    state.dashboard = null;
    state.currentOrder = null;
    state.loadedAt = {};
    closePops();
    refreshSuperAdminSetupBanner();
    if (typeof window.syncMBAuthNav === 'function') window.syncMBAuthNav(false);

    /* Strip any deep-linked dashboard tab/hash if the user is not authenticated */
    var rawHash = (window.location.hash || '').replace(/^#/, '');
    var hasTabParam = /[?&]tab=/i.test(window.location.search || '');
    if ((rawHash && rawHash !== 'admin-login' && rawHash !== 'login' && rawHash !== 'top' && rawHash.indexOf('type=recovery') === -1) || hasTabParam) {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', 'admin.html');
      }
      if (!unauthMessage) {
        unauthMessage = 'Administrator authentication is required to access that dashboard section. Please sign in below.';
      }
    }
    if (unauthMessage) {
      signInError(unauthMessage);
    }
  }

  function showForgot() {
    el.login.hidden = true;
    if (el.firstLogin) el.firstLogin.hidden = true;
    if (el.forgot) el.forgot.hidden = false;
    el.app.hidden = true;
    el.app.setAttribute('aria-hidden', 'true');
    var fb = document.getElementById('forgot-feedback');
    if (fb) fb.hidden = true;
    var loginUser = document.getElementById('login-user');
    var forgotEmail = document.getElementById('forgot-email');
    if (forgotEmail && loginUser && loginUser.value) forgotEmail.value = loginUser.value;
  }

  function roleBadgeLabel(role) {
    var r = String(role || '').toLowerCase();
    if (r === 'super_admin') return 'Super Administrator';
    if (r === 'administrator') return 'Administrator';
    if (r === 'manager') return 'Order & Kitchen Manager';
    if (r === 'viewer') return 'Read-Only Viewer';
    return 'Administrator';
  }

  function showFirstLoginGate(info) {
    info = info || {};
    el.login.hidden = true;
    if (el.forgot) el.forgot.hidden = true;
    if (el.firstLogin) el.firstLogin.hidden = false;
    el.app.hidden = true;
    el.app.setAttribute('aria-hidden', 'true');
    state.mustChangePassword = true;
    state.email = info.email || state.email || (MB.user() && MB.user().email) || 'mysterybakebite@gmail.com';
    state.role = info.role || state.role || 'super_admin';
    var emEl = document.getElementById('first-login-email');
    var rlEl = document.getElementById('first-login-role');
    var errEl = document.getElementById('first-login-error');
    if (emEl) emEl.textContent = state.email;
    if (rlEl) rlEl.textContent = roleBadgeLabel(state.role);
    if (errEl) errEl.hidden = true;
    if (typeof window.syncMBAuthNav === 'function') window.syncMBAuthNav(false);
  }

  /* a baker is an email address now, so the greeting uses the name part */
  function displayName(address, nameOverride) {
    if (nameOverride && String(nameOverride).trim()) return String(nameOverride).trim();
    var local = String(address || '').split('@')[0] || 'Baker';
    return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function applyRolePermissionsToNav(who) {
    state.email = (who && who.email) || state.email || '';
    state.role = (who && who.role) || state.role || 'administrator';
    state.isSuperAdmin = !!(who && who.isSuperAdmin);
    state.permissions = (who && who.permissions) || (typeof MB.getPermissions === 'function' ? MB.getPermissions() : null) || {
      view: true, orders: true, verify: true, catalogue: true, settings: true, team: state.isSuperAdmin
    };
    var payTab = document.getElementById('tab-btn-payments');
    if (payTab) {
      payTab.hidden = !state.permissions.settings;
    }
    var summaryEl = document.getElementById('dash-summary');
    if (summaryEl) {
      summaryEl.innerHTML = 'Signed in as <strong>' + esc(state.email) + '</strong> &middot; <span class="badge ' +
        (state.isSuperAdmin ? 'badge--amber' : 'badge--blue') + '">' + esc(roleBadgeLabel(state.role)) + '</span>';
    }
  }

  function showApp(username, who) {
    if (who && who.mustChangePassword) {
      showFirstLoginGate(who);
      return;
    }
    el.login.hidden = true;
    if (el.firstLogin) el.firstLogin.hidden = true;
    if (el.forgot) el.forgot.hidden = true;
    el.app.hidden = false;
    el.app.removeAttribute('aria-hidden');
    state.mustChangePassword = false;
    applyRolePermissionsToNav(who || {});
    if (typeof window.syncMBAuthNav === 'function') window.syncMBAuthNav(true);
    username = displayName(username, who && who.name);
    if (username) {
      state.username = username;
      var u = document.getElementById('dash-user');
      var i = document.getElementById('dash-initial');
      if (u) u.textContent = username;
      if (i) i.textContent = (username.charAt(0) || 'B').toUpperCase();
    }
    moveIndicator();
    loadOverview();
    setTimeout(moveIndicator, 120);
  }

  /* called right after a successful sign-in: confirm the session is actually
     accepted before moving the baker to the dashboard */
  function confirmSession(tries) {
    tries = typeof tries === 'number' ? tries : 3;
    return api('/api/admin/session').then(function (d) {
      if (d && d.ok && d.isAdmin) {
        if (d.mustChangePassword) {
          showFirstLoginGate(d);
          return true;
        }
        showApp(d.email || 'Baker', d);
        return true;
      }
      if (tries > 0) {
        return new Promise(function (r) { setTimeout(r, 250); }).then(function () { return confirmSession(tries - 1); });
      }
      return false;
    }).catch(function () { return false; });
  }

  function checkSession() {
    if (!MB.isSignedIn()) {
      showLogin();
      return;
    }
    api('/api/admin/session').then(function (d) {
      if (d && d.ok && d.isAdmin) {
        if (d.mustChangePassword) {
          showFirstLoginGate(d);
          return;
        }
        showApp(d.email || 'Baker', d);
      } else if (d && d.ok && d.signedIn && !d.isAdmin) {
        /* Role-based access control: authenticated non-admin accounts are signed out and redirected to customer storefront */
        var msg = d.deactivated
          ? 'This administrator account has been deactivated by the Super Administrator.'
          : 'Access denied: that account does not have administrator privileges. Redirecting to the storefront\u2026';
        MB.signOut().then(function () {
          showLogin(msg);
          if (!d.deactivated) {
            setTimeout(function () {
              window.location.replace('index.html');
            }, 1200);
          }
        });
      } else {
        showLogin();
      }
    }).catch(function () { showLogin(); });
  }

  /* a session was accepted but the roster says no: say so plainly */
  function signInError(msg) {
    var err = document.getElementById('login-error');
    if (!err) return;
    err.hidden = false;
    err.innerHTML = '<div class="alert alert--error"><span>' + esc(msg) + '</span></div>';
  }

  function doProvisionSuperAdmin() {
    if (typeof MB.provisionSuperAdmin !== 'function') return;
    var btn = document.getElementById('btn-provision-super-admin');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating temporary credential\u2026'; }
    MB.provisionSuperAdmin('mysterybakebite@gmail.com').then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = 'Generate Temporary First-Login Password'; }
      if (!res || !res.ok) {
        signInError((res && res.error) || 'Could not provision Super Administrator account.');
        return;
      }
      var outBox = document.getElementById('super-admin-setup-output');
      var codeEl = document.getElementById('super-admin-temp-pass');
      var userInp = document.getElementById('login-user');
      var passInp = document.getElementById('login-pass');
      if (codeEl) codeEl.textContent = res.temporaryPassword || '';
      if (outBox) outBox.hidden = false;
      if (userInp) userInp.value = res.email || 'mysterybakebite@gmail.com';
      if (passInp) passInp.value = res.temporaryPassword || '';
      if (btn) btn.hidden = true;
    });
  }

  function doLogin(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (state.loggingIn) return;
    state.loggingIn = true;
    var u = (document.getElementById('login-user').value || '').trim();
    var p = document.getElementById('login-pass').value;
    var err = document.getElementById('login-error');
    err.hidden = true;
    if (!MB.configured) {
      signInError('The bakery database is not connected yet. Add the Supabase project URL and publishable key to assets/js/config.js.');
      state.loggingIn = false;
      return;
    }
    var usedTempPassword = p;
    MB.signIn(u, p, true).then(function (res) {
      document.getElementById('login-pass').value = '';
      if (!res.ok) {
        state.loggingIn = false;
        if (res.setupRequired) {
          refreshSuperAdminSetupBanner();
        }
        signInError(res.error || 'Sign in failed.');
        return;
      }
      if (res.mustChangePassword) {
        state.loggingIn = false;
        var curInput = document.getElementById('first-login-current');
        if (curInput) curInput.value = usedTempPassword;
        showFirstLoginGate(res);
        return;
      }
      confirmSession().then(function (ok) {
        state.loggingIn = false;
        if (!ok) {
          signInError('That account signed in but is not on the authorized administrator roster.');
        }
      });
    }).catch(function () {
      state.loggingIn = false;
      signInError('Could not reach the sign-in service. Check your connection and try again.');
    });
  }

  function doFirstLoginPasswordChange(e) {
    if (e && e.preventDefault) e.preventDefault();
    var curEl = document.getElementById('first-login-current');
    var newEl = document.getElementById('first-login-new');
    var cfmEl = document.getElementById('first-login-confirm');
    var errEl = document.getElementById('first-login-error');
    if (errEl) errEl.hidden = true;
    var curPw = curEl ? curEl.value : '';
    var newPw = newEl ? newEl.value : '';
    var cfmPw = cfmEl ? cfmEl.value : '';

    function showFlErr(msg) {
      if (!errEl) return;
      errEl.hidden = false;
      errEl.innerHTML = '<div class="alert alert--error"><span>' + esc(msg) + '</span></div>';
    }

    if (!curPw) {
      showFlErr('Please enter your current temporary password.');
      return;
    }
    if (newPw !== cfmPw) {
      showFlErr('The new password and confirmation password do not match.');
      return;
    }
    if (newPw === curPw) {
      showFlErr('Your new password must be different from your temporary password.');
      return;
    }
    MB.completeFirstLoginPassword(curPw, newPw).then(function (res) {
      if (!res || !res.ok) {
        showFlErr((res && res.error) || 'Could not update password.');
        return;
      }
      if (curEl) curEl.value = '';
      if (newEl) newEl.value = '';
      if (cfmEl) cfmEl.value = '';
      confirmSession().then(function () {
        flash('ok', 'Your permanent password has been saved. Welcome to the Mystery Bakebite dashboard.');
      });
    });
  }

  function doForgotPassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    var emEl = document.getElementById('forgot-email');
    var fbEl = document.getElementById('forgot-feedback');
    var em = emEl ? (emEl.value || '').trim() : '';
    if (fbEl) fbEl.hidden = true;
    MB.requestPasswordReset(em).then(function (res) {
      if (!fbEl) return;
      fbEl.hidden = false;
      var kind = res && res.ok ? 'ok' : 'error';
      var text = (res && (res.message || res.error)) || 'Recovery request processed.';
      fbEl.innerHTML = '<div class="alert alert--' + kind + '"><span>' + esc(text) + '</span></div>';
    });
  }

  /* ============================================================
     dashboard helpers: charts, trends, small formatting
     Everything is drawn from the figures the server computed, so a
     quiet week shows as a quiet week rather than a decorative shape.
     ============================================================ */
  var PALETTE = ['#D4A437', '#F7B7C8', '#E08A4C', '#8FD9A0', '#9C8BE0', '#7FA8C9', '#C9B27F'];

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function compactMoney(p) {
    if (typeof p !== 'number') return '';
    var c = p / 100;
    if (c >= 1000000) return 'GH\u20B5 ' + (c / 1000000).toFixed(1) + 'M';
    if (c >= 1000) return 'GH\u20B5 ' + (c / 1000).toFixed(c >= 10000 ? 0 : 1) + 'k';
    return 'GH\u20B5 ' + c.toLocaleString('en-GH', { maximumFractionDigits: 0 });
  }

  function ago(iso) {
    if (!iso) return '';
    var t = Date.parse(iso.indexOf('Z') === -1 ? iso + 'Z' : iso);
    if (isNaN(t)) return when(iso);
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return plural(hrs, 'hour') + ' ago';
    var days = Math.round(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return when(iso).slice(0, 10);
  }

  function deltaPill(k, days, moneyUnit) {
    if (k.pct === null || k.pct === undefined) {
      return '<span class="kpi-delta kpi-delta--flat">No earlier activity</span>';
    }
    var dir = k.pct > 0 ? 'up' : (k.pct < 0 ? 'down' : 'flat');
    var arrow = dir === 'up' ? '\u2197' : (dir === 'down' ? '\u2198' : '\u2192');
    var title = 'This period ' + (moneyUnit ? money(k.value) : k.value) +
      ', previous ' + days + ' days ' + (moneyUnit ? money(k.previous) : k.previous);
    // a jump from almost nothing produces a huge percentage, which reads as
    // noise, so a very small base is described with the amount instead
    var body = (moneyUnit && k.pct > 300 && k.previous > 0)
      ? '+' + money(k.value - k.previous)
      : (k.pct > 0 ? '+' : '') + k.pct + '%';
    return '<span class="kpi-delta kpi-delta--' + dir + '" title="' + esc(title) + '">' +
      arrow + ' ' + body + '</span>';
  }



  function sparkline(points, color) {
    var vals = (points || []).map(function (v) { return Number(v) || 0; });
    if (vals.length < 2) return '';
    var W = 120, H = 34, pad = 3;
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    if (max === 0) return '';   // nothing sold means no trend to draw
    var span = (max - min) || 1;
    var step = (W - pad * 2) / (vals.length - 1);
    var pts = vals.map(function (v, i) {
      return [pad + i * step, H - pad - ((v - min) / span) * (H - pad * 2)];
    });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var id = 'sp' + Math.random().toString(36).slice(2, 8);
    return '<svg class="stat-spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Trend across the period" preserveAspectRatio="none">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + color + '" stop-opacity=".34"/>' +
        '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + H + ' L' + pts[0][0].toFixed(1) + ' ' + H + ' Z" fill="url(#' + id + ')"/>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    '</svg>';
  }

  /* one area chart, measured in pixels so the dots stay round */
  function areaChart(series, metric, width) {
    var vals = series.map(function (s) { return metric === 'orders' ? s.orders : s.revenue; });
    var H = 180, padL = 4, padR = 8, padT = 12, padB = 14;
    var W = Math.max(width || 600, 260);
    var max = Math.max.apply(null, vals);
    var niceMax = 0;
    if (max > 0) {
      var pow = Math.pow(10, Math.floor(Math.log10(max)));
      niceMax = Math.ceil(max / (pow / 2)) * (pow / 2);
    } else {
      niceMax = 1;
    }
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var step = vals.length > 1 ? innerW / (vals.length - 1) : 0;
    var pts = vals.map(function (v, i) {
      return [padL + step * i, padT + innerH - (v / niceMax) * innerH];
    });

    function smooth(points) {
      if (points.length < 2) return '';
      var d = 'M' + points[0][0].toFixed(1) + ' ' + points[0][1].toFixed(1);
      for (var i = 0; i < points.length - 1; i++) {
        var p0 = points[i], p1 = points[i + 1];
        var cx = (p0[0] + p1[0]) / 2;
        d += ' C' + cx.toFixed(1) + ' ' + p0[1].toFixed(1) + ' ' + cx.toFixed(1) + ' ' + p1[1].toFixed(1) +
             ' ' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1);
      }
      return d;
    }

    var line = smooth(pts);
    var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (padT + innerH) +
               ' L' + pts[0][0].toFixed(1) + ' ' + (padT + innerH) + ' Z';
    var id = 'ac' + Math.random().toString(36).slice(2, 8);

    var grid = '';
    for (var g = 0; g < 4; g++) {
      var gy = (padT + (innerH / 3) * g).toFixed(1);
      grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy +
        '" stroke="rgba(245,230,214,.1)" stroke-dasharray="2 5"/>';
    }

    var dots = pts.map(function (p, i) {
      var label = series[i].label + ' ' + series[i].date.slice(5) + ': ' +
        (metric === 'orders' ? plural(series[i].orders, 'order') : money(series[i].revenue));
      return '<g><circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.4" fill="' +
        (metric === 'orders' ? '#F7B7C8' : '#E0B24C') + '" stroke="#2B1608" stroke-width="1.4"/>' +
        '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="11" fill="transparent">' +
        '<title>' + esc(label) + '</title></circle></g>';
    }).join('');

    return '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="' + (metric === 'orders' ? 'Orders' : 'Verified revenue') + ' per day">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + (metric === 'orders' ? '#F7B7C8' : '#E0B24C') + '" stop-opacity=".38"/>' +
        '<stop offset="100%" stop-color="' + (metric === 'orders' ? '#F7B7C8' : '#E0B24C') + '" stop-opacity=".02"/>' +
      '</linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#' + id + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + (metric === 'orders' ? '#F7B7C8' : '#E0B24C') +
        '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      dots +
    '</svg>';
  }

  function donut(slices, centreValue, centreLabel) {
    var total = slices.reduce(function (n, s) { return n + s.value; }, 0) || 1;
    var r = 54, C = 2 * Math.PI * r;
    var offset = 0;
    var rings = slices.map(function (s, i) {
      var frac = s.value / total;
      var dash = (frac * C).toFixed(2) + ' ' + C.toFixed(2);
      var el = '<circle cx="66" cy="66" r="' + r + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] +
        '" stroke-width="15" stroke-dasharray="' + dash + '" stroke-dashoffset="' + (-offset * C).toFixed(2) +
        '" stroke-linecap="butt"><title>' + esc(s.name + ': ' + s.pct + '%') + '</title></circle>';
      offset += frac;
      return el;
    }).join('');
    return '<svg viewBox="0 0 132 132" role="img" aria-label="Share of sales by category">' +
      '<circle cx="66" cy="66" r="' + r + '" fill="none" stroke="rgba(245,230,214,.09)" stroke-width="15"/>' +
      rings + '</svg>' +
      '<div class="donut__center"><b>' + esc(centreValue) + '</b><small>' + esc(centreLabel) + '</small></div>';
  }

  function panelShell(id, title, sub, body, extraClass, actions) {
    return '<section class="panel ' + (extraClass || '') + '"' + (id ? ' id="' + id + '"' : '') + '>' +
      '<div class="panel__head"><div><h2>' + esc(title) + '</h2>' +
        (sub ? '<p class="panel__sub">' + esc(sub) + '</p>' : '') + '</div>' +
        (actions || '') +
      '</div>' + body + '</section>';
  }

  function arrowIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  }

  function emptyRow(text) {
    return '<p class="panel__sub" style="margin:.2rem 0 0">' + esc(text) + '</p>';
  }

  /* ---------- overview ---------- */
  var CHART_SERIES = [];
  var chartObserver = null;

  function loadOverview(force) {
    var qs = '?days=' + state.days;
    api('/api/admin/dashboard' + qs).then(function (d) {
      if (!d.ok) return;
      state.dashboard = d;
      state.loadedAt.overview = Date.now();
      CHART_SERIES = d.series || [];

      var s = d.stats;
      document.getElementById('tab-orders-count').textContent = (s.toConfirm + s.proofsToReview) || '';
      paintChrome(d);
      renderOverview(d);
    }).catch(function () { });
  }

  /* the greeting, the summary line and the rail status, all from real counts */
  function paintChrome(d) {
    var k = d.kpis, s = d.stats;
    var bits = [];
    if (s.proofsToReview) bits.push(plural(s.proofsToReview, 'payment') + ' to verify');
    if (s.toConfirm) bits.push(plural(s.toConfirm, 'order') + ' waiting for confirmation');
    if (s.awaitingPayment) bits.push(plural(s.awaitingPayment, 'order') + ' awaiting payment');
    var line = bits.length ? bits.join(', ') + '.' : 'Nothing is waiting on you right now.';

    var el2 = document.getElementById('dash-summary');
    if (el2) el2.textContent = line;

    var railEl = document.getElementById('rail-channels');
    if (railEl && d.channels) {
      function dot(on) { return '<i class="' + (on ? 'on' : 'off') + '"></i>'; }
      railEl.innerHTML =
        dot(d.channels.momo) + 'Mobile Money<br>' +
        dot(d.channels.bank) + 'Bank transfer<br>' +
        dot(d.channels.cashDelivery || d.channels.cashPickup) + 'Cash on collection';
    }

    var bellDot = document.getElementById('bell-dot');
    if (bellDot) bellDot.hidden = !(s.proofsToReview + s.toConfirm);
  }

  function kpiCard(o) {
    return '<article class="stat-card">' +
      '<div class="stat-card__top">' +
        '<span class="stat-card__icon">' + o.icon + '</span>' + o.delta +
      '</div>' +
      '<span class="stat-card__label">' + esc(o.label) + '</span>' +
      '<b>' + o.value + '</b>' +
      '<small>' + esc(o.note) + '</small>' +
      (o.spark || '') +
    '</article>';
  }

  function icon(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' + paths + '</svg>';
  }

  function renderOverview(d) {
    var k = d.kpis, days = d.window.days;
    var pick = function (key) {
      return CHART_SERIES.map(function (day) { return day[key] || 0; });
    };

    var cards =
      kpiCard({
        icon: icon('<path d="M4 19V9M9.5 19V5M15 19v-6M20.5 19v-9"/>'),
        label: 'Verified revenue',
        value: money(k.revenue.value),
        note: 'Previous ' + days + ' days: ' + money(k.revenue.previous),
        delta: deltaPill(k.revenue, days, true),
        spark: sparkline(pick('revenue'), '#D4A437')
      }) +
      kpiCard({
        icon: icon('<path d="M5 8h14l-1.2 11.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8z"/><path d="M9 8V6.4A3 3 0 0 1 12 3.4a3 3 0 0 1 3 3V8"/>'),
        label: 'Orders and bookings',
        value: String(k.orders.value),
        note: 'New orders today: ' + d.stats.newToday,
        delta: deltaPill(k.orders, days, false),
        spark: sparkline(pick('orders'), '#F7B7C8')
      }) +
      kpiCard({
        icon: icon('<path d="M12 3.6 20 8v8l-8 4.4L4 16V8z"/><path d="M4 8l8 4.4L20 8"/>'),
        label: 'Items sold',
        value: String(k.units.value),
        note: 'Previous ' + days + ' days: ' + k.units.previous,
        delta: deltaPill(k.units, days, false),
        spark: sparkline(pick('units'), '#E08A4C')
      }) +
      kpiCard({
        icon: icon('<circle cx="12" cy="8.5" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
        label: 'New customers',
        value: String(k.newCustomers.value),
        note: d.customers.total + ' customers in total',
        delta: deltaPill(k.newCustomers, days, false),
        spark: sparkline(pick('newCustomers'), '#8FD9A0')
      });

    /* ---------- sales overview ---------- */
    var chartPanel =
      '<section class="panel col-8" id="sales-panel">' +
        '<div class="panel__head">' +
          '<div><h2>Sales overview</h2><p class="panel__sub">Verified revenue and order count, day by day</p></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
            '<div class="seg" role="group" aria-label="Chart metric">' +
              '<button type="button" data-metric="revenue" aria-pressed="' + (state.metric === 'revenue') + '">Revenue</button>' +
              '<button type="button" data-metric="orders" aria-pressed="' + (state.metric === 'orders') + '">Orders</button>' +
            '</div>' +
            '<div class="seg" role="group" aria-label="Date range">' +
              [7, 30, 90].map(function (n) {
                return '<button type="button" data-days="' + n + '" aria-pressed="' + (days === n) + '">' + n + 'd</button>';
              }).join('') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="chart-wrap">' +
          '<div class="chart-y" id="chart-y"></div>' +
          '<div class="chart-body" id="sales-chart-body"></div>' +
        '</div>' +
        '<details class="chart-table"><summary>View this chart as a table</summary>' +
          '<table><thead><tr><th>Day</th><th>Orders</th><th>Items</th><th>Verified revenue</th></tr></thead><tbody>' +
            CHART_SERIES.map(function (row) {
              return '<tr><td>' + esc(row.date) + '</td><td>' + row.orders + '</td><td>' + row.units +
                '</td><td>' + money(row.revenue) + '</td></tr>';
            }).join('') +
          '</tbody></table>' +
        '</details>' +
      '</section>';

    /* ---------- category split ---------- */
    var cats = d.categories || [];
    var catPanel = panelShell(null, 'Sales by category', 'Share of sales in the last ' + days + ' days',
      cats.length
        ? '<div class="donut-wrap">' +
            '<div class="donut">' +
              donut(cats.map(function (c) { return { name: c.name, value: c.revenue, pct: c.pct }; }),
                compactMoney(d.salesTotal), 'Total sales') +
            '</div>' +
            '<div class="legend">' +
              cats.map(function (c, i) {
                return '<div class="legend-row"><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' +
                  '<span title="' + esc(c.name) + '">' + esc(c.name) + '</span><b>' + c.pct + '%</b></div>';
              }).join('') +
            '</div>' +
          '</div>'
        : emptyRow('No sales in this period yet. Orders will appear here as they come in.'),
      'col-4');

    /* ---------- needs attention ---------- */
    var attention = d.attention || [];
    var attentionBody = attention.length
      ? '<div class="table-wrap"><table class="data"><thead><tr><th>Reference</th><th>Customer</th><th>Preferred Date</th><th>Total</th><th>Payment</th><th>Order</th><th></th></tr></thead><tbody>' +
          attention.map(function (o) {
            var pDate = o.event_date || o.eventDate || '';
            return '<tr><td class="mono">' + esc(o.ref) + '</td><td>' + esc(o.customer_name) + '</td>' +
              '<td>' + (pDate ? '<strong style="color:var(--caramel)">' + esc(formatOrderDate(pDate)) + '</strong>' : '<span style="color:rgba(245,230,214,.45)">\u2014</span>') + '</td>' +
              '<td>' + money(o.total) + '</td><td>' + payBadge(o.payment_status) + '</td><td>' + ordBadge(o.order_status) + '</td>' +
              '<td><button type="button" class="btn btn--ghost btn--sm" data-open-order="' + esc(o.ref) + '">Open</button></td></tr>';
          }).join('') +
        '</tbody></table></div>'
      : '<p class="panel__sub">Nothing is waiting. Every order is either confirmed or completed.</p>';

    var attentionPanel = panelShell(null, 'Needs attention',
      'Payments to verify and orders to confirm', attentionBody, 'col-8',
      '<button type="button" class="panel__link" data-goto="orders">All orders ' + arrowIcon() + '</button>');

    /* ---------- activity ---------- */
    var KIND_ICON = {
      created: '<path d="M12 5v14M5 12h14"/>',
      payment: '<path d="M20 6L9 17l-5-5"/>',
      status: '<path d="M4 12h16"/><path d="M14 6l6 6-6 6"/>',
      notified: '<path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5z"/>',
      discount: '<path d="M4 12 12 4l8 8-8 8z"/>',
      proof: '<path d="M12 16V4m0 0L8 8m4-4l4 4"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>'
    };
    var activity = d.activity || [];
    var activityPanel = panelShell(null, 'Recent activity', 'What has happened in the kitchen',
      activity.length
        ? '<ul class="feed">' + activity.slice(0, 7).map(function (a) {
            return '<li>' +
              '<span class="feed__dot">' + icon(KIND_ICON[a.kind] || '<circle cx="12" cy="12" r="4"/>') + '</span>' +
              '<span class="feed__text">' +
                (a.order_ref ? '<button type="button" class="feed__ref" data-open-order="' + esc(a.order_ref) + '">' + esc(a.order_ref) + '</button> ' : '') +
                esc(a.message) +
                '<span class="feed__time">' + esc(ago(a.at)) + (a.actor ? ' &middot; ' + esc(a.actor) : '') + '</span>' +
              '</span></li>';
          }).join('') + '</ul>'
        : emptyRow('No activity yet. Submitting an order starts the trail.'),
      'col-4');

    /* ---------- top products ---------- */
    var top = d.topProducts || [];
    var maxUnits = top.length ? Math.max.apply(null, top.map(function (p) { return p.units; })) : 1;
    var topPanel = panelShell(null, 'Top selling items', 'Units sold in the last ' + days + ' days',
      top.length
        ? '<div class="mini-list">' + top.map(function (p) {
            return '<div class="mini-row" style="grid-template-columns:minmax(0,1fr) auto">' +
              '<div><span class="mini-row__name">' + esc(p.name) + '</span>' +
                '<span class="mini-row__meta">' + plural(p.units, 'unit') + (p.custom ? ' &middot; custom cake' : '') + '</span>' +
                '<span class="mini-bar"><span style="--w:' + Math.round(p.units * 100 / maxUnits) + '%"></span></span>' +
              '</div>' +
              '<span class="mini-row__val">' + money(p.revenue) + '</span></div>';
          }).join('') + '</div>'
        : emptyRow('No product sales in this period.'),
      'col-4',
      '<button type="button" class="panel__link" data-goto="products">Catalogue ' + arrowIcon() + '</button>');

    /* ---------- classes ---------- */
    var cls = d.classes || {};
    var trackRows = Object.keys(cls.tracks || {}).map(function (t) {
      return '<div class="mini-row"><span class="mini-row__name">' + esc(label(t)) + ' track</span>' +
        '<span class="mini-row__val">' + plural(cls.tracks[t], 'booking') + '</span></div>';
    }).join('');
    var classPanel = panelShell(null, 'Classes and training',
      'Bookings in the last ' + days + ' days',
      '<div class="mini-list">' +
        '<div class="mini-row"><span class="mini-row__name">Class bookings</span><span class="mini-row__val">' + cls.bookings + '</span></div>' +
        '<div class="mini-row"><span class="mini-row__name">Class fees booked</span><span class="mini-row__val">' + money(cls.revenue) + '</span></div>' +
        trackRows +
        '<div class="mini-row"><span class="mini-row__name">Live courses</span><span class="mini-row__val">' + cls.published + '</span></div>' +
      '</div>',
      'col-4',
      '<button type="button" class="panel__link" data-goto="orders" data-kinds="class">Bookings ' + arrowIcon() + '</button>');

    /* ---------- customers ---------- */
    var cu = d.customers || { top: [] };
    var custPanel = panelShell(null, 'Customers', 'Spend shown is verified payment',
      '<div class="mini-list">' +
        '<div class="mini-row"><span class="mini-row__name">Customers</span><span class="mini-row__val">' + cu.total + '</span></div>' +
        '<div class="mini-row"><span class="mini-row__name">Repeat customers</span><span class="mini-row__val">' + cu.repeat + '</span></div>' +
        (cu.top || []).slice(0, 3).map(function (c) {
          return '<div class="mini-row"><div><span class="mini-row__name">' + esc(c.name) + '</span>' +
            '<span class="mini-row__meta">' + esc(c.phone) + ' &middot; ' + plural(c.orders, 'order') + '</span></div>' +
            '<span class="mini-row__val">' + money(c.spend) + '</span></div>';
        }).join('') +
      '</div>', 'col-4');

    /* ---------- channels + catalogue ---------- */
    function chip(on, text) {
      return '<span class="chip ' + (on ? 'is-on' : 'is-off') + '"><i></i>' + esc(text) + '</span>';
    }
    var cat = d.catalogue || {};
    var opsPanel = panelShell(null, 'Payment channels and catalogue',
      'What customers can choose today. Advance payment is required above ' + money(d.channels.threshold) +
      ', and both cash methods are locked above it.',
      '<div class="dash-strip">' +
        '<div class="dash-strip__chips">' +
          chip(d.channels.momo, 'Mobile Money') +
          chip(d.channels.bank, 'Bank transfer') +
          chip(d.channels.cashDelivery, 'Cash on delivery') +
          chip(d.channels.cashPickup, 'Cash on pickup') +
        '</div>' +
        '<div class="dash-strip__stats">' +
          '<span><b>' + cat.productsPublished + '</b>published products</span>' +
          '<span><b>' + cat.productsHidden + '</b>hidden</span>' +
          '<span><b>' + cat.quoteOnly + '</b>priced on request</span>' +
          '<span><b>' + cat.categories + '</b>live categories</span>' +
          '<span><b>' + cat.classesPublished + '</b>live classes</span>' +
        '</div>' +
      '</div>',
      'col-12',
      '<button type="button" class="panel__link" data-goto="payments">Payments ' + arrowIcon() + '</button>');

    /* ---------- quick actions ---------- */
    var quick = panelShell(null, 'Quick actions', 'Every button goes straight to the work',
      '<div class="quick-grid">' +
        '<button type="button" class="quick" data-goto="orders" data-payments="payment_submitted"><span>Verify proofs</span>' + arrowIcon() + '</button>' +
        '<button type="button" class="quick" data-goto="orders" data-status="submitted"><span>Confirm orders</span>' + arrowIcon() + '</button>' +
        '<button type="button" class="quick" data-goto="products"><span>Products and prices</span>' + arrowIcon() + '</button>' +
        '<button type="button" class="quick" data-goto="classes"><span>Classes and fees</span>' + arrowIcon() + '</button>' +
        '<button type="button" class="quick" data-goto="cake"><span>Cake pricing</span>' + arrowIcon() + '</button>' +
        '<button type="button" class="quick" data-goto="notifications"><span>WhatsApp alerts</span>' + arrowIcon() + '</button>' +
      '</div>', 'col-12');

    el.panels.overview.innerHTML =
      '<div class="stat-cards">' + cards + '</div>' +
      (d.paymentConfigured ? '' :
        '<div class="alert alert--warn" style="margin-bottom:1.2rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span><strong>No payment details are published.</strong> Customers can only choose cash until you add and verify Mobile Money or bank details in <a href="#" data-goto="payments" style="text-decoration:underline">Payments</a>.</span></div>') +
      '<div class="dash-grid">' +
        chartPanel + catPanel + attentionPanel + activityPanel +
        topPanel + classPanel + custPanel + opsPanel + quick +
      '</div>';

    paintChart();
    observeChart();
  }

  /* the chart is drawn after layout so the dots stay round at any width */
  function paintChart() {
    var host = document.getElementById('sales-chart-body');
    var yHost = document.getElementById('chart-y');
    if (!host || !CHART_SERIES.length) return;
    var width = host.clientWidth || 600;
    var metric = state.metric;
    var vals = CHART_SERIES.map(function (s) { return metric === 'orders' ? s.orders : s.revenue; });
    var max = Math.max.apply(null, vals);

    if (!max) {
      host.innerHTML = '<p class="chart-empty">No ' + (metric === 'orders' ? 'orders' : 'verified revenue') +
        ' in this window yet. It will appear here as orders come in.</p>';
      if (yHost) yHost.innerHTML = '<span>' + (metric === 'orders' ? '0' : 'GH\u20B5 0.00') + '</span>';
      return;
    }

    host.innerHTML = areaChart(CHART_SERIES, metric, width);
    var pow = max > 0 ? Math.pow(10, Math.floor(Math.log10(max))) : 1;
    var niceMax = max > 0 ? Math.ceil(max / (pow / 2)) * (pow / 2) : 1;
    var fmt = function (v) { return metric === 'orders' ? String(Math.round(v)) : compactMoney(v); };
    if (yHost) {
      yHost.innerHTML = [1, 2 / 3, 1 / 3, 0].map(function (f) {
        return '<span>' + esc(fmt(niceMax * f)) + '</span>';
      }).join('');
    }

    var every = CHART_SERIES.length > 30 ? 10 : (CHART_SERIES.length > 12 ? 3 : 1);
    var labels = CHART_SERIES.map(function (s, i) {
      if (i % every !== 0 && i !== CHART_SERIES.length - 1) return '<span></span>';
      return '<span>' + esc(CHART_SERIES.length > 12 ? s.date.slice(5).replace('-', '/') : s.label) + '</span>';
    }).join('');
    host.insertAdjacentHTML('beforeend', '<div class="chart-x">' + labels + '</div>');
  }

  function observeChart() {
    if (chartObserver || typeof ResizeObserver === 'undefined') return;
    var host = document.getElementById('sales-chart-body');
    if (!host) return;
    var last = host.clientWidth;
    chartObserver = new ResizeObserver(function () {
      var w = host.clientWidth;
      if (Math.abs(w - last) < 12) return;
      last = w;
      paintChart();
    });
    chartObserver.observe(host);
  }

  /* the percentage recorded on the order, so an old receipt and this screen agree */
  function bundleLabel(o) {
    var pct = window.mbBundlePct ? window.mbBundlePct(o.bundles) : '';
    return pct ? 'Bundle discount (' + pct + ')' : 'Bundle discount';
  }

  /* ---------- orders ---------- */
  function loadOrders() {
    var qs = [];
    if (state.filters.q) qs.push('q=' + encodeURIComponent(state.filters.q));
    if (state.filters.status) qs.push('status=' + state.filters.status);
    if (state.filters.payment) qs.push('payment=' + state.filters.payment);
    if (state.filters.kind) qs.push('kind=' + state.filters.kind);
    api('/api/admin/orders' + (qs.length ? '?' + qs.join('&') : '')).then(function (d) {
      state.orders = d.orders;
      state.loadedAt.orders = Date.now();
      renderOrders();
    });
  }

  function formatOrderDate(ymd) {
    if (MB && typeof MB.formatOrderDate === 'function') {
      return MB.formatOrderDate(ymd);
    }
    if (!ymd) return '';
    var s = String(ymd).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function renderOrders() {
    var rows = state.orders.map(function (o) {
      var fresh = o.order_status === 'submitted' ||
        (o.payment_status === 'payment_submitted');
      var prefDateRaw = o.event_date || o.eventDate || '';
      var prefDateHtml = prefDateRaw
        ? '<b style="color:var(--caramel)">' + esc(formatOrderDate(prefDateRaw)) + '</b><br><span class="mono" style="font-size:.7rem;color:rgba(245,230,214,.45)">' + esc(prefDateRaw) + '</span>'
        : '<span style="color:rgba(245,230,214,.45);font-size:.78rem">' + (o.kind === 'class' ? 'Class schedule' : 'Not specified') + '</span>';
      return '<tr' + (fresh ? ' class="is-fresh"' : '') + '>' +
        '<td class="mono">' + esc(o.ref) + '<br><span style="font-size:.72rem;color:rgba(245,230,214,.45)">' + esc(when(o.created_at)) + '</span></td>' +
        '<td>' + typeBadge(o.kind) + '</td>' +
        '<td><b>' + esc(o.customer_name) + '</b><br><span style="font-size:.78rem;color:rgba(245,230,214,.55)">' + esc(o.phone) + '</span></td>' +
        '<td>' + prefDateHtml + '</td>' +
        '<td><b>' + money(o.total) + '</b>' + (o.discount ? '<br><span style="font-size:.72rem;color:#9FD08A">\u2212' + money(o.discount) + '</span>' : '') + '</td>' +
        '<td>' + esc(o.kind === 'class' && o.payment_method === 'cash_on_pickup'
          ? 'Pay at first session' : label(o.payment_method)) + '</td>' +
        '<td>' + payBadge(o.payment_status) + '</td>' +
        '<td>' + ordBadge(o.order_status) + '</td>' +
        '<td><button type="button" class="btn btn--ghost btn--sm" data-open-order="' + esc(o.ref) + '">Open</button></td>' +
      '</tr>';
    }).join('');

    var q = escape(state.filters.q);
    el.panels.orders.innerHTML =
      '<section class="panel">' +
        '<div class="panel__head">' +
          '<div><h2>Orders and bookings</h2>' +
            '<p class="panel__sub">' + state.orders.length + ' transaction' + (state.orders.length === 1 ? '' : 's') + ' shown' +
              (state.filters.kind === 'product' ? ', product orders only' :
               state.filters.kind === 'class' ? ', class bookings only' : '') + '.</p></div>' +
          '<button type="button" class="panel__link" id="f-clear">Reset filters</button>' +
        '</div>' +
        '<div class="admin-toolbar">' +
          '<input type="search" id="f-q" placeholder="Search reference, name or phone" value="' + esc(state.filters.q) + '">' +
          '<select id="f-status" aria-label="Order status"><option value="">All statuses</option>' +
            Object.keys(ORD).map(function (k) { return '<option value="' + k + '"' + (state.filters.status === k ? ' selected' : '') + '>' + ORD[k][0] + '</option>'; }).join('') +
          '</select>' +
          '<select id="f-kind" aria-label="Transaction type"><option value="">Orders and bookings</option>' +
            '<option value="product"' + (state.filters.kind === 'product' ? ' selected' : '') + '>Product orders</option>' +
            '<option value="class"' + (state.filters.kind === 'class' ? ' selected' : '') + '>Class bookings</option>' +
          '</select>' +
          '<select id="f-payment" aria-label="Payment status"><option value="">All payment statuses</option>' +
            Object.keys(PAY).map(function (k) { return '<option value="' + k + '"' + (state.filters.payment === k ? ' selected' : '') + '>' + PAY[k][0] + '</option>'; }).join('') +
          '</select>' +
        '</div>' +
        (state.orders.length
          ? '<div class="table-wrap"><table class="data"><thead><tr><th>Reference</th><th>Type</th><th>Customer</th><th>Preferred Date</th><th>Total</th><th>Method</th><th>Payment</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<p class="panel__sub" style="padding:1.4rem 0">No orders match these filters. Clear the filters to see everything.</p>') +
      '</section>';

    var q = document.getElementById('f-q');
    var t;
    q.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        state.filters.q = q.value.trim();
        loadOrders();
      }, 300);
    });
    document.getElementById('f-status').addEventListener('change', function (e) {
      state.filters.status = e.target.value; loadOrders();
    });
    document.getElementById('f-payment').addEventListener('change', function (e) {
      state.filters.payment = e.target.value; loadOrders();
    });
    document.getElementById('f-kind').addEventListener('change', function (e) {
      state.filters.kind = e.target.value; loadOrders();
    });
    document.getElementById('f-clear').addEventListener('click', function () {
      state.filters = { q: '', status: '', payment: '', kind: '' };
      var dashQ = document.getElementById('dash-q');
      if (dashQ) dashQ.value = '';
      loadOrders();
    });
  }

  function openOrder(ref) {
    api('/api/admin/orders/' + encodeURIComponent(ref)).then(function (d) {
      if (!d.ok) return flash('error', esc(d.error));
      state.currentOrder = d.order;
      renderOrderModal(d.order);
    });
  }

  function methodLabel(o) {
    if (o.kind === 'class' && o.paymentMethod === 'cash_on_pickup') return 'Cash at first session';
    return label(o.paymentMethod);
  }

  function renderOrderModal(o) {
    var canVerify = o.paymentStatus !== 'payment_verified' && o.orderStatus !== 'cancelled';
    var nextStatuses = [];
    if (o.orderStatus === 'submitted') nextStatuses = ['confirmed', 'cancelled'];
    else if (o.orderStatus === 'confirmed') nextStatuses = ['in_preparation', 'cancelled'];
    else if (o.orderStatus === 'in_preparation') nextStatuses = ['completed', 'cancelled'];

    var prefDateRaw = o.eventDate || o.event_date || '';
    var prefDateText = prefDateRaw ? formatOrderDate(prefDateRaw) + ' (' + prefDateRaw + ')' : '';

    var items = o.items.map(function (i) {
      var prepDays = Number(i.prepDays) > 0 ? Math.round(Number(i.prepDays)) : 0;
      var prepBadge = prepDays > 0
        ? '<br><span class="prep-badge prep-badge--sm">Prep: at least ' + prepDays + ' ' + (prepDays === 1 ? 'day' : 'days') + ' ahead</span>'
        : '';
      return '<div class="kv"><span>' + esc(i.name) + ' &times; ' + i.qty +
        (i.meta ? '<br><span style="font-size:.75rem;color:rgba(245,230,214,.45)">' + esc(i.meta) + '</span>' : '') +
        prepBadge +
        '</span><b>' + money(i.lineTotal - (i.discount || 0)) + '</b></div>';
    }).join('');

    var proofs = o.hasProof
      ? '<img class="proof-img" id="proof-img" data-proof="' + esc(o.proofPath || '') + '" alt="Payment proof submitted by the customer">' +
        '<p class="form-note" id="proof-loading">Loading the screenshot\u2026</p>'
      : '<p class="panel__hint">No payment proof has been uploaded for this order.</p>';

    var notifs = (o.notifications || []).map(function (n) {
      var cls = n.status === 'sent' ? 'green' : (n.status === 'failed' ? 'red' : 'amber');
      return '<div class="event"><b>' + esc(n.channel) + ' notification</b> <span class="badge badge--' + cls + '">' + esc(n.status.replace(/_/g, ' ')) + '</span><br>' +
        esc(n.detail) + '<time>' + esc(when(n.created_at)) + '</time></div>';
    }).join('');

    var waText = (o.notifications || [])[0] ? (o.notifications[0].payload || '') : '';
    var waHref = waText ? 'https://wa.me/?text=' + encodeURIComponent(waText) : '';

    document.getElementById('admin-modal-body').innerHTML =
      '<h2 id="admin-modal-title" style="font-size:1.25rem;margin-bottom:.2rem">' + noun(o.kind) + ' <span class="mono">' + esc(o.ref) + '</span></h2>' +
      '<p class="panel__hint">Placed ' + esc(when(o.createdAt)) + ' &middot; ' + esc(o.customer.name) + ' &middot; ' + esc(o.customer.phone) +
        (o.customer.email ? ' &middot; ' + esc(o.customer.email) : '') +
        (prefDateText ? ' &middot; <strong style="color:var(--caramel)">Preferred Date: ' + esc(prefDateText) + '</strong>' : '') +
      '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1rem">' + payBadge(o.paymentStatus) + ordBadge(o.orderStatus) + '</div>' +

      (o.orderStatus === 'submitted' && o.paymentStatus === 'payment_submitted'
        ? '<div class="alert alert--warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span><strong>Payment under review.</strong> The customer has submitted payment details. Check the funds in the ' +
          (o.paymentMethod === 'bank_transfer' ? 'business bank account' : 'Mobile Money account') +
          ', then confirm or reject the payment.</span></div>'
        : (o.orderStatus === 'submitted' && o.paymentStatus === 'awaiting_payment'
            ? '<div class="alert alert--warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span>This customer is waiting to pay. Payment must be verified before you confirm the ' + (o.kind === 'class' ? 'booking' : 'order') + '.</span></div>'
            : '')) +

      '<div class="order-detail-grid">' +
        '<div>' +
          '<h4 style="font-size:var(--s-1);letter-spacing:.1em;text-transform:uppercase;color:rgba(245,230,214,.55);margin-bottom:.5rem">Items</h4>' +
          items +
          '<div class="kv" style="border:0"><span><b>Subtotal</b></span><b>' + money(o.subtotal) + '</b></div>' +
          (o.discount ? '<div class="kv" style="border:0;color:#9FD08A"><span>' + bundleLabel(o) + '</span><b>' + '\u2212 ' + money(o.discount) + '</b></div>' : '') +
          '<div class="kv" style="border-top:1px solid rgba(212,164,55,.4)"><span><b>Total</b></span><b style="color:var(--caramel);font-size:1.15rem">' + money(o.total) + '</b></div>' +
          (prefDateText ? '<div class="kv" style="border:0"><span>Preferred order date</span><b style="color:var(--caramel)">' + esc(prefDateText) + '</b></div>' : '') +
          '<div class="kv" style="border:0"><span>Method</span><b>' + esc(methodLabel(o)) + '</b></div>' +
          '<div class="kv" style="border:0"><span>Fulfilment</span><b>' + esc(label(o.fulfilment)) + (o.address ? '<br>' + esc(o.address) : '') + '</b></div>' +
          (o.paymentRef ? '<div class="kv" style="border:0"><span>Transaction reference</span><b class="mono">' + esc(o.paymentRef) + '</b></div>' : '') +
          (o.notes ? '<div class="kv" style="border:0"><span>Customer note</span><b>' + esc(o.notes) + '</b></div>' : '') +
        '</div>' +
        '<div>' +
          '<h4 style="font-size:var(--s-1);letter-spacing:.1em;text-transform:uppercase;color:rgba(245,230,214,.55);margin-bottom:.5rem">Payment proof</h4>' +
          (o.paymentRef
            ? '<div class="alert alert--info" style="margin-bottom:.8rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span>Customer reference: <strong class="mono">' + esc(o.paymentRef) + '</strong>. Check it against the Mobile Money or bank record before confirming.</span></div>'
            : '') +
          proofs +
          (o.paymentStatus === 'payment_rejected' && o.rejectReason
            ? '<p class="form-note" style="color:#F2C3B8">Rejected: ' + esc(o.rejectReason) + '</p>' : '') +
          (o.verifiedAt ? '<p class="form-note">Verified ' + esc(when(o.verifiedAt)) + '</p>' : '') +
        '</div>' +
      '</div>' +

      (canVerify
        ? '<div style="margin-top:1.2rem;padding-top:1.2rem;border-top:1px solid rgba(245,230,214,.14)">' +
            '<h4 style="font-size:var(--s-1);letter-spacing:.1em;text-transform:uppercase;color:rgba(245,230,214,.55);margin-bottom:.6rem">Verify this payment</h4>' +
            '<div class="field"><label for="verify-note">Note (required to reject &amp; unlock resubmission)</label>' +
              '<input type="text" id="verify-note" maxlength="300" placeholder="e.g. seen in statement, or why it does not match"></div>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
              '<button type="button" class="btn btn--gold btn--sm" data-verify="confirm">Confirm payment received</button>' +
              '<button type="button" class="btn btn--ghost btn--sm" data-verify="reject">Reject proof &amp; allow resubmission</button>' +
            '</div>' +
            '<p class="form-note">Only confirm after you have seen the money in your account, or after you have taken the cash. Confirming changes the receipt to <strong>Payment Confirmed</strong> and locks further payment submissions. Rejecting requires a note and unlocks a single corrected submission for the customer.</p>' +
          '</div>'
        : '') +

      (nextStatuses.length
        ? '<div style="margin-top:1.2rem;padding-top:1.2rem;border-top:1px solid rgba(245,230,214,.14)">' +
            '<h4 style="font-size:var(--s-1);letter-spacing:.1em;text-transform:uppercase;color:rgba(245,230,214,.55);margin-bottom:.6rem">Order status</h4>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
              nextStatuses.map(function (s) {
                return '<button type="button" class="btn btn--ghost btn--sm" data-status="' + s + '">' +
                  (s === 'cancelled' ? 'Cancel order' : 'Move to ' + ORD[s][0].toLowerCase()) + '</button>';
              }).join('') +
            '</div>' +
          '</div>'
        : '') +

      (notifs ? '<div style="margin-top:1.2rem;padding-top:1.2rem;border-top:1px solid rgba(245,230,214,.14)">' +
        '<h4 style="font-size:var(--s-1);letter-spacing:.1em;text-transform:uppercase;color:rgba(245,230,214,.55);margin-bottom:.5rem">Baker notification</h4>' +
        notifs + (waHref ? '<a class="btn btn--ghost btn--sm" href="' + waHref + '" target="_blank" rel="noopener" style="margin-top:.6rem">Open the message in WhatsApp</a>' : '') +
        '</div>' : '') +

      '<div style="margin-top:1.2rem;padding-top:1.2rem;border-top:1px solid rgba(245,230,214,.14)">' +
        '<h4 style="font-size:var(--s-1);letter-spacing:.1em;text-transform:uppercase;color:rgba(245,230,214,.55);margin-bottom:.5rem">History</h4>' +
        '<div class="event-list">' + (o.events || []).map(function (e) {
          return '<div class="event"><b>' + esc(e.kind) + '</b> ' + esc(e.message) + '<time>' + esc(when(e.at)) + ' \u00b7 ' + esc(e.actor) + '</time></div>';
        }).join('') + '</div>' +
      '</div>' +

      '<div style="display:flex;gap:8px;margin-top:1.4rem;flex-wrap:wrap">' +
        (o.kind !== 'class'
          ? '<button type="button" class="btn btn--glass btn--sm" data-download-receipt="' + esc(o.ref) + '">Download order receipt (PDF)</button>'
          : '') +
        '<button type="button" class="btn btn--ghost btn--sm" data-close-modal>Close</button>' +
      '</div>';

    document.getElementById('admin-modal').classList.add('is-open');
    document.body.style.overflow = 'hidden';

    var img = document.getElementById('proof-img');
    if (img) {
      var path = img.getAttribute('data-proof') || '';
      var note = document.getElementById('proof-loading');
      MB.proofUrl(path).then(function (url) {
        if (note && note.parentNode) note.parentNode.removeChild(note);
        if (url) img.src = url;
        else if (note) note.textContent = 'The screenshot could not be opened.';
      });
    }
  }

  /* Strictly for product orders only: downloads the A6 PDF receipt directly to the device */
  function adminReceipt(ref) {
    if (!ref || /^MC-/i.test(String(ref))) {
      flash('warn', 'Receipts are strictly available for product orders only.');
      return;
    }
    if (MB && typeof MB.downloadReceiptPdf === 'function') {
      MB.downloadReceiptPdf(ref, null, { admin: true });
    }
  }

  function verify(ref, action) {
    var note = (document.getElementById('verify-note') || {}).value || '';
    api('/api/admin/orders/' + encodeURIComponent(ref) + '/verify', {
      method: 'POST', body: { action: action, note: note }
    }).then(function (d) {
      if (!d.ok) return flash('error', esc(d.error));
      flash(action === 'confirm' ? 'ok' : 'warn',
        action === 'confirm' ? 'Payment verified. The receipt now shows Payment Verified.' : 'Proof rejected and the customer can resend.');
      renderOrderModal(d.order);
      loadOverview();
    });
  }

  function moveStatus(ref, status) {
    api('/api/admin/orders/' + encodeURIComponent(ref), {
      method: 'PATCH', body: { orderStatus: status }
    }).then(function (d) {
      if (!d.ok) return flash('error', esc(d.error));
      flash('ok', 'Order moved to ' + ORD[status][0].toLowerCase() + '.');
      renderOrderModal(d.order);
      loadOverview();
    });
  }

  /* ---------- products ---------- */
  function loadProducts() {
    api('/api/admin/catalogue').then(function (d) {
      state.catalogue = d;
      state.loadedAt.products = Date.now();
      renderProducts();
    });
  }

  function renderProducts() {
    var cats = state.catalogue.categories;
    var rows = [];
    cats.forEach(function (c) {
      rows.push('<tr><td colspan="9" style="background:rgba(212,164,55,.09);font-weight:700;color:var(--caramel);letter-spacing:.08em;text-transform:uppercase;font-size:.78rem">' +
        esc(c.name) + ' <span style="color:rgba(245,230,214,.45);letter-spacing:0;text-transform:none">(' + esc(c.slug) + ', ' + c.products.length + ')</span>' +
        '<span class="row-actions" style="float:right">' +
          '<button type="button" class="icon-btn" title="' + (c.published ? 'Hide category' : 'Publish category') + '" data-cat-publish="' + esc(c.slug) + '" data-published="' + (c.published ? '1' : '0') + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/></svg></button>' +
          '<button type="button" class="icon-btn" title="Delete category" data-cat-delete="' + esc(c.slug) + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>' +
        '</span></td></tr>');
      c.products.forEach(function (p) {
        var dPct = Number(p.discountPct) > 0 ? Math.round(Number(p.discountPct)) : 0;
        var prepDays = (p.prepDays !== undefined && p.prepDays !== null)
          ? Math.max(0, Math.round(Number(p.prepDays) || 0))
          : (MB && typeof MB.defaultPrepDaysForSku === 'function' ? MB.defaultPrepDaysForSku(p.sku, p.category) : 0);
        var safeImg = String(p.image || '').replace(/[^a-zA-Z0-9._-]/g, '');
        rows.push('<tr data-sku="' + esc(p.sku) + '">' +
          '<td><span class="prod-id">' +
            (safeImg ? '<img class="prod-thumb" src="assets/img/' + esc(safeImg) + '" alt="" loading="lazy">' : '') +
            '<span class="mono">' + esc(p.sku) + '</span></span></td>' +
          '<td><input type="text" class="tbl-input" data-field="name" value="' + esc(p.name) + '" style="width:100%"></td>' +
          '<td><input type="text" class="tbl-input tbl-price" data-field="price" value="' + (p.price === null ? '' : (p.price / 100).toFixed(2)) + '" placeholder="On request" inputmode="decimal"></td>' +
          '<td><input type="number" class="tbl-input tbl-price" data-field="discountPct" value="' + dPct + '" min="0" max="90" step="1" style="width:68px"></td>' +
          '<td><input type="number" class="tbl-input tbl-price" data-field="prepDays" value="' + prepDays + '" min="0" max="30" step="1" style="width:68px" title="Minimum advance preparation days required (0 = same-day, 1 = order at least 1 day ahead)"></td>' +
          '<td><input type="text" class="tbl-input" data-field="meta" value="' + esc(p.meta) + '" style="width:92px"></td>' +
          '<td><input type="text" class="tbl-input" data-field="image" value="' + esc(p.image || '') + '" placeholder="photo.webp" style="width:130px"></td>' +
          '<td><label class="switch"><input type="checkbox" data-field="published"' + (p.published ? ' checked' : '') + '><span>' + (p.published ? 'Live' : 'Hidden') + '</span></label></td>' +
          '<td><span class="row-actions">' +
            '<button type="button" class="btn btn--ghost btn--sm" data-save-product="' + esc(p.sku) + '">Save</button>' +
            '<button type="button" class="icon-btn" title="Delete product" data-del-product="' + esc(p.sku) + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>' +
          '</span></td>' +
        '</tr>');
      });
    });

    el.panels.products.innerHTML =
      '<div class="panel" style="margin-bottom:1rem">' +
        '<h2>Prices, advance preparation &amp; availability</h2>' +
        '<p class="panel__hint">Changes save straight to the catalogue and appear on the menu, the product page, the cart, checkout date validation, new orders and new receipts. Set <strong>Prep (days)</strong> to <code>1</code> (or more) for items that require advance ordering, or <code>0</code> for same-day availability.</p>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th>Display name</th><th>Price (GH&#8373;)</th><th>Disc (%)</th><th>Prep (days)</th><th>Size</th><th>Image</th><th>Status</th><th></th></tr></thead><tbody>' +
          rows.join('') + '</tbody></table></div>' +
        '<p class="form-note">Leave the price empty for items the baker quotes by hand. Prep (days) sets the minimum advance notice required at checkout.</p>' +
      '</div>' +

      '<div class="panel">' +
        '<h2>Add a product</h2>' +
        '<div class="field-row">' +
          '<div class="field"><label for="np-name">Name</label><input type="text" id="np-name" placeholder="e.g. Coconut bread, small"></div>' +
          '<div class="field"><label for="np-cat">Category</label><select id="np-cat">' +
            cats.map(function (c) { return '<option value="' + esc(c.slug) + '">' + esc(c.name) + '</option>'; }).join('') +
          '</select></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="np-price">Price (GH&#8373;)</label><input type="text" id="np-price" inputmode="decimal" placeholder="45"></div>' +
          '<div class="field"><label for="np-meta">Size or pack</label><input type="text" id="np-meta" placeholder="Small"></div>' +
          '<div class="field"><label for="np-prep">Advance prep (days)</label><input type="number" id="np-prep" min="0" max="30" step="1" value="1" placeholder="1"></div>' +
        '</div>' +
        '<div class="field"><label for="np-desc">Description</label><input type="text" id="np-desc" placeholder="Short description"></div>' +
        '<button type="button" class="btn btn--gold" id="np-add">Add product</button>' +
      '</div>' +
      '<div class="panel" style="margin-top:1rem">' +
        '<h2>Add a category</h2>' +
        '<div class="field-row">' +
          '<div class="field"><label for="nc-name">Category name</label><input type="text" id="nc-name" placeholder="e.g. Breads"></div>' +
          '<div class="field"><label for="nc-intro">One line description</label><input type="text" id="nc-intro" placeholder="Fresh loaves, baked to order."></div>' +
        '</div>' +
        '<button type="button" class="btn btn--ghost" id="nc-add">Add category</button>' +
      '</div>';

    el.panels.products.querySelectorAll('[data-save-product]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tr = btn.closest('tr');
        var sku = btn.getAttribute('data-save-product');
        var body = {};
        tr.querySelectorAll('[data-field]').forEach(function (input) {
          var f = input.getAttribute('data-field');
          if (f === 'published') body.published = input.checked;
          else if (f === 'price') body.price = input.value.trim() === '' ? null : Math.round(parseFloat(input.value) * 100);
          else if (f === 'discountPct') body.discountPct = Math.max(0, Math.min(90, Math.round(parseFloat(input.value) || 0)));
          else if (f === 'prepDays') body.prepDays = Math.max(0, Math.min(30, Math.round(parseFloat(input.value) || 0)));
          else body[f] = input.value;
        });
        if (body.price !== null && body.price !== undefined && isNaN(body.price)) {
          return flash('error', 'That price is not a number.');
        }
        api('/api/admin/products', { method: 'PATCH', body: Object.assign({ sku: sku }, body) })
          .then(function (d) {
            if (!d.ok) return flash('error', esc(d.error));
            flash('ok', 'Saved.');
            loadProducts();
          });
      });
    });

    el.panels.products.querySelectorAll('[data-del-product]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sku = btn.getAttribute('data-del-product');
        if (!confirm('Delete ' + sku + ' from the catalogue? Existing orders keep their copy of the item.')) return;
        api('/api/admin/products', { method: 'DELETE', body: { sku: sku } }).then(function (d) {
          if (!d.ok) return flash('error', esc(d.error));
          flash('warn', 'Product deleted.');
          loadProducts();
        });
      });
    });

    el.panels.products.querySelectorAll('[data-cat-publish]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-cat-publish');
        var next = btn.getAttribute('data-published') !== '1';
        api('/api/admin/categories', { method: 'PATCH', body: { slug: slug, published: next } })
          .then(function (d) {
            if (!d.ok) return flash('error', esc(d.error));
            flash('ok', next ? 'Category published.' : 'Category hidden from the site.');
            loadProducts();
          });
      });
    });

    el.panels.products.querySelectorAll('[data-cat-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-cat-delete');
        if (!confirm('Delete the category ' + slug + '?')) return;
        api('/api/admin/categories', { method: 'DELETE', body: { slug: slug } })
          .then(function (d) {
            if (!d.ok) return flash('error', esc(d.error));
            flash('warn', 'Category deleted.');
            loadProducts();
          });
      });
    });

    document.getElementById('np-add').addEventListener('click', function () {
      var price = document.getElementById('np-price').value.trim();
      var prepEl = document.getElementById('np-prep');
      var prepVal = prepEl ? Math.max(0, Math.min(30, Math.round(parseFloat(prepEl.value) || 0))) : 0;
      api('/api/admin/products', {
        method: 'POST',
        body: {
          name: document.getElementById('np-name').value.trim(),
          category: document.getElementById('np-cat').value,
          price: price === '' ? null : Math.round(parseFloat(price) * 100),
          prepDays: prepVal,
          meta: document.getElementById('np-meta').value.trim(),
          description: document.getElementById('np-desc').value.trim()
        }
      }).then(function (d) {
        if (!d.ok) return flash('error', esc(d.error));
        flash('ok', 'Product added and live.');
        loadProducts();
      });
    });

    document.getElementById('nc-add').addEventListener('click', function () {
      api('/api/admin/categories', {
        method: 'POST',
        body: {
          name: document.getElementById('nc-name').value.trim(),
          intro: document.getElementById('nc-intro').value.trim()
        }
      }).then(function (d) {
        if (!d.ok) return flash('error', esc(d.error));
        flash('ok', 'Category added.');
        loadProducts();
      });
    });
  }

  /* ---------- classes ---------- */
  function loadClasses() {
    api('/api/admin/catalogue').then(function (d) {
      state.catalogue = d;
      state.loadedAt.classes = Date.now();
      renderClasses();
    });
  }

  function renderClasses() {
    var rows = state.catalogue.classes.map(function (c) {
      return '<tr data-slug="' + esc(c.slug) + '">' +
        '<td><b>' + esc(c.name) + '</b><br><span class="mono" style="color:rgba(245,230,214,.4)">' + esc(c.slug) + '</span></td>' +
        '<td>' + esc(c.track) + ' \u00b7 ' + esc(c.levelLabel) + '</td>' +
        '<td><input type="text" class="tbl-input tbl-price" data-field="fee" value="' + (c.fee / 100).toFixed(2) + '" inputmode="decimal"></td>' +
        '<td><input type="text" class="tbl-input" data-field="hours" value="' + esc(c.hours) + '" style="width:90px"></td>' +
        '<td><label class="switch"><input type="checkbox" data-field="published"' + (c.published ? ' checked' : '') + '><span>' + (c.published ? 'Live' : 'Hidden') + '</span></label></td>' +
        '<td><span class="row-actions">' +
          '<button type="button" class="btn btn--ghost btn--sm" data-save-class="' + esc(c.slug) + '">Save</button>' +
          '<button type="button" class="icon-btn" title="Delete class" data-del-class="' + esc(c.slug) + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>' +
        '</span></td>' +
      '</tr>';
    }).join('');

    el.panels.classes.innerHTML =
      '<div class="panel">' +
        '<h2>Course fees</h2>' +
        '<p class="panel__hint">The fee feeds the class card, the booking summary, the bundle discount, the cart and every receipt. Bundle percentages live in the Payments tab.</p>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Course</th><th>Track</th><th>Fee (GH&#8373;)</th><th>Duration</th><th>Status</th><th></th></tr></thead><tbody>' +
          rows + '</tbody></table></div>' +
      '</div>' +

      '<div class="panel" style="margin-top:1rem">' +
        '<h2>Add a course</h2>' +
        '<p class="panel__hint">New courses appear on the classes page and in the booking summary as soon as they are saved.</p>' +
        '<div class="field-row">' +
          '<div class="field"><label for="nc2-name">Course name</label><input type="text" id="nc2-name" placeholder="e.g. Bread Level 4"></div>' +
          '<div class="field"><label for="nc2-track">Track</label><select id="nc2-track"><option value="bread">Bread</option><option value="pastry">Pastry</option></select></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="nc2-level">Level</label><select id="nc2-level">' +
            '<option value="1">Level 1, beginner</option><option value="2">Level 2, intermediate</option><option value="3">Level 3, advanced</option></select></div>' +
          '<div class="field"><label for="nc2-fee">Fee (GH&#8373;)</label><input type="text" id="nc2-fee" inputmode="decimal" placeholder="750"></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="nc2-hours">Duration</label><input type="text" id="nc2-hours" placeholder="One week, Monday to Friday"></div>' +
          '<div class="field"><label for="nc2-sum">One line summary</label><input type="text" id="nc2-sum" placeholder="What the course covers"></div>' +
        '</div>' +
        '<button type="button" class="btn btn--gold" id="nc2-add">Add course</button>' +
      '</div>';

    el.panels.classes.querySelectorAll('[data-del-class]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-del-class');
        if (!confirm('Delete this course? Bookings already placed keep their copy.')) return;
        api('/api/admin/classes', { method: 'DELETE', body: { slug: slug } }).then(function (d) {
          if (!d.ok) return flash('error', esc(d.error));
          flash('warn', 'Course deleted.');
          loadClasses();
        });
      });
    });

    document.getElementById('nc2-add').addEventListener('click', function () {
      var fee = Math.round(parseFloat(document.getElementById('nc2-fee').value) * 100);
      if (isNaN(fee)) return flash('error', 'Enter the course fee as a number.');
      var level = document.getElementById('nc2-level').value;
      api('/api/admin/classes', {
        method: 'POST',
        body: {
          name: document.getElementById('nc2-name').value.trim(),
          track: document.getElementById('nc2-track').value,
          level: level,
          levelLabel: ['', 'Beginner', 'Intermediate', 'Advanced'][Number(level)],
          fee: fee,
          hours: document.getElementById('nc2-hours').value.trim(),
          summary: document.getElementById('nc2-sum').value.trim(),
          description: document.getElementById('nc2-sum').value.trim(),
          published: true
        }
      }).then(function (d) {
        if (!d.ok) return flash('error', esc(d.error));
        flash('ok', 'Course added.');
        loadClasses();
      });
    });

    el.panels.classes.querySelectorAll('[data-save-class]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tr = btn.closest('tr');
        var slug = btn.getAttribute('data-save-class');
        var fee = Math.round(parseFloat(tr.querySelector('[data-field="fee"]').value) * 100);
        if (isNaN(fee)) return flash('error', 'That fee is not a number.');
        api('/api/admin/classes', {
          method: 'PATCH',
          body: {
            slug: slug,
            fee: fee,
            hours: tr.querySelector('[data-field="hours"]').value,
            published: tr.querySelector('[data-field="published"]').checked
          }
        }).then(function (d) {
          if (!d.ok) return flash('error', esc(d.error));
          flash('ok', 'Course updated.');
          loadClasses();
        });
      });
    });
  }

  /* ---------- cake pricing ---------- */
  function loadCake() {
    api('/api/admin/catalogue').then(function (d) {
      state.catalogue = d;
      state.loadedAt.cake = Date.now();
      renderCake();
    });
  }

  function renderCake() {
    var o = state.catalogue.options;

    function group(title, kind, note, priceLabel) {
      return '<div class="panel" style="margin-bottom:1rem">' +
        '<h2>' + esc(title) + '</h2>' +
        '<p class="panel__hint">' + esc(note) + '</p>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Option</th><th>' + esc(priceLabel) + ' (GH&#8373;)</th><th></th></tr></thead><tbody>' +
        o[kind].map(function (item) {
          var val = '';
          if (kind === 'decor') {
            val = Object.keys(item.charges).map(function (k) { return k + ':' + (item.charges[k] / 100).toFixed(2); }).join(', ');
          } else if (kind === 'flavour') {
            val = item.priceMax ? '' : (item.extra / 100).toFixed(2);
          } else {
            val = item.price === null ? '' : (item.price / 100).toFixed(2);
          }
          return '<tr data-kind="' + kind + '" data-key="' + esc(item.key) + '">' +
            '<td><b>' + esc(item.label) + '</b>' + (item.priceMax ? '<br><span style="font-size:.72rem;color:#F0D9A6">Range, confirmed by baker</span>' : '') + '</td>' +
            '<td><input type="text" class="tbl-input tbl-price" data-field="price" value="' + val + '" ' +
              (kind === 'decor' ? 'placeholder="5:150, 6:220, ..." style="width:220px;max-width:none"' : '') + '></td>' +
            '<td><button type="button" class="btn btn--ghost btn--sm" data-save-option="1">Save</button></td>' +
          '</tr>';
        }).join('') + '</tbody></table></div></div>';
    }

    el.panels.cake.innerHTML =
      group('Cake sizes', 'size', 'Base price per size at the basic decoration level.', 'Price') +
      group('Decoration levels', 'decor', 'Price per size, written as size:price pairs. These override the base price.', 'Charges') +
      group('Flavours', 'flavour', 'Upcharge added to the cake price. Leave empty where the baker quotes by hand.', 'Upcharge') +
      group('Add-ons', 'addon', 'Extra charges for finishing touches. Leave empty for range-priced items.', 'Price') +
      group('Celebration varieties', 'variety', 'The documented "from" prices for the fourteen celebration cakes.', 'From') +
      group('Tiers', 'tier', 'Two and three tier cakes are quoted; the documented starting price is shown.', 'From');

    el.panels.cake.querySelectorAll('[data-save-option]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tr = btn.closest('tr');
        var kind = tr.getAttribute('data-kind');
        var key = tr.getAttribute('data-key');
        var raw = tr.querySelector('[data-field="price"]').value.trim();
        var body = { kind: kind, key: key };

        if (kind === 'decor') {
          var charges = {};
          raw.split(',').forEach(function (pair) {
            var bits = pair.split(':');
            if (bits.length === 2) {
              var p = Math.round(parseFloat(bits[1]) * 100);
              if (!isNaN(p)) charges[bits[0].trim()] = p;
            }
          });
          if (!Object.keys(charges).length) return flash('error', 'Use pairs such as 6:220, 8:350.');
          body.charges = charges;
        } else if (kind === 'flavour') {
          body.extra = raw === '' ? 0 : Math.round(parseFloat(raw) * 100);
          if (isNaN(body.extra)) return flash('error', 'That is not a number.');
        } else {
          body.price = raw === '' ? null : Math.round(parseFloat(raw) * 100);
          if (body.price !== null && isNaN(body.price)) return flash('error', 'That is not a number.');
        }

        api('/api/admin/options', { method: 'PATCH', body: body }).then(function (d) {
          if (!d.ok) return flash('error', esc(d.error));
          flash('ok', 'Cake pricing updated.');
        });
      });
    });
  }

  /* ---------- discounts (products + 2+ classes) ---------- */
  function loadDiscounts() {
    api('/api/admin/catalogue').then(function (d) {
      state.catalogue = d;
      state.loadedAt.discounts = Date.now();
      renderDiscounts();
    });
  }

  function renderDiscounts() {
    if (!el.panels.discounts || !state.catalogue) return;
    var cats = state.catalogue.categories || [];
    var allProds = state.catalogue.products || [];
    var classes = state.catalogue.classes || [];
    var settings = state.catalogue.settings || {};
    var twoPct = Number(settings.bundle_two_pct);
    var threePct = Number(settings.bundle_three_pct);
    if (!isFinite(twoPct)) twoPct = 15;
    if (!isFinite(threePct)) threePct = 25;

    var discountedCount = allProds.filter(function (p) { return (Number(p.discountPct) || 0) > 0; }).length;
    var badgeEl = document.getElementById('tab-discounts-count');
    if (badgeEl) badgeEl.textContent = discountedCount > 0 ? String(discountedCount) : '';

    var fee1 = (classes[0] && classes[0].fee) || 150000;
    var fee2 = fee1 + ((classes[1] && classes[1].fee) || 220000);
    var fee3 = fee2 + ((classes[2] && classes[2].fee) || 300000);

    function classPreviewRows(p2, p3) {
      var cut2 = Math.round(fee2 * p2 / 100);
      var cut3 = Math.round(fee3 * p3 / 100);
      return '' +
        '<tr>' +
          '<td><b>1 Class</b> <span style="color:rgba(245,230,214,.55)">(Single course)</span></td>' +
          '<td>' + money(fee1) + '</td>' +
          '<td><span class="badge badge--grey">0% (Requires 2+ classes)</span></td>' +
          '<td>' + money(0) + '</td>' +
          '<td><b>' + money(fee1) + '</b></td>' +
        '</tr>' +
        '<tr>' +
          '<td><b>2 Classes</b> <span style="color:rgba(245,230,214,.55)">(e.g. Beginner + Intermediate)</span></td>' +
          '<td>' + money(fee2) + '</td>' +
          '<td><span class="badge badge--amber">' + p2 + '% off</span></td>' +
          '<td style="color:#E7B96F">\u2212 ' + money(cut2) + '</td>' +
          '<td><b>' + money(fee2 - cut2) + '</b></td>' +
        '</tr>' +
        '<tr>' +
          '<td><b>3 or More Classes</b> <span style="color:rgba(245,230,214,.55)">(e.g. Full 3-Level Track)</span></td>' +
          '<td>' + money(fee3) + '</td>' +
          '<td><span class="badge badge--green">' + p3 + '% off</span></td>' +
          '<td style="color:#E7B96F">\u2212 ' + money(cut3) + '</td>' +
          '<td><b>' + money(fee3 - cut3) + '</b></td>' +
        '</tr>';
    }

    var targetOptions = '<option value="all">All bakery products &amp; celebration cakes (' + allProds.length + ' items)</option>' +
      '<optgroup label="By Category">' +
      cats.map(function (c) {
        return '<option value="cat:' + esc(c.slug) + '">Category: ' + esc(c.name) + ' (' + c.products.length + ' items)</option>';
      }).join('') +
      '</optgroup>' +
      '<optgroup label="Individual Product">' +
      allProds.map(function (p) {
        var cur = Number(p.discountPct) > 0 ? ' [' + Math.round(p.discountPct) + '% off]' : '';
        return '<option value="sku:' + esc(p.sku) + '">' + esc(p.name) + ' (' + money(p.price) + ')' + cur + '</option>';
      }).join('') +
      '</optgroup>';

    var prodRows = [];
    cats.forEach(function (c) {
      prodRows.push('<tr><td colspan="5" style="background:rgba(212,164,55,.09);font-weight:700;color:var(--caramel);letter-spacing:.08em;text-transform:uppercase;font-size:.78rem">' +
        esc(c.name) + ' <span style="color:rgba(245,230,214,.45);letter-spacing:0;text-transform:none">(' + c.products.length + ' items)</span></td></tr>');
      c.products.forEach(function (p) {
        var pct = Number(p.discountPct) > 0 ? Math.round(Number(p.discountPct)) : 0;
        var base = typeof p.price === 'number' ? p.price : 0;
        var cut = Math.round(base * pct / 100);
        var net = base - cut;
        prodRows.push('<tr data-disc-row="' + esc(p.sku) + '" data-base-price="' + base + '">' +
          '<td><span class="prod-id">' +
            (p.image ? '<img class="prod-thumb" src="assets/img/' + esc(p.image) + '" alt="" loading="lazy">' : '') +
            '<span><b>' + esc(p.name) + '</b><br><span class="mono" style="color:rgba(245,230,214,.45);font-size:.75rem">' + esc(p.sku) + (p.meta ? ' \u00b7 ' + esc(p.meta) : '') + '</span></span>' +
          '</span></td>' +
          '<td class="mono">' + money(base) + '</td>' +
          '<td><div style="display:flex;align-items:center;gap:6px">' +
            '<input type="number" class="tbl-input tbl-price" data-disc-sku="' + esc(p.sku) + '" value="' + pct + '" min="0" max="90" step="1" style="width:76px">' +
            '<span style="color:rgba(245,230,214,.6)">%</span>' +
          '</div></td>' +
          '<td data-disc-preview="' + esc(p.sku) + '">' +
            (pct > 0
              ? '<b>' + money(net) + '</b> <span class="badge badge--green" style="margin-left:6px">\u2212' + pct + '% (Saves ' + money(cut) + ')</span>'
              : '<span style="color:rgba(245,230,214,.55)">' + money(base) + ' (No discount)</span>') +
          '</td>' +
          '<td style="text-align:right"><button type="button" class="btn btn--ghost btn--sm" data-save-one-disc="' + esc(p.sku) + '">Save</button></td>' +
        '</tr>');
      });
    });

    el.panels.discounts.innerHTML =
      '<div class="admin-head">' +
        '<div>' +
          '<h1 class="admin-head__title">Discounts &amp; Bundle Promotions</h1>' +
          '<p class="admin-head__sub">Apply percentage discounts to products and to baking classes (only when 2 or more classes are booked). Saved changes update immediately across the entire website.</p>' +
        '</div>' +
      '</div>' +

      /* 1. Classes Bundle Discounts (2 or more classes only) */
      '<div class="panel" style="margin-bottom:1.2rem">' +
        '<h2>1. Baking Classes Discounts (2 or More Classes Only)</h2>' +
        '<p class="panel__hint">Single-class bookings (1 class) always carry a <strong>0% discount</strong>. When a student selects <strong>2 classes</strong> or <strong>3 or more classes</strong>, these bundle discount percentages are applied automatically on the Classes page, Slide-Out Cart, Booking Checkout, Order Status and Receipt.</p>' +
        '<div class="field-row" style="margin-top:.9rem">' +
          '<div class="field">' +
            '<label for="disc-class-two">2 Classes Bundle Discount (%)</label>' +
            '<input type="number" id="disc-class-two" value="' + twoPct + '" min="0" max="60" step="1">' +
          '</div>' +
          '<div class="field">' +
            '<label for="disc-class-three">3 or More Classes Bundle Discount (%)</label>' +
            '<input type="number" id="disc-class-three" value="' + threePct + '" min="0" max="75" step="1">' +
          '</div>' +
        '</div>' +
        '<div class="table-wrap" style="margin:1rem 0">' +
          '<table class="data">' +
            '<thead><tr><th>Booking Size</th><th>Original Course Total</th><th>Discount Applied</th><th>Student Saves</th><th>Total Payable</th></tr></thead>' +
            '<tbody id="disc-class-preview-body">' + classPreviewRows(twoPct, threePct) + '</tbody>' +
          '</table>' +
        '</div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<button type="button" class="btn btn--gold" id="disc-save-classes">Save class bundle discounts</button>' +
          '<span class="form-note" style="margin:0" id="disc-class-saved-note">' + bundleNote(settings) + '</span>' +
        '</div>' +
      '</div>' +

      /* 2. Quick Apply Product / Category Discount */
      '<div class="panel" style="margin-bottom:1.2rem">' +
        '<h2>2. Quick Apply Product Discount</h2>' +
        '<p class="panel__hint">Select a single product, a category, or all products, set a discount percentage (0%–90%), and click <strong>Apply &amp; save discount</strong> to update prices across the Menu, Products page, Custom Cake Builder, Cart and Checkout.</p>' +
        '<div class="field-row" style="margin-top:.9rem">' +
          '<div class="field">' +
            '<label for="disc-target">Target product or category</label>' +
            '<select id="disc-target">' + targetOptions + '</select>' +
          '</div>' +
          '<div class="field">' +
            '<label for="disc-quick-pct">Discount percentage (%)</label>' +
            '<input type="number" id="disc-quick-pct" value="10" min="0" max="90" step="1" placeholder="e.g. 10">' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:.4rem">' +
          '<button type="button" class="btn btn--gold" id="disc-apply-quick">Apply &amp; save discount</button>' +
          '<button type="button" class="btn btn--ghost" id="disc-clear-all">Clear all product discounts (0%)</button>' +
        '</div>' +
      '</div>' +

      /* 3. Per-Product Discount Table */
      '<div class="panel">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:.8rem">' +
          '<div>' +
            '<h2 style="margin-bottom:.2rem">3. Per-Product Discount Schedule (' + discountedCount + ' active)</h2>' +
            '<p class="panel__hint" style="margin:0">Adjust individual product discount percentages below. Set to 0% to remove a discount.</p>' +
          '</div>' +
          '<button type="button" class="btn btn--gold btn--sm" id="disc-save-all-products">Save all product discounts</button>' +
        '</div>' +
        '<div class="table-wrap">' +
          '<table class="data">' +
            '<thead><tr><th>Product</th><th>Original Price</th><th>Discount (%)</th><th>Live Website Price &amp; Saving</th><th style="text-align:right">Action</th></tr></thead>' +
            '<tbody>' + prodRows.join('') + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';

    /* Live preview for class bundle inputs */
    var twoInput = document.getElementById('disc-class-two');
    var threeInput = document.getElementById('disc-class-three');
    function updateClassPreview() {
      var p2 = Math.max(0, Math.min(90, Math.round(Number(twoInput.value) || 0)));
      var p3 = Math.max(0, Math.min(90, Math.round(Number(threeInput.value) || 0)));
      var tbody = document.getElementById('disc-class-preview-body');
      if (tbody) tbody.innerHTML = classPreviewRows(p2, p3);
    }
    twoInput.addEventListener('input', updateClassPreview);
    threeInput.addEventListener('input', updateClassPreview);

    /* Save class bundle discounts */
    document.getElementById('disc-save-classes').addEventListener('click', function () {
      var p2 = Math.max(0, Math.min(90, Math.round(Number(twoInput.value) || 0)));
      var p3 = Math.max(0, Math.min(90, Math.round(Number(threeInput.value) || 0)));
      api('/api/admin/discounts', {
        method: 'POST',
        body: { bundle_two_pct: p2, bundle_three_pct: p3 }
      }).then(function (d) {
        if (!d || !d.ok) return flash('error', esc((d && d.error) || 'Could not save class bundle discounts.'));
        state.loadedAt = {};
        flash('ok', 'Class bundle discounts saved (' + p2 + '% for 2 classes, ' + p3 + '% for 3+ classes). Updated across the website.');
        loadDiscounts();
      });
    });

    /* Quick-apply product/category discount */
    document.getElementById('disc-apply-quick').addEventListener('click', function () {
      var target = document.getElementById('disc-target').value;
      var pct = Math.max(0, Math.min(90, Math.round(Number(document.getElementById('disc-quick-pct').value) || 0)));
      var payload = { discountPct: pct };
      if (target === 'all') {
        payload.category = 'all';
      } else if (target.indexOf('cat:') === 0) {
        payload.category = target.slice(4);
      } else if (target.indexOf('sku:') === 0) {
        payload.sku = target.slice(4);
      }
      api('/api/admin/discounts', { method: 'POST', body: payload }).then(function (d) {
        if (!d || !d.ok) return flash('error', esc((d && d.error) || 'Could not apply discount.'));
        state.loadedAt = {};
        flash('ok', 'Applied ' + pct + '% discount and updated prices across the website.');
        loadDiscounts();
      });
    });

    /* Clear all product discounts */
    document.getElementById('disc-clear-all').addEventListener('click', function () {
      api('/api/admin/discounts', { method: 'POST', body: { clearAll: true } }).then(function (d) {
        if (!d || !d.ok) return flash('error', esc((d && d.error) || 'Could not clear product discounts.'));
        state.loadedAt = {};
        flash('warn', 'All product discounts cleared to 0%.');
        loadDiscounts();
      });
    });

    /* Live preview when typing in per-product discount inputs */
    el.panels.discounts.querySelectorAll('[data-disc-sku]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var sku = inp.getAttribute('data-disc-sku');
        var tr = inp.closest('tr');
        var base = Number(tr.getAttribute('data-base-price')) || 0;
        var pct = Math.max(0, Math.min(90, Math.round(Number(inp.value) || 0)));
        var cut = Math.round(base * pct / 100);
        var net = base - cut;
        var cell = el.panels.discounts.querySelector('[data-disc-preview="' + sku + '"]');
        if (cell) {
          cell.innerHTML = pct > 0
            ? '<b>' + money(net) + '</b> <span class="badge badge--green" style="margin-left:6px">\u2212' + pct + '% (Saves ' + money(cut) + ')</span>'
            : '<span style="color:rgba(245,230,214,.55)">' + money(base) + ' (No discount)</span>';
        }
      });
    });

    /* Save single product discount */
    el.panels.discounts.querySelectorAll('[data-save-one-disc]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sku = btn.getAttribute('data-save-one-disc');
        var inp = el.panels.discounts.querySelector('[data-disc-sku="' + sku + '"]');
        var pct = Math.max(0, Math.min(90, Math.round(Number(inp && inp.value) || 0)));
        api('/api/admin/discounts', { method: 'POST', body: { sku: sku, discountPct: pct } }).then(function (d) {
          if (!d || !d.ok) return flash('error', esc((d && d.error) || 'Could not save product discount.'));
          state.loadedAt = {};
          flash('ok', 'Saved ' + pct + '% discount for ' + esc(sku) + '. Live across the website.');
          loadDiscounts();
        });
      });
    });

    /* Save all product discounts */
    document.getElementById('disc-save-all-products').addEventListener('click', function () {
      var map = {};
      el.panels.discounts.querySelectorAll('[data-disc-sku]').forEach(function (inp) {
        var sku = inp.getAttribute('data-disc-sku');
        map[sku] = Math.max(0, Math.min(90, Math.round(Number(inp.value) || 0)));
      });
      api('/api/admin/discounts', { method: 'POST', body: { products: map } }).then(function (d) {
        if (!d || !d.ok) return flash('error', esc((d && d.error) || 'Could not save product discounts.'));
        state.loadedAt = {};
        flash('ok', 'All product discount percentages saved and updated across the website.');
        loadDiscounts();
      });
    });
  }

  /* ---------- notifications ---------- */
  function loadNotifications() {
    api('/api/admin/notifications').then(function (d) {
      var pending = d.notifications.filter(function (n) { return n.status !== 'sent'; }).length;
      document.getElementById('tab-notif-count').textContent = pending || '';
      state.loadedAt.notifications = Date.now();
      var rows = d.notifications.map(function (n) {
        var cls = n.status === 'sent' ? 'green' : (n.status === 'failed' ? 'red' : 'amber');
        var label = n.status === 'queued_no_credentials' ? 'Not sent, Cloud API not configured'
          : (n.status === 'sent' ? 'Sent by the Cloud API' : n.status.replace(/_/g, ' '));
        return '<tr>' +
          '<td class="mono">' + esc(n.order_ref) + '</td>' +
          '<td>' + (n.channel === 'whatsapp_customer' ? 'Customer update' : 'Baker alert') + '</td>' +
          '<td><span class="badge badge--' + cls + '">' + esc(label) + '</span></td>' +
          '<td style="max-width:340px"><span style="font-size:.85rem;color:rgba(245,230,214,.7);line-height:1.55">' + esc(n.detail) + '</span></td>' +
          '<td style="white-space:nowrap;font-size:.82rem;color:rgba(245,230,214,.5)">' + esc(when(n.created_at)) + '</td>' +
          '<td><a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(n.payload || '') + '">Open message</a></td>' +
        '</tr>';
      }).join('');

      el.panels.notifications.innerHTML =
        '<div class="panel">' +
          '<h2>Baker notifications</h2>' +
          '<p class="panel__hint">Every order raises one alert to the baker, and every confirmation raises one update for the customer. Real sending needs the WhatsApp Cloud API with a verified business number, a permanent token and an approved template. Until those are set, each message is stored here and the button opens it in WhatsApp for you to send by hand. It is never marked sent unless the API accepted it.</p>' +
          (d.notifications.length
            ? '<div class="table-wrap"><table class="data"><thead><tr><th>Order</th><th>Channel</th><th>Status</th><th>Detail</th><th>When</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
            : '<p class="panel__hint">No notifications yet. Submit an order to see the alert that the baker receives.</p>') +
        '</div>';
    });
  }

  /* Every place that quotes a percentage reads it from these two settings, so
     this line has to describe whatever is saved right now, including a tier the
     baker has switched off. */
  function bundleNote(c) {
    var two = Number(c.bundle_two_pct), three = Number(c.bundle_three_pct);
    var bits = [];
    bits.push(two > 0
      ? 'Two classes in the same track save ' + two + '%.'
      : 'The two-class bundle is switched off.');
    bits.push(three > 0
      ? 'All three levels in a track save ' + three + '%.'
      : 'The three-class bundle is switched off.');
    return 'Saved now: ' + bits.join(' ') +
      ' These figures appear on the classes page, the booking page, every booking summary, the receipt and the WhatsApp alert.';
  }

  /* ---------- payments & settings ---------- */
  function loadPayments() {
    api('/api/admin/catalogue').then(function (d) {
      var c = d.settings;
      state.loadedAt.payments = Date.now();
      el.panels.payments.innerHTML =
        '<div class="panel" style="margin-bottom:1rem">' +
          '<h2>Mobile Money details</h2>' +
          '<p class="panel__hint">These details are shown to customers only while they are marked verified. Only enter details you have checked with the business. Nothing is inferred.</p>' +
          (c.momo_verified && c.momo_name && c.momo_number
            ? '<div class="alert alert--ok" style="margin-bottom:1rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg><span>Mobile Money payments are live: <strong>' + esc(c.momo_name) + '</strong>, ' + esc(c.momo_number) + '.</span></div>'
            : '<div class="alert alert--warn" style="margin-bottom:1rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span><strong>No verified Mobile Money details.</strong> Customers see "details pending" and Mobile Money orders are blocked, so no one can pay to a wrong number.</span></div>') +
          '<div class="field-row">' +
            '<div class="field"><label for="pm-name">Registered recipient name</label><input type="text" id="pm-name" value="' + esc(c.momo_name) + '" placeholder="Exactly as registered"></div>' +
            '<div class="field"><label for="pm-number">Verified payment number</label><input type="tel" id="pm-number" value="' + esc(c.momo_number) + '" placeholder="0XX XXX XXXX"></div>' +
          '</div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="pm-provider">Network or provider</label><input type="text" id="pm-provider" value="' + esc(c.momo_provider) + '" placeholder="e.g. MTN MoMo"></div>' +
            '<div class="field"><label for="pm-note">Note shown to customers (optional)</label><input type="text" id="pm-note" value="' + esc(c.momo_note) + '" placeholder="e.g. use your order reference"></div>' +
          '</div>' +
          '<label class="switch" style="margin-bottom:1rem"><input type="checkbox" id="pm-verified"' + (c.momo_verified ? ' checked' : '') + '><span>These details are verified and may be shown to customers</span></label>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
            '<button type="button" class="btn btn--gold" id="pm-save">Save payment details</button>' +
            '<button type="button" class="btn btn--ghost" id="pm-clear">Clear details</button>' +
          '</div>' +
          '<p class="form-note">Saving with verification ticked but an empty name or number will keep Mobile Money switched off.</p>' +
        '</div>' +

        '<div class="panel" style="margin-bottom:1rem">' +
          '<h2>Bank transfer details</h2>' +
          '<p class="panel__hint">Shown to customers only while all three fields are filled in and the details are marked verified. Enter them exactly as the bank statement shows them.</p>' +
          (c.bank_verified && c.bank_name && c.bank_account_name && c.bank_account_number
            ? '<div class="alert alert--ok" style="margin-bottom:1rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg><span>Bank transfers are live: <strong>' + esc(c.bank_name) + '</strong>, ' + esc(c.bank_account_number) + '.</span></div>'
            : '<div class="alert alert--warn" style="margin-bottom:1rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span><strong>No verified bank details.</strong> Customers cannot choose bank transfer until all three fields are saved and marked verified.</span></div>') +
          '<div class="field-row">' +
            '<div class="field"><label for="bk-name">Bank name</label><input type="text" id="bk-name" value="' + esc(c.bank_name || '') + '" placeholder="The bank as printed on your statement"></div>' +
            '<div class="field"><label for="bk-account">Account name</label><input type="text" id="bk-account" value="' + esc(c.bank_account_name || '') + '" placeholder="Business account name"></div>' +
          '</div>' +
          '<div class="field"><label for="bk-number">Account number</label><input type="text" id="bk-number" value="' + esc(c.bank_account_number || '') + '" placeholder="Account number"></div>' +
          '<label class="switch" style="margin-bottom:1rem"><input type="checkbox" id="bk-verified"' + (c.bank_verified ? ' checked' : '') + '><span>These details are verified and may be shown to customers</span></label>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
            '<button type="button" class="btn btn--gold" id="bk-save">Save bank details</button>' +
            '<button type="button" class="btn btn--ghost" id="bk-clear">Clear bank details</button>' +
          '</div>' +
          '<p class="form-note">Saving with verification ticked but any field empty clears the verified flag, so bank transfer stays switched off.</p>' +
        '</div>' +

        '<div class="panel">' +
          '<h2>Payment and order rules</h2>' +
          '<div class="field-row">' +
            '<div class="field"><label for="st-cash-delivery">Cash on delivery</label><select id="st-cash-delivery">' +
              '<option value="1"' + (c.cash_delivery_enabled ? ' selected' : '') + '>Available</option>' +
              '<option value="0"' + (!c.cash_delivery_enabled ? ' selected' : '') + '>Not available</option></select></div>' +
            '<div class="field"><label for="st-cash-pickup">Cash on pickup</label><select id="st-cash-pickup">' +
              '<option value="1"' + (c.cash_pickup_enabled ? ' selected' : '') + '>Available</option>' +
              '<option value="0"' + (!c.cash_pickup_enabled ? ' selected' : '') + '>Not available</option></select></div>' +
          '</div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="st-threshold">Advance payment threshold (GH&#8373;)</label>' +
              '<input type="number" id="st-threshold" value="' + esc((parseFloat(c.advance_threshold || '70000') / 100).toFixed(2)) + '" min="0" max="100000" step="0.01"></div>' +
            '<div class="field"><label for="st-auto">When payment is verified</label><select id="st-auto">' +
              '<option value="0"' + (!c.auto_confirm ? ' selected' : '') + '>I confirm the order myself</option>' +
              '<option value="1"' + (c.auto_confirm ? ' selected' : '') + '>Confirm the order automatically</option></select></div>' +
          '</div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="st-two">Two-class bundle (%)</label><input type="number" id="st-two" value="' + c.bundle_two_pct + '" min="0" max="50"></div>' +
            '<div class="field"><label for="st-three">Three-class bundle (%)</label><input type="number" id="st-three" value="' + c.bundle_three_pct + '" min="0" max="60"></div>' +
          '</div>' +
          '<button type="button" class="btn btn--gold" id="st-save">Save rules</button>' +
          '<p class="form-note">Orders and bookings above the advance threshold must be paid by Mobile Money or bank transfer before confirmation; cash on delivery and cash on pickup are blocked above it.</p>' +
          '<p class="form-note" id="st-bundle-note">' + bundleNote(c) + '</p>' +
        '</div>';
      document.getElementById('pm-save').addEventListener('click', function () {
        api('/api/admin/settings', {
          method: 'PATCH',
          body: {
            momo_name: document.getElementById('pm-name').value.trim(),
            momo_number: document.getElementById('pm-number').value.trim(),
            momo_provider: document.getElementById('pm-provider').value.trim(),
            momo_note: document.getElementById('pm-note').value.trim(),
            momo_verified: document.getElementById('pm-verified').checked ? '1' : '0'
          }
        }).then(function (d) {
          if (!d.ok) return flash('error', esc(d.error));
          flash('ok', d.config.momo ? 'Payment details saved and visible to customers.' : 'Saved. Mobile Money stays hidden until a name and number are both present and verified.');
          loadPayments();
        });
      });

      document.getElementById('pm-clear').addEventListener('click', function () {
        if (!confirm('Remove the Mobile Money details? Customers will not be able to pay by Mobile Money.')) return;
        api('/api/admin/settings', {
          method: 'PATCH',
          body: { momo_name: '', momo_number: '', momo_provider: '', momo_note: '', momo_verified: '0' }
        }).then(function () { flash('warn', 'Payment details cleared.'); loadPayments(); });
      });

      document.getElementById('bk-save').addEventListener('click', function () {
        api('/api/admin/settings', {
          method: 'PATCH',
          body: {
            bank_name: document.getElementById('bk-name').value.trim(),
            bank_account_name: document.getElementById('bk-account').value.trim(),
            bank_account_number: document.getElementById('bk-number').value.trim(),
            bank_verified: document.getElementById('bk-verified').checked ? '1' : '0'
          }
        }).then(function (d) {
          if (!d.ok) return flash('error', esc(d.error));
          flash('ok', d.config.bank ? 'Bank details saved and visible to customers.' : 'Saved. Bank transfer stays hidden until the bank name, account name and account number are all present and verified.');
          loadPayments();
        });
      });

      document.getElementById('bk-clear').addEventListener('click', function () {
        if (!confirm('Remove the bank details? Customers will not be able to choose bank transfer.')) return;
        api('/api/admin/settings', {
          method: 'PATCH',
          body: { bank_name: '', bank_account_name: '', bank_account_number: '', bank_verified: '0' }
        }).then(function () { flash('warn', 'Bank details cleared.'); loadPayments(); });
      });

      document.getElementById('st-save').addEventListener('click', function () {
        api('/api/admin/settings', {
          method: 'PATCH',
          body: {
            cash_delivery_enabled: document.getElementById('st-cash-delivery').value,
            cash_pickup_enabled: document.getElementById('st-cash-pickup').value,
            advance_threshold: document.getElementById('st-threshold').value,
            auto_confirm_on_verified_payment: document.getElementById('st-auto').value,
            bundle_two_pct: document.getElementById('st-two').value,
            bundle_three_pct: document.getElementById('st-three').value
          }
        }).then(function (d) {
          if (!d.ok) return flash('error', esc(d.error));
          flash('ok', 'Rules saved. The new percentages are live on the classes and booking pages.');
          // re-read the settings so the note under the form states the saved figures
          loadPayments();
        });
      });
    });
  }

  /* ---------- team ------------------------------------------------
     Signing in is not the same as being allowed in. Supabase Auth holds the
     accounts; the admins table holds the roster. Creating an account needs the
     service-role key, which must never reach a browser, so the work is done by
     a small Edge Function that first checks the caller is on the roster. */

  function teamCall(body) {
    return api('/api/admin/team', { method: 'POST', body: body });
  }

  function showIssuedCredentialsModal(title, email, roleLabel, tempPassword) {
    document.getElementById('admin-modal-body').innerHTML =
      '<p class="eyebrow" style="color:var(--gold);margin:0 0 .3rem">Temporary First-Login Credentials</p>' +
      '<h2 id="admin-modal-title" style="font-size:1.25rem;margin-bottom:.6rem">' + esc(title) + '</h2>' +
      '<p class="panel__hint">Share these one-time credentials securely with the user. They will be required to change this temporary password immediately upon their first login before accessing the dashboard.</p>' +
      '<div style="padding:14px;border-radius:10px;background:rgba(0,0,0,.38);border:1px solid rgba(212,164,55,.45);margin:12px 0">' +
        '<div style="margin-bottom:8px"><span style="font-size:.78rem;color:var(--muted);display:block">Email Address</span><strong style="font-size:.98rem;color:var(--cream)">' + esc(email) + '</strong></div>' +
        '<div style="margin-bottom:8px"><span style="font-size:.78rem;color:var(--muted);display:block">Assigned Role</span><span class="badge badge--blue">' + esc(roleLabel) + '</span></div>' +
        '<div><span style="font-size:.78rem;color:var(--gold);display:block">One-Time Temporary Password</span>' +
          '<code id="modal-issued-pass" style="font-size:1.1rem;font-weight:700;color:#fff;letter-spacing:.05em;user-select:all">' + esc(tempPassword) + '</code>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">' +
        '<button type="button" class="btn btn--gold btn--sm" id="btn-copy-issued-pass">Copy Credentials</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-close-modal>Done</button>' +
      '</div>';
    document.getElementById('admin-modal').classList.add('is-open');
    document.body.style.overflow = 'hidden';
    var copyBtn = document.getElementById('btn-copy-issued-pass');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var text = 'Mystery Bakebite Admin Sign-In\nEmail: ' + email + '\nTemporary Password: ' + tempPassword + '\n(Change required on first login)';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { copyBtn.textContent = 'Copied!'; });
        } else {
          copyBtn.textContent = 'Select & Copy Above';
        }
      });
    }
  }

  function loadTeam() {
    var panel = el.panels.team;
    panel.innerHTML =
      '<div class="admin-head">' +
        '<div><h1 class="admin-head__title">Team &amp; Access Control</h1>' +
        '<p class="admin-head__sub">Manage administrator accounts, role permissions, security status, and audit logs.</p></div>' +
      '</div>' +
      '<div class="panel" style="margin-bottom:18px;border:1px solid rgba(212,164,55,.35);background:linear-gradient(135deg,rgba(212,164,55,.1),rgba(20,10,5,.6))">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
          '<div>' +
            '<p class="eyebrow" style="margin:0 0 4px;color:var(--gold)">Primary Super Administrator Authority</p>' +
            '<h3 style="margin:0 0 4px;font-size:1.1rem;color:var(--cream)">mysterybakebite@gmail.com <span class="badge badge--amber" style="margin-left:6px">Super Administrator</span> <span class="badge badge--green" style="margin-left:4px">Protected Owner</span></h3>' +
            '<p class="panel__hint" style="margin:0">Exclusively authorized to create, invite, assign roles, reset passwords, deactivate, and remove dashboard accounts. Protected against accidental removal or privilege downgrade.</p>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="dash-grid">' +
        '<div class="panel col-8"><h3 class="panel__title">Authorized Accounts &amp; Roles</h3>' +
          '<div id="team-list"><p class="panel__hint">Loading roster\u2026</p></div>' +
        '</div>' +
        '<div class="panel col-4" id="team-create-panel"><h3 class="panel__title">Create / Invite User</h3>' +
          '<p class="panel__hint">Provision a new account with role-based permissions. Every new user is required to change their temporary password on first login.</p>' +
          '<div class="field"><label for="team-name">Full name</label>' +
            '<input type="text" id="team-name" autocomplete="off" placeholder="e.g. Amina Abukari"></div>' +
          '<div class="field"><label for="team-email">Email address</label>' +
            '<input type="email" id="team-email" autocomplete="off" spellcheck="false" placeholder="staff@mysterybakebite.com"></div>' +
          '<div class="field"><label for="team-role">Role &amp; access level</label>' +
            '<select id="team-role">' +
              '<option value="administrator">Administrator (Orders, Verify, Catalogue, Settings)</option>' +
              '<option value="manager">Order &amp; Kitchen Manager (Orders, Verify, Catalogue)</option>' +
              '<option value="viewer">Read-Only Viewer (View Orders &amp; Analytics Only)</option>' +
            '</select>' +
          '</div>' +
          '<div class="field">' +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">' +
              '<label for="team-pass">Temporary first-login password</label>' +
              '<button type="button" id="btn-gen-temp-pass" style="background:none;border:0;padding:0;color:var(--gold);font-size:.78rem;cursor:pointer;text-decoration:underline">Auto-generate</button>' +
            '</div>' +
            '<input type="text" id="team-pass" autocomplete="off" placeholder="Leave blank to auto-generate strong password">' +
            '<small style="display:block;margin-top:4px;font-size:.76rem;color:var(--muted)">Min 10 chars with uppercase, lowercase, number &amp; symbol.</small>' +
          '</div>' +
          '<button type="button" class="btn btn--gold btn--sm" id="team-add" style="width:100%;justify-content:center">Create &amp; Authorize User</button>' +
          '<p class="form-note">The user will be prompted to set their own personal password on first sign-in before accessing the dashboard.</p>' +
        '</div>' +
      '</div>' +
      '<div class="panel" style="margin-top:18px">' +
        '<h3 class="panel__title">Administrative Security &amp; Audit Log</h3>' +
        '<p class="panel__hint">Immutable record of account provisioning, role changes, password resets, and sign-in events.</p>' +
        '<div id="team-audit-log"><p class="panel__hint">Loading audit log\u2026</p></div>' +
      '</div>';

    var genBtn = document.getElementById('btn-gen-temp-pass');
    if (genBtn) {
      genBtn.addEventListener('click', function () {
        var upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        var lower = 'abcdefghijkmnopqrstuvwxyz';
        var digits = '23456789';
        var pick = function (s) { return s.charAt(Math.floor(Math.random() * s.length)); };
        var sample = 'MB-' + pick(upper) + pick(upper) + pick(lower) + pick(lower) + pick(digits) + pick(digits) + '!' + pick(upper) + pick(lower) + pick(digits);
        var pInput = document.getElementById('team-pass');
        if (pInput) pInput.value = sample;
      });
    }

    document.getElementById('team-add').addEventListener('click', function () {
      var nameVal = (document.getElementById('team-name').value || '').trim();
      var email = (document.getElementById('team-email').value || '').trim().toLowerCase();
      var roleVal = (document.getElementById('team-role').value || 'administrator').trim();
      var pass = (document.getElementById('team-pass').value || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) return flash('error', 'Enter a valid email address.');
      var btn = document.getElementById('team-add');
      btn.disabled = true;
      btn.textContent = 'Creating\u2026';
      teamCall({ action: 'create', name: nameVal, email: email, role: roleVal, password: pass }).then(function (d) {
        btn.disabled = false;
        btn.textContent = 'Create & Authorize User';
        if (!d || !d.ok) return flash('error', esc((d && d.error) || 'Could not create user.'));
        document.getElementById('team-name').value = '';
        document.getElementById('team-email').value = '';
        document.getElementById('team-pass').value = '';
        flash('ok', 'Account created for ' + esc(email) + ' (' + esc(roleBadgeLabel(roleVal)) + ').');
        if (d.temporaryPassword) {
          showIssuedCredentialsModal('User Account Created', email, roleBadgeLabel(roleVal), d.temporaryPassword);
        }
        loadTeam();
      });
    });

    teamCall({ action: 'list' }).then(function (d) {
      var host = document.getElementById('team-list');
      var auditHost = document.getElementById('team-audit-log');
      var createPanel = document.getElementById('team-create-panel');
      if (!host) return;
      if (!d || !d.ok) {
        host.innerHTML = '<p class="panel__hint">' + esc((d && d.error) || 'Could not load team roster.') + '</p>';
        return;
      }
      var canManage = !!d.canManageTeam;
      if (createPanel && !canManage) {
        createPanel.innerHTML =
          '<h3 class="panel__title">Super Administrator Exclusive</h3>' +
          '<p class="panel__hint">Only the primary Super Administrator (<b>mysterybakebite@gmail.com</b>) can create, invite, modify roles, reset passwords, or remove dashboard accounts.</p>';
      }

      var rows = (d.admins || []).map(function (a) {
        var isPrimary = !!a.isPrimarySuperAdmin || String(a.email || '').toLowerCase() === 'mysterybakebite@gmail.com';
        var me = MB.user() && (MB.user().id === a.userId || String(MB.user().email || '').toLowerCase() === String(a.email || '').toLowerCase());
        var rBadgeCls = a.role === 'super_admin' ? 'badge--amber' : (a.role === 'administrator' ? 'badge--blue' : (a.role === 'manager' ? 'badge--blush' : 'badge--grey'));
        var statusHtml = a.active === false
          ? '<span class="badge badge--red">Deactivated</span>'
          : (a.mustChangePassword
            ? '<span class="badge badge--amber">First-Login Reset Pending</span>'
            : '<span class="badge badge--green">Active</span>');

        var perms = a.permissions || {};
        var permPills = [
          perms.orders ? 'Orders' : null,
          perms.verify ? 'Verify Pay' : null,
          perms.catalogue ? 'Catalogue' : null,
          perms.settings ? 'Payout Settings' : null,
          perms.team ? 'User Admin' : null
        ].filter(Boolean).map(function (p) {
          return '<span style="display:inline-block;font-size:.7rem;padding:2px 6px;margin:2px 4px 2px 0;border-radius:4px;background:rgba(255,255,255,.06);color:var(--muted)">' + esc(p) + '</span>';
        }).join('');

        var controlsHtml = '';
        if (isPrimary) {
          controlsHtml = '<span class="badge badge--amber" title="Protected primary Super Administrator account">Protected Owner</span>';
        } else if (canManage) {
          controlsHtml =
            '<div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;flex-wrap:wrap">' +
              '<select data-team-role="' + esc(a.userId) + '" aria-label="Change role for ' + esc(a.email) + '" style="font-size:.78rem;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.35);color:var(--cream);border:1px solid rgba(255,255,255,.16)">' +
                '<option value="administrator"' + (a.role === 'administrator' ? ' selected' : '') + '>Administrator</option>' +
                '<option value="manager"' + (a.role === 'manager' ? ' selected' : '') + '>Manager</option>' +
                '<option value="viewer"' + (a.role === 'viewer' ? ' selected' : '') + '>Viewer</option>' +
              '</select>' +
              '<button type="button" class="btn btn--ghost btn--sm" data-team-reset-pw="' + esc(a.userId) + '" data-email="' + esc(a.email) + '">Reset PW</button>' +
              '<button type="button" class="btn btn--ghost btn--sm" data-team-toggle="' + esc(a.userId) + '" data-active="' + (a.active !== false ? '1' : '0') + '">' + (a.active !== false ? 'Deactivate' : 'Activate') + '</button>' +
              (me ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-team-remove="' + esc(a.userId) + '" data-email="' + esc(a.email) + '">Remove</button>') +
            '</div>';
        } else {
          controlsHtml = '<span style="font-size:.78rem;color:var(--muted)">Read-only</span>';
        }

        return '<tr>' +
          '<td>' +
            '<div><strong>' + esc(a.name || a.email) + '</strong>' + (me ? ' <span class="badge badge--blue">You</span>' : '') + '</div>' +
            '<div style="font-size:.82rem;color:var(--muted)">' + esc(a.email || '') + '</div>' +
          '</td>' +
          '<td><span class="badge ' + rBadgeCls + '">' + esc(a.roleLabel || roleBadgeLabel(a.role)) + '</span><div style="margin-top:4px">' + permPills + '</div></td>' +
          '<td>' + statusHtml + '</td>' +
          '<td style="font-size:.8rem;color:var(--muted)">' + esc((a.createdAt || '').slice(0, 10)) + (a.lastSignInAt ? '<br><small>Last sign-in: ' + esc(a.lastSignInAt.slice(0, 10)) + '</small>' : '') + '</td>' +
          '<td style="text-align:right">' + controlsHtml + '</td>' +
        '</tr>';
      }).join('');

      host.innerHTML = rows
        ? '<div style="overflow-x:auto"><table class="data"><thead><tr><th>User</th><th>Role &amp; Permissions</th><th>Status</th><th>Added</th><th style="text-align:right">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="panel__hint">No accounts found.</p>';

      host.querySelectorAll('[data-team-role]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var uid = sel.getAttribute('data-team-role');
          var newRole = sel.value;
          sel.disabled = true;
          teamCall({ action: 'update_role', userId: uid, role: newRole }).then(function (res) {
            sel.disabled = false;
            if (!res || !res.ok) {
              flash('error', esc((res && res.error) || 'Could not update role.'));
              loadTeam();
              return;
            }
            flash('ok', 'Role updated to ' + esc(roleBadgeLabel(newRole)) + '.');
            loadTeam();
          });
        });
      });

      host.querySelectorAll('[data-team-toggle]').forEach(function (b) {
        b.addEventListener('click', function () {
          var uid = b.getAttribute('data-team-toggle');
          var currentlyActive = b.getAttribute('data-active') === '1';
          var nextActive = !currentlyActive;
          b.disabled = true;
          teamCall({ action: 'set_status', userId: uid, active: nextActive }).then(function (res) {
            b.disabled = false;
            if (!res || !res.ok) return flash('error', esc((res && res.error) || 'Could not update account status.'));
            flash(nextActive ? 'ok' : 'warn', nextActive ? 'Account reactivated.' : 'Account deactivated.');
            loadTeam();
          });
        });
      });

      host.querySelectorAll('[data-team-reset-pw]').forEach(function (b) {
        b.addEventListener('click', function () {
          var uid = b.getAttribute('data-team-reset-pw');
          var uEmail = b.getAttribute('data-email') || '';
          if (!confirm('Issue a new one-time temporary password for ' + uEmail + '? They will be required to change it on their next login.')) return;
          b.disabled = true;
          teamCall({ action: 'reset_password', userId: uid }).then(function (res) {
            b.disabled = false;
            if (!res || !res.ok) return flash('error', esc((res && res.error) || 'Could not reset password.'));
            flash('ok', 'Temporary password issued for ' + esc(uEmail) + '.');
            if (res.temporaryPassword) {
              showIssuedCredentialsModal('Password Reset Issued', uEmail, (res.user && res.user.roleLabel) || 'Administrator', res.temporaryPassword);
            }
            loadTeam();
          });
        });
      });

      host.querySelectorAll('[data-team-remove]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-team-remove');
          var uEmail = b.getAttribute('data-email') || 'this user';
          if (!confirm('Remove ' + uEmail + '\u2019s access to the dashboard?')) return;
          b.disabled = true;
          teamCall({ action: 'remove', userId: id }).then(function (res) {
            if (!res || !res.ok) { b.disabled = false; return flash('error', esc((res && res.error) || 'Could not remove user.')); }
            flash('warn', 'Access removed for ' + esc(uEmail) + '.');
            loadTeam();
          });
        });
      });

      if (auditHost) {
        var logs = Array.isArray(d.auditLog) ? d.auditLog : [];
        if (!canManage) {
          auditHost.innerHTML = '<p class="panel__hint">Security audit logs are restricted to the Super Administrator (mysterybakebite@gmail.com).</p>';
        } else if (!logs.length) {
          auditHost.innerHTML = '<p class="panel__hint">No administrative security events recorded yet.</p>';
        } else {
          auditHost.innerHTML = '<div style="overflow-x:auto"><table class="data"><thead><tr><th>Timestamp</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th></tr></thead><tbody>' +
            logs.slice(0, 25).map(function (entry) {
              return '<tr>' +
                '<td style="font-size:.78rem;white-space:nowrap;color:var(--muted)">' + esc(when(entry.at).slice(0, 19)) + '</td>' +
                '<td><span class="badge badge--blue">' + esc(entry.action) + '</span></td>' +
                '<td style="font-size:.82rem">' + esc(entry.actor) + '</td>' +
                '<td style="font-size:.82rem">' + esc(entry.target || '\u2014') + '</td>' +
                '<td style="font-size:.82rem;color:var(--muted)">' + esc(entry.details) + '</td>' +
              '</tr>';
            }).join('') +
          '</tbody></table></div>';
        }
      }
    });
  }

  /* ---------- password ---------- */
  function passwordModal() {
    document.getElementById('admin-modal-body').innerHTML =
      '<h2 id="admin-modal-title" style="font-size:1.2rem;margin-bottom:.8rem">Change password</h2>' +
      '<div class="field"><label for="pw-current">Current password</label><input type="password" id="pw-current" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pw-next">New password</label><input type="password" id="pw-next" autocomplete="new-password" placeholder="At least 10 characters (upper, lower, number, symbol)"></div>' +
      '<div class="field"><label for="pw-again">Repeat new password</label><input type="password" id="pw-again" autocomplete="new-password"></div>' +
      '<button type="button" class="btn btn--gold" id="pw-save">Change password</button>' +
      '<p class="form-note">Changing the password signs out every session, including this one.</p>';
    document.getElementById('admin-modal').classList.add('is-open');
    document.body.style.overflow = 'hidden';

    document.getElementById('pw-save').addEventListener('click', function () {
      var cur = document.getElementById('pw-current').value;
      var next = document.getElementById('pw-next').value;
      var again = document.getElementById('pw-again').value;
      if (next !== again) return flash('error', 'The new passwords do not match.');
      if (next.length < 10) return flash('error', 'Use at least 10 characters with uppercase, lowercase, number, and symbol.');
      api('/api/admin/session').then(function (who) {
        return MB.signIn((who && who.email) || '', cur, true);
      }).then(function (check) {
        if (!check.ok) {
          /* the current password is wrong: say so rather than changing it */
          flash('error', 'The current password is not right.');
          return null;
        }
        return MB.changePassword(next);
      }).then(function (d) {
        if (!d) return;
        if (!d.ok) return flash('error', esc(d.error));
        closeModal();
        flash('ok', 'Password changed.');
        setTimeout(showLogin, 900);
      });
    });
  }

  function closeModal() {
    document.getElementById('admin-modal').classList.remove('is-open');
    document.body.style.overflow = '';
  }

  /* ---------- navigation ----------
     One sliding marker sits behind the active tab, so the highlight travels
     between items with a transform instead of jumping. Panels swap with a
     short rise-and-fade, and a panel that was filled in the last twenty
     seconds is reused, which is what keeps the switch free of flicker. */

  function moveIndicator() {
    var nav = document.getElementById('admin-nav');
    var ind = document.getElementById('admin-nav-ind');
    if (!nav || !ind) return;
    var active = nav.querySelector('.admin-tab.is-on');
    if (!active) return;
    var horizontal = getComputedStyle(nav).flexDirection === 'row';
    if (horizontal) {
      ind.style.width = active.offsetWidth + 'px';
      ind.style.height = active.offsetHeight + 'px';
      ind.style.transform = 'translate3d(' + active.offsetLeft + 'px,0,0)';
    } else {
      ind.style.width = '100%';
      ind.style.height = active.offsetHeight + 'px';
      ind.style.transform = 'translate3d(0,' + active.offsetTop + 'px,0)';
    }
  }

  function closePops() {
    ['bell-pop', 'account-pop'].forEach(function (id) {
      var pop = document.getElementById(id);
      if (!pop) return;
      pop.hidden = true;
    });
    ['btn-bell', 'btn-account'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  function togglePop(popId, btnId) {
    var pop = document.getElementById(popId);
    if (!pop) return;
    var open = pop.hidden;
    closePops();
    pop.hidden = !open;
    var btn = document.getElementById(btnId);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderBell() {
    var pop = document.getElementById('bell-pop');
    if (!pop) return;
    var d = state.dashboard;
    if (!d) {
      pop.innerHTML = '<div class="dash__pop-head"><b>Alerts</b></div>' + emptyRow('Loading alerts.');
      return;
    }
    var items = (d.attention || []).slice(0, 5);
    pop.innerHTML =
      '<div class="dash__pop-head"><b>Alerts</b>' +
        '<button type="button" class="panel__link" data-goto="orders">All ' + arrowIcon() + '</button></div>' +
      (items.length
        ? '<div class="mini-list">' + items.map(function (o) {
            return '<div class="mini-row"><div><span class="mini-row__name">' + esc(o.ref) + '</span>' +
              '<span class="mini-row__meta">' + esc(o.customer_name) + ' &middot; ' + money(o.total) + '</span>' +
              '<span style="display:block;margin-top:.3rem">' + payBadge(o.payment_status) + ' ' + ordBadge(o.order_status) + '</span></div>' +
              '<button type="button" class="btn btn--ghost btn--sm" data-open-order="' + esc(o.ref) + '">Open</button></div>';
          }).join('') + '</div>'
        : '<p class="panel__sub">Nothing needs attention right now.</p>');
  }

  function setTab(name, opts) {
    opts = opts || {};
    if (!MB.isSignedIn() || (typeof MB.isAdmin === 'function' && !MB.isAdmin())) {
      showLogin('Please sign in with an authorized administrator account to access dashboard tabs.');
      return;
    }
    if (state.mustChangePassword || (typeof MB.mustChangePassword === 'function' && MB.mustChangePassword())) {
      showFirstLoginGate({ email: state.email, role: state.role });
      return;
    }
    if (!el.panels[name]) return;
    var previous = state.tab;
    state.tab = name;

    document.querySelectorAll('.admin-tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    moveIndicator();
    if (previous !== name) closePops();

    Object.keys(el.panels).forEach(function (k) {
      el.panels[k].hidden = k !== name;
    });

    var activeTab = document.querySelector('.admin-tab.is-on');
    if (activeTab && activeTab.scrollIntoView) {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    var panel = el.panels[name];
    panel.classList.remove('is-in');
    void panel.offsetWidth;          // restart the animation cleanly
    panel.classList.add('is-in');

    if (previous !== name && window.scrollY > panel.getBoundingClientRect().top + window.scrollY - 80) {
      window.scrollTo({ top: Math.max(0, panel.getBoundingClientRect().top + window.scrollY - 80), behavior: 'auto' });
    }

    var fresh = Date.now() - (state.loadedAt[name] || 0) < CACHE_MS;
    if (!opts.reload && fresh && panel.childElementCount) return;
    if (TAB_LOADERS[name]) TAB_LOADERS[name]();
  }

  function stepTab(delta) {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.admin-tab'));
    var i = tabs.findIndex(function (b) { return b.getAttribute('data-tab') === state.tab; });
    var next = tabs[(i + delta + tabs.length) % tabs.length];
    if (next) { setTab(next.getAttribute('data-tab')); next.focus(); }
  }

  /* ---------- init ---------- */
  function todayLabel() {
    try {
      return new Date().toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });
    } catch (e) {
      return 'Dashboard';
    }
  }

  function init() {
    el.login = document.getElementById('admin-login');
    el.firstLogin = document.getElementById('admin-first-login');
    el.forgot = document.getElementById('admin-forgot');
    el.app = document.getElementById('admin-app');
    el.alert = document.getElementById('admin-alert');
    el.panels = {
      overview: document.getElementById('panel-overview'),
      orders: document.getElementById('panel-orders'),
      products: document.getElementById('panel-products'),
      classes: document.getElementById('panel-classes'),
      cake: document.getElementById('panel-cake'),
      discounts: document.getElementById('panel-discounts'),
      notifications: document.getElementById('panel-notifications'),
      payments: document.getElementById('panel-payments'),
      team: document.getElementById('panel-team')
    };

    TAB_LOADERS = {
      overview: loadOverview,
      orders: loadOrders,
      products: loadProducts,
      classes: loadClasses,
      cake: loadCake,
      discounts: loadDiscounts,
      notifications: loadNotifications,
      payments: loadPayments,
      team: loadTeam
    };

    var dateEl = document.getElementById('dash-date');
    if (dateEl) dateEl.textContent = todayLabel();

    document.getElementById('login-form').addEventListener('submit', doLogin);
    // A frame with no allow-forms permission blocks native submission, so the
    // button also calls the handler directly.
    document.querySelectorAll('#login-form button[type=submit]').forEach(function (b) {
      b.addEventListener('click', doLogin);
    });

    var flForm = document.getElementById('first-login-form');
    if (flForm) {
      flForm.addEventListener('submit', doFirstLoginPasswordChange);
      flForm.querySelectorAll('button[type=submit]').forEach(function (b) {
        b.addEventListener('click', doFirstLoginPasswordChange);
      });
    }
    var flLogout = document.getElementById('btn-first-login-logout');
    if (flLogout) {
      flLogout.addEventListener('click', function () {
        MB.signOut().then(function () { showLogin(); });
      });
    }

    var forgotBtn = document.getElementById('btn-forgot-password');
    if (forgotBtn) forgotBtn.addEventListener('click', showForgot);
    var backLoginBtn = document.getElementById('btn-back-login');
    if (backLoginBtn) backLoginBtn.addEventListener('click', function () { showLogin(); });
    var forgotForm = document.getElementById('forgot-form');
    if (forgotForm) {
      forgotForm.addEventListener('submit', doForgotPassword);
      forgotForm.querySelectorAll('button[type=submit]').forEach(function (b) {
        b.addEventListener('click', doForgotPassword);
      });
    }

    var provBtn = document.getElementById('btn-provision-super-admin');
    if (provBtn) provBtn.addEventListener('click', doProvisionSuperAdmin);
    var copySetupBtn = document.getElementById('btn-copy-setup-pass');
    if (copySetupBtn) {
      copySetupBtn.addEventListener('click', function () {
        var codeEl = document.getElementById('super-admin-temp-pass');
        var pwText = codeEl ? codeEl.textContent : '';
        var passInp = document.getElementById('login-pass');
        if (passInp && pwText) passInp.value = pwText;
        if (navigator.clipboard && navigator.clipboard.writeText && pwText) {
          navigator.clipboard.writeText(pwText).then(function () { copySetupBtn.textContent = 'Copied!'; });
        } else {
          copySetupBtn.textContent = 'Filled below!';
        }
      });
    }

    document.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-tab]');
      if (tab) { setTab(tab.getAttribute('data-tab')); return; }

      var goto = e.target.closest('[data-goto]');
      if (goto) {
        e.preventDefault();
        if (goto.hasAttribute('data-status') || goto.hasAttribute('data-payments') || goto.hasAttribute('data-kinds')) {
          state.filters.status = goto.getAttribute('data-status') || '';
          state.filters.payment = goto.getAttribute('data-payments') || '';
          state.filters.kind = goto.getAttribute('data-kinds') || '';
          state.filters.q = '';
        }
        setTab(goto.getAttribute('data-goto'), { reload: true });
        return;
      }

      var metric = e.target.closest('[data-metric]');
      if (metric) {
        state.metric = metric.getAttribute('data-metric');
        document.querySelectorAll('[data-metric]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === metric ? 'true' : 'false');
        });
        paintChart();
        return;
      }

      var range = e.target.closest('[data-days]');
      if (range) {
        state.days = parseInt(range.getAttribute('data-days'), 10) || 7;
        document.querySelectorAll('[data-days]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === range ? 'true' : 'false');
        });
        loadOverview(true);
        return;
      }

      var open = e.target.closest('[data-open-order]');
      if (open) { closePops(); openOrder(open.getAttribute('data-open-order')); return; }

      var ver = e.target.closest('[data-verify]');
      if (ver) {
        var refEl = state.currentOrder && state.currentOrder.ref;
        if (refEl) verify(refEl, ver.getAttribute('data-verify'));
        return;
      }

      var st = e.target.closest('[data-status]');
      if (st && st.classList.contains('btn')) {
        var r = state.currentOrder && state.currentOrder.ref;
        if (r) moveStatus(r, st.getAttribute('data-status'));
        return;
      }

      var rec = e.target.closest('[data-download-receipt]');
      if (rec) { adminReceipt(rec.getAttribute('data-download-receipt')); return; }

      if (e.target.closest('[data-close-modal]')) { closeModal(); return; }

      if (e.target.closest('#btn-bell')) {
        renderBell();
        togglePop('bell-pop', 'btn-bell');
        return;
      }
      if (e.target.closest('#btn-account')) {
        togglePop('account-pop', 'btn-account');
        return;
      }
      if (e.target.closest('#btn-refresh')) {
        closePops();
        state.loadedAt = {};
        setTab(state.tab, { reload: true });
        return;
      }
      if (!e.target.closest('.dash__pop')) closePops();
    });

    var searchForm = document.getElementById('dash-search');
    if (searchForm) {
      searchForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var q = (document.getElementById('dash-q').value || '').trim();
        state.filters = { q: q, status: '', payment: '', kind: '' };
        setTab('orders', { reload: true });
      });
    }

    var nav = document.getElementById('admin-nav');
    if (nav) {
      nav.addEventListener('keydown', function (e) {
        var horizontal = getComputedStyle(nav).flexDirection === 'row';
        var back = horizontal ? 'ArrowLeft' : 'ArrowUp';
        var fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (e.key === back) { e.preventDefault(); stepTab(-1); }
        else if (e.key === fwd) { e.preventDefault(); stepTab(1); }
        else if (e.key === 'Home') { e.preventDefault(); setTab('overview'); }
        else if (e.key === 'End') {
          e.preventDefault();
          var last = document.querySelectorAll('.admin-tab');
          setTab(last[last.length - 1].getAttribute('data-tab'));
        }
      });
    }

    document.getElementById('btn-logout').addEventListener('click', function () {
      MB.signOut().then(function () { showLogin(); });
    });

    window.addEventListener('mb-auth-changed', function (ev) {
      var detail = ev && ev.detail;
      if (detail && (detail.signedIn === false || detail.isAdmin === false)) {
        showLogin();
      }
    });

    window.addEventListener('hashchange', function () {
      if (!MB.isSignedIn() || (typeof MB.isAdmin === 'function' && !MB.isAdmin())) {
        showLogin('Administrator authentication is required to access that dashboard section.');
      }
    });

    document.getElementById('btn-password').addEventListener('click', function () {
      closePops();
      passwordModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closePops(); closeModal(); }
    });

    var relayout = (function () {
      var t;
      return function () {
        clearTimeout(t);
        t = setTimeout(function () {
          moveIndicator();
          if (state.tab === 'overview') paintChart();
        }, 90);
      };
    })();
    window.addEventListener('resize', relayout);
    window.addEventListener('load', relayout);

    checkSession();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
