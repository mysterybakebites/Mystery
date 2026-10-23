/* One place where the bundle percentages are written into the page.

   The percentages live in the admin settings (Payments, Payment and order
   rules) and the server prices every booking from them. Any sentence, badge or
   meta description that quotes a percentage carries a hook instead of a number:

     data-bundle-pct="two"    the element's text becomes "15%"
     data-bundle-pct="three"  the element's text becomes "25%"
     data-bundle-tier="two"   the whole block is hidden when that tier is 0
     data-bundle-text="..."   a template where {two} and {three} are filled in

   The built pages already carry the saved figures, so the HTML is correct without
   JavaScript. This script re-reads /api/config on load, so a percentage changed in
   the dashboard appears everywhere without rebuilding the site, and a tier set to
   zero disappears instead of advertising "0% off".
*/
(function () {
  'use strict';

  var DEFAULTS = { two: 15, three: 25 };

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.round(n) : fallback;
  }

  function template(text, two, three) {
    return String(text || '')
      .replace(/\{two\}/g, two + '%')
      .replace(/\{three\}/g, three + '%');
  }

  function apply(two, three) {
    var values = { two: two, three: three };

    document.querySelectorAll('[data-bundle-pct]').forEach(function (el) {
      var which = el.getAttribute('data-bundle-pct') === 'three' ? 'three' : 'two';
      el.textContent = values[which] + '%';
    });

    document.querySelectorAll('[data-bundle-tier]').forEach(function (el) {
      var which = el.getAttribute('data-bundle-tier') === 'three' ? 'three' : 'two';
      el.hidden = !values[which];
    });

    document.querySelectorAll('[data-bundle-text]').forEach(function (el) {
      var text = template(el.getAttribute('data-bundle-text'), two, three);
      if (el.tagName === 'META') el.setAttribute('content', text);
      else el.textContent = text;
    });

    document.documentElement.setAttribute('data-bundle-two', String(two));
    document.documentElement.setAttribute('data-bundle-three', String(three));
    window.MB_BUNDLE = values;
  }

  // the built figures first, so nothing waits on the network to be readable
  function built(which, fallback) {
    var el = document.querySelector('[data-bundle-pct="' + which + '"]');
    var n = el ? parseInt(String(el.textContent).replace(/[^0-9]/g, ''), 10) : NaN;
    return isFinite(n) ? n : fallback;
  }

  var html = document.documentElement;
  apply(
    num(html.getAttribute('data-bundle-two'), built('two', DEFAULTS.two)),
    num(html.getAttribute('data-bundle-three'), built('three', DEFAULTS.three))
  );

  function refreshBundleCopy() {
    MB.api('/api/config')
      .then(function (d) {
        var cfg = d && d.config;
        if (!cfg) return;
        apply(num(cfg.bundle_two_pct, DEFAULTS.two), num(cfg.bundle_three_pct, DEFAULTS.three));
      })
      .catch(function () { /* the built figures stay on screen */ });
  }

  refreshBundleCopy();
  window.addEventListener('mb-catalogue-updated', refreshBundleCopy);
  window.addEventListener('storage', function (e) {
    if (e.key === 'mb-local-db-v1') refreshBundleCopy();
  });
})();
