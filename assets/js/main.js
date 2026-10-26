/* ============================================================
   Mystery Bakebite: site interactions
   Sticky header · mobile nav · scroll reveals · sub-navigation
   · active page state · restrained hero parallax
   ============================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function pageName() {
    var p = window.location.pathname.split('/').pop();
    return (!p || p === 'index.html') ? 'index.html' : p;
  }

  /* ---------- Active page in the primary navigation ---------- */
  var current = pageName();
  Array.prototype.forEach.call(document.querySelectorAll('.nav-links a[href]'), function (a) {
    if (a.getAttribute('href').split('#')[0] === current) {
      a.classList.add('is-active');
      a.setAttribute('aria-current', 'page');
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.mobile-menu__list a[href]'), function (a) {
    if (a.getAttribute('href').split('#')[0] === current) {
      a.classList.add('is-active');
      a.setAttribute('aria-current', 'page');
    }
  });

  /* ---------- Sticky header + hero parallax ---------- */
  var header = document.getElementById('site-header');
  var heroImg = document.getElementById('hero-img');
  var ticking = false;

  function syncHeaderHeight() {
    if (!header) return;
    var h = Math.round(header.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--header-h', h + 'px');
  }
  syncHeaderHeight();
  window.addEventListener('resize', syncHeaderHeight, { passive: true });

  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    if (header) {
      var wasScrolled = header.classList.contains('is-scrolled');
      var nowScrolled = y > 24;
      if (wasScrolled !== nowScrolled) {
        header.classList.toggle('is-scrolled', nowScrolled);
        syncHeaderHeight(); // the header is shorter when scrolled
      }
    }

    if (heroImg && !reduceMotion.matches && y < window.innerHeight * 1.1) {
      heroImg.style.transform = 'translate3d(0,' + (y * 0.045).toFixed(2) + 'px,0)';
    }
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(onScroll);
    }
  }, { passive: true });
  onScroll();

  /* ---------- Mobile menu ---------- */
  var toggle = document.getElementById('nav-toggle');
  var menu = document.getElementById('mobile-menu');
  var lastFocused = null;

  function closeMenu() {
    if (!menu || !toggle) return;
    menu.classList.remove('is-open');
    menu.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    document.body.style.overflow = '';
    if (lastFocused) lastFocused.focus();
  }

  function openMenu() {
    if (!menu || !toggle) return;
    lastFocused = document.activeElement;
    menu.classList.add('is-open');
    menu.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    document.body.style.overflow = 'hidden';
    var first = menu.querySelector('a');
    if (first) first.focus({ preventScroll: true });
  }

  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      if (toggle.getAttribute('aria-expanded') === 'true') closeMenu(); else openMenu();
    });

    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeMenu();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('is-open')) closeMenu();
    });

    window.matchMedia('(min-width: 1041px)').addEventListener('change', function (e) {
      if (e.matches && menu.classList.contains('is-open')) closeMenu();
    });
  }

  /* ---------- Scroll reveals ---------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));

  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

    revealEls.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ---------- Sub-navigation scroll spy ---------- */
  var subLinks = Array.prototype.slice.call(document.querySelectorAll('.subnav a[href^="#"]'));
  if (subLinks.length && 'IntersectionObserver' in window) {
    var targets = subLinks
      .map(function (a) { return document.querySelector(a.getAttribute('href')); })
      .filter(Boolean);

    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = '#' + entry.target.id;
        subLinks.forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === id);
        });
      });
    }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });

    targets.forEach(function (t) { spy.observe(t); });
  }

  /* ---------- Smooth in-page anchors, offset for sticky header ---------- */
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href^="#"]');
    if (!link) return;
    var id = link.getAttribute('href');
    if (!id || id === '#' || id.length < 2) return;
    var target = document.querySelector(id);
    if (!target) return;

    e.preventDefault();
    var headerH = header ? header.getBoundingClientRect().height : 0;
    var top = target.getBoundingClientRect().top + window.scrollY - headerH - 6;

    window.scrollTo({ top: Math.max(top, 0), behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    if (history.replaceState) history.replaceState(null, '', id);
  });

  /* ---------- WhatsApp enquiry form ---------- */
  var form = document.getElementById('enquiry-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;

      var data = new FormData(form);
      var lines = [
        'Hello Mystery Bakebite,',
        '',
        'Name: ' + (data.get('name') || '').trim(),
        'Enquiry: ' + data.get('topic'),
        '',
        (data.get('message') || '').trim()
      ];

      var url = 'https://wa.me/233554520532?text=' + encodeURIComponent(lines.join('\n'));
      window.open(url, '_blank', 'noopener');
    });
  }

  /* ---------- Footer year ---------- */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  /* ---------- Navbar Dashboard / Sign-Out synchronization (RBAC-enforced) ----------
     Regular customers and unauthenticated visitors on public-facing pages must
     never see a Dashboard button in the shopping header. The Dashboard button is
     displayed ONLY after the session is verified as an authorized administrator. */
  var ICON_SIGNIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8 10V7.5a4 4 0 018 0V10"/><path d="M12 14v2.5"/></svg>';
  var ICON_DASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>';
  var ICON_SIGNOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

  function applyAuthNavDOM(isAdmin) {
    var isAdminPage = current === 'admin.html';
    var navSignin = document.querySelector('.nav-actions .signin-link:not([data-extra-logout])');
    var extraLogout = document.querySelector('.nav-actions [data-extra-logout]');

    if (navSignin) {
      if (isAdmin) {
        navSignin.hidden = false;
        navSignin.removeAttribute('hidden');
        navSignin.classList.add('is-admin-verified');
        if (isAdminPage) {
          navSignin.setAttribute('href', '#signout');
          navSignin.setAttribute('data-auth-logout', 'true');
          navSignin.setAttribute('aria-label', 'Sign out of the baker dashboard');
          navSignin.classList.add('signin-link--logout');
          navSignin.innerHTML = ICON_SIGNOUT + '<span>SIGN-OUT</span>';
          if (extraLogout && extraLogout.parentNode) extraLogout.parentNode.removeChild(extraLogout);
        } else {
          navSignin.setAttribute('href', 'admin.html');
          navSignin.removeAttribute('data-auth-logout');
          navSignin.setAttribute('aria-label', 'Open the baker dashboard');
          navSignin.classList.remove('signin-link--logout');
          navSignin.innerHTML = ICON_DASH + '<span>DASHBOARD</span>';
          if (!extraLogout) {
            extraLogout = document.createElement('button');
            extraLogout.type = 'button';
            extraLogout.className = 'signin-link signin-link--logout is-admin-verified';
            extraLogout.setAttribute('data-extra-logout', 'true');
            extraLogout.setAttribute('data-auth-logout', 'true');
            extraLogout.setAttribute('aria-label', 'Sign out of the baker dashboard');
            extraLogout.innerHTML = ICON_SIGNOUT + '<span>SIGN-OUT</span>';
            navSignin.insertAdjacentElement('afterend', extraLogout);
          }
        }
      } else {
        navSignin.classList.remove('is-admin-verified');
        if (extraLogout && extraLogout.parentNode) extraLogout.parentNode.removeChild(extraLogout);
        if (isAdminPage) {
          navSignin.hidden = false;
          navSignin.removeAttribute('hidden');
          navSignin.setAttribute('href', '#admin-login');
          navSignin.removeAttribute('data-auth-logout');
          navSignin.setAttribute('aria-label', 'Sign in to the baker dashboard');
          navSignin.classList.remove('signin-link--logout');
          navSignin.innerHTML = ICON_SIGNIN + '<span>SIGN-IN</span>';
        } else {
          /* Hide the Dashboard button on all public-facing pages for customers & unauthenticated visitors */
          navSignin.hidden = true;
          navSignin.setAttribute('hidden', '');
          navSignin.removeAttribute('data-auth-logout');
          navSignin.classList.remove('signin-link--logout');
        }
      }
    }

    var mobileAuth = document.querySelector('.mobile-menu__foot a[href="admin.html"], .mobile-menu__foot a[data-mobile-auth]');
    var mobileExtraLogout = document.querySelector('.mobile-menu__foot [data-mobile-extra-logout]');
    if (mobileAuth) {
      mobileAuth.setAttribute('data-mobile-auth', 'true');
      if (isAdmin) {
        mobileAuth.hidden = false;
        mobileAuth.removeAttribute('hidden');
        mobileAuth.classList.add('is-admin-verified');
        if (isAdminPage) {
          mobileAuth.setAttribute('href', '#signout');
          mobileAuth.setAttribute('data-auth-logout', 'true');
          mobileAuth.innerHTML = ICON_SIGNOUT + ' SIGN-OUT';
          if (mobileExtraLogout && mobileExtraLogout.parentNode) mobileExtraLogout.parentNode.removeChild(mobileExtraLogout);
        } else {
          mobileAuth.setAttribute('href', 'admin.html');
          mobileAuth.removeAttribute('data-auth-logout');
          mobileAuth.innerHTML = ICON_DASH + ' DASHBOARD';
          if (!mobileExtraLogout) {
            mobileExtraLogout = document.createElement('button');
            mobileExtraLogout.type = 'button';
            mobileExtraLogout.className = 'btn btn--ghost btn--sm is-admin-verified';
            mobileExtraLogout.style.justifyContent = 'center';
            mobileExtraLogout.setAttribute('data-mobile-extra-logout', 'true');
            mobileExtraLogout.setAttribute('data-auth-logout', 'true');
            mobileExtraLogout.innerHTML = ICON_SIGNOUT + ' SIGN-OUT';
            mobileAuth.insertAdjacentElement('afterend', mobileExtraLogout);
          }
        }
      } else {
        mobileAuth.classList.remove('is-admin-verified');
        if (mobileExtraLogout && mobileExtraLogout.parentNode) mobileExtraLogout.parentNode.removeChild(mobileExtraLogout);
        if (isAdminPage) {
          mobileAuth.hidden = false;
          mobileAuth.removeAttribute('hidden');
          mobileAuth.setAttribute('href', '#admin-login');
          mobileAuth.removeAttribute('data-auth-logout');
          mobileAuth.innerHTML = ICON_SIGNIN + ' SIGN-IN';
        } else {
          mobileAuth.hidden = true;
          mobileAuth.setAttribute('hidden', '');
          mobileAuth.removeAttribute('data-auth-logout');
        }
      }
    }
  }

  function syncAuthNav(overrideIsAdmin) {
    if (typeof overrideIsAdmin === 'boolean') {
      applyAuthNavDOM(overrideIsAdmin);
      return;
    }
    var hasSession = !!(window.MB && typeof window.MB.isSignedIn === 'function' && window.MB.isSignedIn());
    if (!hasSession) {
      applyAuthNavDOM(false);
      return;
    }
    var syncImmediate = !!(window.MB && typeof window.MB.isAdmin === 'function' && window.MB.isAdmin());
    applyAuthNavDOM(syncImmediate);
    if (window.MB && typeof window.MB.verifyAdminSession === 'function') {
      window.MB.verifyAdminSession().then(function (res) {
        applyAuthNavDOM(!!(res && res.isAdmin));
      });
    }
  }

  /* Add discreet Staff Login link in the footer legal line so bakers can reach admin.html without cluttering customer navigation */
  var legalLine = document.querySelector('.footer__bottom .legal');
  if (legalLine && !legalLine.querySelector('[data-footer-staff-login]') && current !== 'admin.html') {
    var staffLink = document.createElement('a');
    staffLink.href = 'admin.html';
    staffLink.setAttribute('data-footer-staff-login', 'true');
    staffLink.style.cssText = 'color:rgba(245,230,214,.38);text-decoration:none;margin-left:.45rem;font-size:.72rem;border-bottom:1px dotted rgba(245,230,214,.22)';
    staffLink.textContent = 'Baker Login';
    legalLine.appendChild(document.createTextNode(' \u00b7 '));
    legalLine.appendChild(staffLink);
  }

  document.addEventListener('click', function (e) {
    var logoutEl = e.target.closest('[data-auth-logout]');
    if (!logoutEl) return;
    e.preventDefault();
    closeMenu();
    if (window.MB && typeof window.MB.signOut === 'function') {
      window.MB.signOut().then(function () {
        syncAuthNav(false);
      });
    } else {
      syncAuthNav(false);
    }
  });

  window.syncMBAuthNav = syncAuthNav;
  window.addEventListener('mb-auth-changed', function (ev) {
    var detail = ev && ev.detail;
    if (detail && typeof detail.isAdmin === 'boolean') {
      syncAuthNav(detail.isAdmin);
    } else if (detail && detail.signedIn === false) {
      syncAuthNav(false);
    } else {
      syncAuthNav();
    }
  });
  syncAuthNav();
})();

