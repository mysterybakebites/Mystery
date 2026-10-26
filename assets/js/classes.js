/* ============================================================
   Mystery Bakebite: classes page
   Expandable course cards, multi-select booking summary and the
   per-track bundle discounts, using the percentages saved in the dashboard.
   ============================================================ */
(function () {
  'use strict';

  var state = {
    classes: [],
    selected: {},
    open: {},
    config: { two: 15, three: 25 }
  };

  var els = {};
  var STORE = 'mb-class-selection';

  /* Keep existing price formatting in the class cards unchanged */
  function cardMoney(pesewas) {
    return 'GH\u20B5 ' + (pesewas / 100).toLocaleString('en-GH', {
      minimumFractionDigits: pesewas % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  /* Standard accounting format for booking summary & discounts */
  function money(pesewas) {
    if (typeof pesewas !== 'number' || !isFinite(pesewas)) return 'GH\u20B5 0.00';
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

  var ICONS = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 016.5 3H20v18H6.5A2.5 2.5 0 014 18.5z"/><path d="M8 7h8M8 11h6"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M12 3l2.2 5.2L19 10l-4.8 1.8L12 17l-2.2-5.2L5 10l4.8-1.8z"/></svg>'
  };

  function list(items, empty) {
    if (!items || !items.length) return '<p class="cls__note">' + empty + '</p>';
    return '<ul>' + items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>';
  }

  function cardMarkup(c) {
    var isSel = !!state.selected[c.slug];
    var isOpen = !!state.open[c.slug];
    return '' +
      '<article class="cls' + (isSel ? ' is-selected' : '') + (isOpen ? ' is-open' : '') + '" data-slug="' + esc(c.slug) + '">' +
        '<div class="cls__head">' +
          '<button type="button" class="cls__check" data-select="' + esc(c.slug) + '" ' +
            'aria-pressed="' + isSel + '" aria-label="' +
            (isSel ? 'Remove ' : 'Select ') + esc(c.name) + ' from your booking">' + ICONS.tick + '</button>' +
          '<div class="cls__main">' +
            '<span class="cls__level">' + esc(c.levelLabel) + ' &middot; Level 0' + esc(c.level) + '</span>' +
            '<h3 class="cls__title">' + esc(c.name) + '</h3>' +
            '<p class="cls__summary">' + esc(c.summary) + '</p>' +
          '</div>' +
          '<div class="cls__fee">' +
            '<small>Course fee</small>' +
            '<b>' + cardMoney(c.fee) + '</b>' +
            '<i>' + esc(c.hours) + ' &middot; ingredients included</i>' +
          '</div>' +
        '</div>' +
        '<div class="cls__actions">' +
          '<button type="button" class="cls__toggle" data-toggle="' + esc(c.slug) + '" ' +
            'aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-controls="body-' + esc(c.slug) + '">' +
            '<span>' + (isOpen ? 'Hide details' : 'Course details') + '</span>' + ICONS.chev +
          '</button>' +
          '<span class="cls__spacer"></span>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-select="' + esc(c.slug) + '">' +
            (isSel ? 'Selected' : 'Select class') +
          '</button>' +
        '</div>' +
        '<div class="cls__body" id="body-' + esc(c.slug) + '">' +
          '<div class="cls__facts">' +
            '<span class="cls__fact">' + ICONS.clock + esc(c.hours) + '</span>' +
            '<span class="cls__fact">' + ICONS.cal + esc(c.schedule) + '</span>' +
            '<span class="cls__fact">' + ICONS.book + esc(c.recipes.length) + ' recipes taught</span>' +
          '</div>' +
          '<div class="cls__grid">' +
            '<div class="cls__block">' +
              '<h4>About this course</h4>' +
              '<p>' + esc(c.description) + '</p>' +
            '</div>' +
            '<div class="cls__block">' +
              '<h4>Recipes covered</h4>' +
              list(c.recipes, 'Recipes are confirmed when dates are agreed.') +
            '</div>' +
            '<div class="cls__block">' +
              '<h4>Skills you leave with</h4>' +
              '<p class="cls__levelnote">' + esc(c.levelLabel) + ' level, drawn from this level&rsquo;s own recipes.</p>' +
              list(c.skills, 'Skills are confirmed with the course outline.') +
            '</div>' +
            '<div class="cls__block">' +
              '<h4>What is provided</h4>' +
              list(c.provided, 'The school confirms what is provided when you book.') +
            '</div>' +
            '<div class="cls__block">' +
              '<h4>What to bring</h4>' +
              list(c.bring, '') +
              (c.bringNote ? '<p class="cls__note">' + esc(c.bringNote) + '</p>' : '') +
            '</div>' +
            '<div class="cls__block">' +
              '<h4>Prerequisite</h4>' +
              '<p>' + esc(c.prereq || 'None stated. Ask the school if you are unsure.') + '</p>' +
              '<p class="cls__note">Fee shown is the whole course for this level.</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function render() {
    var bread = state.classes.filter(function (c) { return c.track === 'bread'; });
    var pastry = state.classes.filter(function (c) { return c.track === 'pastry'; });
    if (els.bread) els.bread.innerHTML = bread.length ? bread.map(cardMarkup).join('') : '<p class="panel__hint">No bread courses are published right now.</p>';
    if (els.pastry) els.pastry.innerHTML = pastry.length ? pastry.map(cardMarkup).join('') : '<p class="panel__hint">No pastry courses are published right now.</p>';
    renderSummary();
  }

  function selectedList() {
    return state.classes.filter(function (c) { return state.selected[c.slug]; });
  }

  function calculate() {
    var chosen = selectedList();
    var original = chosen.reduce(function (s, c) { return s + c.fee; }, 0);
    var saved = 0;
    var notes = [];

    /* Rule: Class bundle discounts ONLY apply when 2 or more classes are selected */
    if (chosen.length >= 2) {
      var groups = { bread: [], pastry: [] };
      chosen.forEach(function (c) { groups[c.track].push(c); });
      var remaining = [];

      Object.keys(groups).forEach(function (track) {
        var g = groups[track];
        var pct = g.length >= 3 ? state.config.three : (g.length === 2 ? state.config.two : 0);
        if (pct > 0) {
          var groupTotal = g.reduce(function (s, c) { return s + c.fee; }, 0);
          var cut = Math.round(groupTotal * pct / 100);
          saved += cut;
          notes.push({
            track: track,
            percent: pct,
            amount: cut,
            count: g.length
          });
        } else if (g.length) {
          remaining = remaining.concat(g);
        }
      });

      if (remaining.length > 0 && chosen.length >= 2) {
        var crossPct = chosen.length >= 3 ? state.config.three : state.config.two;
        if (crossPct > 0) {
          var remTotal = remaining.reduce(function (s, c) { return s + c.fee; }, 0);
          var remCut = Math.round(remTotal * crossPct / 100);
          saved += remCut;
          notes.push({
            track: 'combined',
            percent: crossPct,
            amount: remCut,
            count: remaining.length
          });
        }
      }
    }

    return {
      chosen: chosen,
      original: original,
      saved: saved,
      total: original - saved,
      notes: notes
    };
  }

  function renderSummary() {
    if (!els.lines) return;
    var calc = calculate();

    if (!calc.chosen.length) {
      els.lines.innerHTML = '<p class="booking__empty">No classes selected yet. Tick a class to see the price and any bundle saving.</p>';
    } else {
      els.lines.innerHTML = calc.chosen.map(function (c) {
        return '<div class="booking__line">' +
          '<span>' + esc(c.name) + '<span class="summary-line__meta">' + esc(c.levelLabel) + ' &middot; ' +
          (c.track === 'bread' ? 'Bread' : 'Pastry') + ' track</span></span>' +
          '<span>' + money(c.fee) + '</span>' +
        '</div>';
      }).join('');
    }

    els.original.textContent = money(calc.original);
    els.saved.textContent = calc.saved ? '\u2212 ' + money(calc.saved) : money(0);
    if (els.savedLabel) {
      var applied = calc.notes.map(function (n) { return n.percent; });
      var pcts = applied.filter(function (v, i) { return applied.indexOf(v) === i; });
      els.savedLabel.textContent = pcts.length
        ? 'Bundle discount (' + pcts.join('% and ') + '%)'
        : 'Bundle discount';
    }
    els.total.textContent = money(calc.total);

    els.flags.innerHTML = calc.notes.map(function (n) {
      return '<div class="discount-flag">' + ICONS.spark +
        '<span><strong>' + n.percent + '% ' + n.track + ' bundle applied.</strong> ' +
        n.count + ' classes in this track save ' + money(n.amount) + '.</span></div>';
    }).join('') + (calc.chosen.length === 1 && state.config.two
      ? '<div class="discount-flag" style="background:rgba(245,230,214,.06);border-color:rgba(255,251,245,.16);color:rgba(245,230,214,.72)">' +
        ICONS.info + '<span>Add a second class in the same track to save ' + state.config.two + '%.</span></div>'
      : '');

    els.add.disabled = !calc.chosen.length;
    els.clear.hidden = !calc.chosen.length;
    els.add.textContent = calc.chosen.length
      ? 'Book ' + calc.chosen.length + ' class' + (calc.chosen.length > 1 ? 'es' : '')
      : 'Continue to class booking';
  }

  function syncCartFromSelected() {
    var cart = classCart();
    if (!cart || !state.classes.length) return;
    var chosen = selectedList();
    cart.clear();
    chosen.forEach(function (c) {
      cart.add({
        id: 'class-' + c.slug,
        kind: 'class',
        slug: c.slug,
        name: c.name,
        meta: c.levelLabel + ' level \u00b7 ' + (c.track === 'bread' ? 'Bread' : 'Pastry') + ' track \u00b7 ' + c.hours,
        image: c.track === 'pastry' ? 'assets/img/school-pastry.webp' : 'assets/img/school-bread.webp',
        unitPrice: c.fee,
        qty: 1
      });
    });
  }

  function toggleSelected(slug) {
    if (state.selected[slug]) delete state.selected[slug];
    else state.selected[slug] = true;
    persist();
    syncCartFromSelected();
    render();
    var card = document.querySelector('.cls[data-slug="' + slug + '"]');
    if (card) {
      var btn = card.querySelector('.cls__check');
      if (btn) btn.focus({ preventScroll: true });
    }
  }

  function persist() {
    try { sessionStorage.setItem(STORE, JSON.stringify(Object.keys(state.selected))); } catch (e) { }
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(STORE);
      if (raw) {
        var keys = JSON.parse(raw);
        if (Array.isArray(keys) && keys.length) {
          keys.forEach(function (k) { state.selected[k] = true; });
          return;
        }
      }
    } catch (e) { }
    var cart = classCart();
    if (cart && cart.items().length) {
      cart.items().forEach(function (it) {
        var s = it.slug || String(it.id || '').replace(/^class-/, '');
        if (s) state.selected[s] = true;
      });
    }
  }

  // classes live in their own cart and are checked out on booking.html
  function classCart() {
    return window.MBCarts ? window.MBCarts.class : null;
  }

  function addToCart() {
    var chosen = selectedList();
    var cart = classCart();
    if (!chosen.length || !cart) return;
    syncCartFromSelected();
    window.location.href = 'booking.html';
  }

  /* ------------------------------------------------------------------ *
   * Course loading, with an honest failure state
   *
   * The page used to render "Courses could not be loaded" and blank the
   * pastry column on ANY failure, with no way to recover except a manual
   * refresh. It also had no path for "the call worked but returned nothing",
   * which is what an empty classes table looks like.
   *
   * Each outcome now gets its own message and a Try again button, because the
   * causes need different actions from the person reading them:
   *   network / PGRST   -> a real connection or deployment problem
   *   not_configured    -> MB_CONFIG has no project URL
   *   empty catalogue   -> the query worked; the kitchen simply has nothing
   *                        published, which is a bakery task, not a bug
   * ------------------------------------------------------------------ */

  function failureMarkup(message, detail) {
    return '<div class="alert alert--error classes-failure">' + ICONS.info +
      '<div><strong>' + esc(message) + '</strong>' +
      (detail ? '<br><span class="classes-failure__detail">' + esc(detail) + '</span>' : '') +
      '<div style="margin-top:.9rem"><button type="button" class="btn btn--gold btn--sm" id="classes-retry">Try again</button></div>' +
      '</div></div>';
  }

  function showLoading() {
    if (els.bread) els.bread.innerHTML = '<p class="panel__hint">Loading the bread courses\u2026</p>';
    if (els.pastry) els.pastry.innerHTML = '<p class="panel__hint">Loading the pastry courses\u2026</p>';
  }

  function showFailure(message, detail) {
    var html = failureMarkup(message, detail);
    /* Both columns get the message: showing it once and leaving the other
       column empty is what made the page look half-broken. */
    if (els.bread) els.bread.innerHTML = html;
    if (els.pastry) els.pastry.innerHTML = html;
  }

  function messageFor(res) {
    var code = (res && res.code) || '';
    if (code === 'not_configured') {
      return {
        message: 'The course list is not connected yet.',
        detail: 'The website has no bakery database configured. Please message the kitchen and we will take your booking directly.'
      };
    }
    if (code === 'PGRST202' || code === '42883') {
      return {
        message: 'The course service is not available yet.',
        detail: 'The bakery database is missing a required step. Please try again shortly, or message the kitchen to book.'
      };
    }
    if (code === 'network' || code === 'Failed to fetch') {
      return {
        message: 'We could not reach the bakery.',
        detail: 'Check your internet connection, then try again.'
      };
    }
    if (code === 'unauthorised' || code === '42501') {
      return {
        message: 'The course list is not publicly available right now.',
        detail: 'Please try again shortly, or message the kitchen to book directly.'
      };
    }
    return {
      message: 'Courses could not be loaded.',
      detail: 'This is usually temporary. Try again, or message the kitchen and we will help you book.'
    };
  }

  function loadCourses() {
    showLoading();
    MB.api('/api/catalogue').then(function (data) {
      if (!data || !data.ok) {
        var m = messageFor(data);
        showFailure(m.message, m.detail);
        return;
      }

      state.classes = Array.isArray(data.classes) ? data.classes : [];

      if (data.config) {
        state.config = {
          two: Number(data.config.bundle_two_pct),
          three: Number(data.config.bundle_three_pct)
        };
        if (!isFinite(state.config.two)) state.config.two = 15;
        if (!isFinite(state.config.three)) state.config.three = 25;
      }

      /* The call succeeded but there is nothing to show. Say so plainly —
         an empty grid reads as a broken page. */
      if (!state.classes.length) {
        if (els.bread) {
          els.bread.innerHTML = '<div class="alert">' + ICONS.info +
            '<div><strong>No courses are open for booking at the moment.</strong>' +
            '<br><span class="classes-failure__detail">The kitchen publishes each intake here. Message us and we will tell you when the next one starts.</span></div></div>';
        }
        if (els.pastry) els.pastry.innerHTML = '';
        return;
      }

      state.loaded = true;
      render();

      var hash = window.location.hash;
      if (hash) {
        var target = null;
        try { target = document.querySelector(hash); } catch (e) { target = null; }
        if (target) target.scrollIntoView({ block: 'start' });
      }
    }).catch(function () {
      /* MB.api normally resolves with {ok:false}; this covers a thrown error
         or a rejected promise so the page can never hang on "Loading…". */
      showFailure('We could not reach the bakery.', 'Check your internet connection, then try again.');
    });
  }

  function init() {
    els.bread = document.getElementById('classes-bread');
    els.pastry = document.getElementById('classes-pastry');
    els.lines = document.getElementById('booking-lines');
    els.original = document.getElementById('booking-original');
    els.saved = document.getElementById('booking-saved');
    els.savedLabel = document.getElementById('booking-saved-label');
    els.total = document.getElementById('booking-total');
    els.flags = document.getElementById('booking-flags');
    els.add = document.getElementById('booking-add');
    els.clear = document.getElementById('booking-clear');

    restore();

    loadCourses();

    /* Retry is a delegated listener so it survives re-rendering the panel. */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('#classes-retry');
      if (!btn) return;
      e.preventDefault();
      loadCourses();
    });

    document.addEventListener('click', function (e) {
      var head = e.target.closest('.cls__head');
      if (head && !e.target.closest('button') && !e.target.closest('a')) {
        var cardEl = head.closest('.cls');
        var slugHead = cardEl.getAttribute('data-slug');
        var opened = cardEl.classList.toggle('is-open');
        if (opened) state.open[slugHead] = true; else delete state.open[slugHead];
        var t = cardEl.querySelector('.cls__toggle');
        if (t) {
          t.setAttribute('aria-expanded', opened ? 'true' : 'false');
          var l = t.querySelector('span');
          if (l) l.textContent = opened ? 'Hide details' : 'Course details';
        }
        return;
      }

      var sel = e.target.closest('[data-select]');
      if (sel) { e.preventDefault(); toggleSelected(sel.getAttribute('data-select')); return; }

      var tog = e.target.closest('[data-toggle]');
      if (tog) {
        e.preventDefault();
        var card = tog.closest('.cls');
        var open = card.classList.toggle('is-open');
        if (open) state.open[card.getAttribute('data-slug')] = true;
        else delete state.open[card.getAttribute('data-slug')];
        tog.setAttribute('aria-expanded', open ? 'true' : 'false');
        var label = tog.querySelector('span');
        if (label) label.textContent = open ? 'Hide details' : 'Course details';
        return;
      }
    });

    if (els.add) els.add.addEventListener('click', addToCart);
    if (els.clear) els.clear.addEventListener('click', function () {
      state.selected = {};
      persist();
      syncCartFromSelected();
      render();
    });

    document.addEventListener('mb-booking-updated', function (ev) {
      if (!state.classes.length) return;
      var items = (ev && ev.detail && Array.isArray(ev.detail.items)) ? ev.detail.items : [];
      var nextSel = {};
      items.forEach(function (it) {
        var s = it.slug || String(it.id || '').replace(/^class-/, '');
        if (s) nextSel[s] = true;
      });
      var curKeys = Object.keys(state.selected).sort().join(',');
      var nextKeys = Object.keys(nextSel).sort().join(',');
      if (curKeys !== nextKeys) {
        state.selected = nextSel;
        persist();
        render();
      }
    });

    function reloadClassCatalogue() {
      MB.api('/api/catalogue').then(function (data) {
        if (!data || !data.ok) return;
        state.classes = data.classes || state.classes;
        if (data.config) {
          state.config = {
            two: Number(data.config.bundle_two_pct),
            three: Number(data.config.bundle_three_pct)
          };
          if (!isFinite(state.config.two)) state.config.two = 15;
          if (!isFinite(state.config.three)) state.config.three = 25;
        }
        render();
      }).catch(function () {});
    }

    window.addEventListener('mb-catalogue-updated', reloadClassCatalogue);
    window.addEventListener('storage', function (e) {
      if (e.key === 'mb-local-db-v1') reloadClassCatalogue();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