/* ============================================================
   Products page: Browse / Build view swap
   ============================================================ */
(function () {
  var swap = document.getElementById('view-swap');
  if (!swap) return;

  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-view]'));
  var panels = {
    browse: document.getElementById('panel-browse'),
    build: document.getElementById('panel-build')
  };
  if (!panels.browse || !panels.build) return;

  var current = 'browse';
  var timer = null;

  function syncButtons(name) {
    buttons.forEach(function (b) {
      var on = b.getAttribute('data-view') === name;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function show(name, opts) {
    var to = panels[name];
    if (!to || name === current) return;
    var from = panels[current];
    var startHeight = from.offsetHeight;

    swap.style.height = startHeight + 'px';

    from.classList.remove('is-on');
    to.classList.add('is-on');

    var endHeight = to.offsetHeight;
    window.requestAnimationFrame(function () {
      swap.style.height = endHeight + 'px';
    });

    current = name;
    syncButtons(name);

    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      swap.style.height = '';
      swap.style.transition = '';
    }, 1000);

    /* the builder measures the viewport, so nudge it after it is visible */
    if (name === 'build') {
      window.setTimeout(function () {
        window.dispatchEvent(new Event('resize'));
      }, 60);
    }

    if (opts && opts.scroll) {
      var top = swap.getBoundingClientRect().top + window.pageYOffset - 96;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      show(b.getAttribute('data-view'), { scroll: true });
    });
  });

  /* keyboard support for the tablist */
  buttons.forEach(function (b, i) {
    b.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      var next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      show(next.getAttribute('data-view'));
    });
  });

  /* deep link: products.html#build or #browse */
  function fromHash() {
    var h = (window.location.hash || '').replace('#', '');
    if (h === 'build') show('build', { scroll: true });
    else if (h === 'browse') show('browse', { scroll: true });
  }
  fromHash();
  window.addEventListener('hashchange', fromHash);
})();

/* ============================================================
   Bundle percentages
   The percentages themselves live in the dashboard settings. A placed order
   records the ones it actually received, so a receipt, an order page or a
   WhatsApp message keeps stating the right figure even after the baker
   changes the rule. This formats that record for display.
   ============================================================ */
window.mbBundlePct = function (bundles) {
  var pcts = [];
  (bundles || []).forEach(function (b) {
    var pct = parseInt(b && b.percent, 10);
    if (pct > 0 && pcts.indexOf(pct) === -1) pcts.push(pct);
  });
  if (!pcts.length) return '';
  return pcts.map(function (p) { return p + '%'; }).join(' and ');
};

/* ============================================================
   V10: Luxury Patisserie Motion & Interactive Animations
   Scroll progress ribbon · ambient sparkles · auto scroll-reveal
   · 3D card tilt & cursor spotlight · fly-to-cart golden orb
   ============================================================ */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduceMotion && reduceMotion.matches) return;

  /* 1. Top Golden Scroll Progress Ribbon */
  var scrollBar = document.createElement('div');
  scrollBar.className = 'mb-scroll-bar';
  scrollBar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(scrollBar);

  function updateScrollProgress() {
    var docEl = document.documentElement;
    if (!docEl) return;
    var scrollTop = window.scrollY || window.pageYOffset || 0;
    var maxScroll = Math.max(1, (docEl.scrollHeight || 1) - (window.innerHeight || 1));
    var progress = Math.max(0, Math.min(1, scrollTop / maxScroll));
    scrollBar.style.setProperty('--scroll-p', progress.toFixed(4));
  }
  window.addEventListener('scroll', updateScrollProgress, { passive: true });
  window.addEventListener('resize', updateScrollProgress, { passive: true });
  updateScrollProgress();

  /* 2. Ambient Floating Golden Bakery Sparkles */
  var sparkleHost = document.createElement('div');
  sparkleHost.className = 'mb-ambient-sparkles';
  sparkleHost.setAttribute('aria-hidden', 'true');
  var sparkleCount = 14;
  for (var s = 0; s < sparkleCount; s++) {
    var sp = document.createElement('span');
    sp.className = 'mb-sparkle';
    var leftPct = ((s * 7.3 + 4) % 96).toFixed(1) + '%';
    var topPct = ((s * 13.7 + 12) % 92).toFixed(1) + '%';
    var sz = (3 + (s % 4)) + 'px';
    var dur = (9 + (s % 6) * 1.6).toFixed(1) + 's';
    var delay = ((s * 0.85) % 8).toFixed(2) + 's';
    var dx = ((s % 2 === 0 ? 1 : -1) * (14 + (s % 5) * 5)) + 'px';
    var maxOp = (0.24 + (s % 4) * 0.07).toFixed(2);
    sp.style.left = leftPct;
    sp.style.top = topPct;
    sp.style.setProperty('--sz', sz);
    sp.style.setProperty('--dur', dur);
    sp.style.setProperty('--delay', delay);
    sp.style.setProperty('--dx', dx);
    sp.style.setProperty('--max-op', maxOp);
    sparkleHost.appendChild(sp);
  }
  document.body.appendChild(sparkleHost);

  /* 3. Automatic Site-Wide Staggered Scroll-Reveal Discovery */
  var autoRevealSelectors = [
    '.cat-sec',
    '.cake-card',
    '.menu-card',
    '.pcard',
    '.value',
    '.cls',
    '.panel:not(#admin-login)',
    '.stat-card',
    '.footer__col'
  ].join(',');

  var autoObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            autoObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -4% 0px' })
    : null;

  function registerAutoReveals() {
    if (!document.querySelectorAll) return;
    var nodes = document.querySelectorAll(autoRevealSelectors);
    Array.prototype.forEach.call(nodes, function (node, idx) {
      if (node.hasAttribute('data-reveal') || node.classList.contains('mb-auto-reveal')) return;
      node.classList.add('mb-auto-reveal');
      node.style.setProperty('--i', String(idx % 4));
      if (autoObserver) autoObserver.observe(node);
      else node.classList.add('is-in');
    });
  }
  registerAutoReveals();
  window.addEventListener('mb-catalogue-updated', function () {
    setTimeout(registerAutoReveals, 60);
  });

  /* 4. Interactive 3D Card Tilt & Warm Cursor Spotlight */
  var tiltSelector = '.pcard, .menu-card, .cake-card, .value, .cls, .stat-card';
  var activeTiltCard = null;

  document.addEventListener('pointermove', function (e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    var card = e.target && e.target.closest ? e.target.closest(tiltSelector) : null;
    if (activeTiltCard && activeTiltCard !== card) {
      activeTiltCard.classList.remove('mb-tilt-active');
      activeTiltCard.style.removeProperty('--rx');
      activeTiltCard.style.removeProperty('--ry');
      activeTiltCard = null;
    }
    if (!card || !card.getBoundingClientRect) return;
    var rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var px = Math.max(0, Math.min(1, x / rect.width));
    var py = Math.max(0, Math.min(1, y / rect.height));
    var rx = ((0.5 - py) * 5.2).toFixed(2) + 'deg';
    var ry = ((px - 0.5) * 5.2).toFixed(2) + 'deg';

    card.style.setProperty('--mx', Math.round(x) + 'px');
    card.style.setProperty('--my', Math.round(y) + 'px');
    card.style.setProperty('--rx', rx);
    card.style.setProperty('--ry', ry);
    card.classList.add('mb-tilt-active');
    activeTiltCard = card;
  }, { passive: true });

  document.addEventListener('pointerout', function (e) {
    if (!activeTiltCard) return;
    var rel = e.relatedTarget;
    if (!rel || (activeTiltCard.contains && !activeTiltCard.contains(rel))) {
      activeTiltCard.classList.remove('mb-tilt-active');
      activeTiltCard.style.removeProperty('--rx');
      activeTiltCard.style.removeProperty('--ry');
      activeTiltCard = null;
    }
  }, { passive: true });

  /* 5. Fly-to-Cart Golden Orb & Cart Shockwave Animation */
  function launchFlyToCart(sourceEl) {
    if (!sourceEl || !sourceEl.getBoundingClientRect) return;
    var cartBtn = document.querySelector('.cart-btn');
    if (!cartBtn || !cartBtn.getBoundingClientRect) return;

    var startRect = sourceEl.getBoundingClientRect();
    var endRect = cartBtn.getBoundingClientRect();
    if (!endRect.width && !endRect.height) return;

    var startX = startRect.left + startRect.width / 2 - 21;
    var startY = startRect.top + startRect.height / 2 - 21;
    var endX = endRect.left + endRect.width / 2 - 21;
    var endY = endRect.top + endRect.height / 2 - 21;

    var orb = document.createElement('div');
    orb.className = 'mb-fly-orb';
    orb.setAttribute('aria-hidden', 'true');

    /* Use item thumbnail if available on the card/row */
    var hostCard = sourceEl.closest ? sourceEl.closest('.vrow, .cake-card, .pcard, #cake-builder') : null;
    var imgEl = hostCard && hostCard.querySelector ? hostCard.querySelector('img') : null;
    if (imgEl && imgEl.getAttribute('src')) {
      orb.style.backgroundImage = 'url("' + imgEl.getAttribute('src') + '")';
    }

    orb.style.left = '0px';
    orb.style.top = '0px';
    orb.style.transform = 'translate3d(' + startX.toFixed(1) + 'px,' + startY.toFixed(1) + 'px,0) scale(1)';
    document.body.appendChild(orb);

    if (typeof orb.animate === 'function') {
      var midX = (startX + endX) / 2;
      var midY = Math.min(startY, endY) - 90;
      var anim = orb.animate([
        { transform: 'translate3d(' + startX.toFixed(1) + 'px,' + startY.toFixed(1) + 'px,0) scale(0.9)', opacity: 1 },
        { transform: 'translate3d(' + midX.toFixed(1) + 'px,' + midY.toFixed(1) + 'px,0) scale(1.15)', opacity: 0.96, offset: 0.45 },
        { transform: 'translate3d(' + endX.toFixed(1) + 'px,' + endY.toFixed(1) + 'px,0) scale(0.28)', opacity: 0.2 }
      ], {
        duration: 640,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      });
      anim.onfinish = function () {
        if (orb.parentNode) orb.parentNode.removeChild(orb);
        cartBtn.classList.remove('is-ripple');
        void cartBtn.offsetWidth;
        cartBtn.classList.add('is-ripple');
        setTimeout(function () { cartBtn.classList.remove('is-ripple'); }, 680);
      };
    } else {
      setTimeout(function () {
        if (orb.parentNode) orb.parentNode.removeChild(orb);
      }, 400);
    }
  }

  document.addEventListener('click', function (e) {
    var addBtn = e.target && e.target.closest ? e.target.closest('[data-add], #cake-add') : null;
    if (addBtn) launchFlyToCart(addBtn);
  });
})();
