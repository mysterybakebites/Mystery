/* ============================================================================
   Mystery Bakebite — Business contact profile (browser side)

   ONE source of truth
   -------------------
   The bakery's contact details are stored in the `settings` row of the
   Supabase database and published to every visitor through api_config()
   as the `contact` object. This file is the only code that renders them.

   Pages no longer contain a phone number, an email address, a WhatsApp link,
   an Instagram URL, an address or an opening time. They contain empty
   placeholders that name a field:

       <a data-contact-link="whatsapp" data-contact-msg="...">Chat</a>
       <a data-contact-link="phone">Call us</a>
       <span data-contact="hours"></span>

   This module fills every placeholder on the page from one fetch.

   Fallback behaviour
   ------------------
   DEFAULTS below is used only when the database cannot be reached (offline,
   blocked, misconfigured project). It mirrors what the bakery was publishing
   before this was centralised, so the site degrades to its current appearance
   rather than to blank space. It is deliberately the ONLY hardcopy of these
   values in the codebase.

   The module never blanks an element. If a field is missing or invalid it
   keeps the previous value, so a half-filled settings row cannot make the
   footer lose the phone number.
   ========================================================================== */
(function () {
  'use strict';

  var MB = window.MB = window.MB || {};

  /* Used only when the database is unreachable. Mirrors the published values. */
  var DEFAULTS = {
    businessName: 'Mystery Bakebite',
    tagline: 'Home bakery & baking school',
    phone: '233554520532',
    phoneDisplay: '+233 55 452 0532',
    email: 'mysterybakebites@gmail.com',
    whatsapp: '233554520532',
    whatsappMessage: "Hello Mystery Bakebite, I'd like to place an order.",
    alerts: '233554520532',
    address: {
      line1: '', line2: '', city: 'Tamale',
      region: 'Northern Region', country: 'Ghana', mapUrl: ''
    },
    hours: {
      days: 'Monday to Sunday', open: '08:00', close: '19:00',
      note: 'Messages are answered during opening hours.'
    },
    social: {
      instagram: 'https://www.instagram.com/mysterybakebites/',
      facebook: '', tiktok: '', x: '', youtube: ''
    }
  };

  var CACHE_KEY = 'mb-contact-v1';
  var cache = null;
  var ready = null;

  /* ------------------------------------------------------------------ *
   * Normalising
   * ------------------------------------------------------------------ */

  function digits(v) {
    return String(v == null ? '' : v).replace(/\D/g, '');
  }

  /** A phone number is usable when it has 7–15 digits. */
  function validPhone(v) {
    var d = digits(v);
    return d.length >= 7 && d.length <= 15 ? d : '';
  }

  function validEmail(v) {
    var s = String(v == null ? '' : v).trim();
    return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s) ? s.toLowerCase() : '';
  }

  function validUrl(v) {
    var s = String(v == null ? '' : v).trim();
    return /^https?:\/\/\S+$/i.test(s) ? s : '';
  }

  /** "08:00" -> "8:00am" */
  function clock(t) {
    var m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(String(t || '').trim());
    if (!m) return '';
    var h = parseInt(m[1], 10), min = m[2];
    var suffix = h < 12 ? 'am' : 'pm';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + min + suffix;
  }

  function pick(good, fallback) {
    return good ? good : fallback;
  }

  /**
   * Merge a server contact object over the defaults, field by field, keeping
   * the fallback for anything missing or invalid. This is what makes a partial
   * settings row harmless.
   */
  function normalise(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var addr = (r.address && typeof r.address === 'object') ? r.address : {};
    var hours = (r.hours && typeof r.hours === 'object') ? r.hours : {};
    var social = (r.social && typeof r.social === 'object') ? r.social : null;
    var socialSrc = social || DEFAULTS.social;
    var D = DEFAULTS;

    var phone = pick(validPhone(r.phone), D.phone);
    var whatsapp = pick(validPhone(r.whatsapp), pick(phone, D.whatsapp));
    var open = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(hours.open || '') ? hours.open : D.hours.open;
    var close = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(hours.close || '') ? hours.close : D.hours.close;

    return {
      businessName: pick(String(r.businessName || '').trim(), D.businessName),
      tagline: pick(String(r.tagline == null ? '' : r.tagline).trim(), D.tagline),
      phone: phone,
      phoneDisplay: pick(String(r.phoneDisplay || '').trim(), D.phoneDisplay),
      email: pick(validEmail(r.email), D.email),
      whatsapp: whatsapp,
      whatsappMessage: pick(String(r.whatsappMessage || '').trim(), D.whatsappMessage),
      alerts: pick(validPhone(r.alerts), whatsapp),
      address: {
        line1: String(addr.line1 || D.address.line1 || ''),
        line2: String(addr.line2 || D.address.line2 || ''),
        city: pick(String(addr.city || '').trim(), D.address.city),
        region: pick(String(addr.region || '').trim(), D.address.region),
        country: pick(String(addr.country || '').trim(), D.address.country),
        mapUrl: validUrl(addr.mapUrl)
      },
      hours: {
        days: pick(String(hours.days || '').trim(), D.hours.days),
        open: open,
        close: close,
        note: String(hours.note == null ? D.hours.note : hours.note)
      },
      /* When the database sends a `social` object, honour it exactly: a key
         arriving empty means the administrator removed that channel, so the
         control is hidden rather than repointed at a stale default. Only when
         no social object arrived at all (offline, older database) do the
         DEFAULTS apply. */
      social: {
        instagram: validUrl(socialSrc.instagram),
        facebook: validUrl(socialSrc.facebook),
        tiktok: validUrl(socialSrc.tiktok),
        x: validUrl(socialSrc.x),
        youtube: validUrl(socialSrc.youtube)
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Derived strings
   * ------------------------------------------------------------------ */

  /** "Tamale, Northern Region, Ghana" — skips blanks, never leaves ", ," */
  function addressLine(c, opts) {
    var o = opts || {};
    var a = c.address;
    var parts;
    if (o.cityOnly) parts = [a.city];
    else if (o.regionOnly) parts = [a.city, a.region];
    else parts = [a.line1, a.line2, a.city, a.region, a.country];
    return parts
      .map(function (x) { return String(x || '').trim(); })
      .filter(Boolean)
      .join(', ');
  }

  /** "Monday to Sunday, 8:00am – 7:00pm" */
  function hoursLine(c) {
    var h = c.hours;
    var time = (h.open && h.close) ? (clock(h.open) + ' \u2013 ' + clock(h.close)) : '';
    if (h.days && time) return h.days + ', ' + time;
    return h.days || time || '';
  }

  function waLink(c, message) {
    var num = digits(c.whatsapp);
    if (!num) return '';
    var text = message || c.whatsappMessage || '';
    return 'https://wa.me/' + num + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  /* ------------------------------------------------------------------ *
   * Applying to the DOM
   * ------------------------------------------------------------------ */

  function value(c, field, el) {
    switch (field) {
      case 'businessName': return c.businessName;
      case 'tagline': return c.tagline;
      case 'phone': return c.phoneDisplay || ('+' + c.phone);
      case 'phoneRaw': return c.phone;
      case 'email': return c.email;
      case 'whatsapp': return '+' + c.whatsapp;
      case 'address': return addressLine(c);
      case 'addressRegion': return addressLine(c, { regionOnly: true });
      case 'addressShort': return [c.address.city, c.address.country]
        .map(function (x) { return String(x || '').trim(); })
        .filter(Boolean).join(', ');
      case 'addressCity': return addressLine(c, { cityOnly: true });
      case 'city': return c.address.city;
      case 'region': return c.address.region;
      case 'country': return c.address.country;
      case 'hours': return hoursLine(c);
      case 'hoursDays': return c.hours.days;
      case 'hoursTime': return (c.hours.open && c.hours.close)
        ? clock(c.hours.open) + ' \u2013 ' + clock(c.hours.close) : '';
      case 'hoursNote': return c.hours.note;
      case 'instagramHandle': {
        var m = /instagram\.com\/([^\/?#]+)/i.exec(c.social.instagram || '');
        return m ? '@' + m[1].replace(/\/$/, '') : '';
      }
      default: {
        if (c.social && Object.prototype.hasOwnProperty.call(c.social, field)) {
          return c.social[field];
        }
        return '';
      }
    }
  }

  function hrefFor(c, field, el) {
    switch (field) {
      case 'phone': return c.phone ? 'tel:+' + digits(c.phone) : '';
      case 'email': return c.email ? 'mailto:' + c.email : '';
      case 'whatsapp': {
        var msg = el && el.getAttribute('data-contact-msg');
        return waLink(c, msg);
      }
      case 'addressMap': return c.address.mapUrl;
      default: {
        if (c.social && Object.prototype.hasOwnProperty.call(c.social, field)) {
          return c.social[field] || '';
        }
        return '';
      }
    }
  }

  function setText(el, text) {
    if (text == null || text === '') return false;
    el.textContent = text;
    return true;
  }

  function apply(root, c) {
    var scope = root || document;

    /* Text placeholders */
    var nodes = scope.querySelectorAll('[data-contact]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var field = el.getAttribute('data-contact');
      setText(el, value(c, field, el));
    }

    /* Link placeholders */
    var links = scope.querySelectorAll('[data-contact-link]');
    for (var j = 0; j < links.length; j++) {
      var a = links[j];
      var f = a.getAttribute('data-contact-link');
      var href = hrefFor(c, f, a);

      if (!href) {
        /* No value for this channel: hide the control instead of shipping a
           dead link or an empty href that reloads the page. */
        a.setAttribute('hidden', 'hidden');
        a.setAttribute('aria-disabled', 'true');
        continue;
      }
      a.removeAttribute('hidden');
      a.removeAttribute('aria-disabled');
      a.setAttribute('href', href);
      if (f !== 'email' && f !== 'phone' && /^https?:/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      } else {
        a.removeAttribute('target');
      }
      /* Optional visible label inside the link */
      var labelField = a.getAttribute('data-contact-label');
      if (labelField) {
        var labelEl = a.querySelector('[data-contact-text]') || a;
        setText(labelEl, value(c, labelField, a));
      }
    }

    /* Elements that both display a value and link from it */
    var both = scope.querySelectorAll('[data-contact][data-contact-link]');
    for (var k = 0; k < both.length; k++) {
      /* already handled above; kept explicit so the intent is visible */
    }

    /* Map links get the address as their accessible name */
    var maps = scope.querySelectorAll('[data-contact-map]');
    for (var m2 = 0; m2 < maps.length; m2++) {
      var addr = addressLine(c);
      if (!c.address.mapUrl) {
        maps[m2].setAttribute('hidden', 'hidden');
        continue;
      }
      maps[m2].removeAttribute('hidden');
      maps[m2].setAttribute('href', c.address.mapUrl);
      if (addr) maps[m2].setAttribute('aria-label', 'Open ' + addr + ' in Maps');
    }

    /* Document title suffix / copyright line, if a page opts in */
    var yearEl = document.getElementById('year');
    if (yearEl && !yearEl.textContent.trim()) yearEl.textContent = String(new Date().getFullYear());

    return c;
  }

  /* ------------------------------------------------------------------ *
   * Loading
   * ------------------------------------------------------------------ */

  function readCache() {
    if (cache) return cache;
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        cache = normalise(JSON.parse(raw));
        return cache;
      }
    } catch (e) { }
    return null;
  }

  function writeCache(raw) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(raw)); } catch (e) { }
  }

  /**
   * Resolve the contact profile. Applies the cached/defaults copy immediately
   * so the page is never blank, then refreshes from the database.
   * Always resolves; never rejects.
   */
  function load(opts) {
    var o = opts || {};

    /* Paint immediately from cache or defaults. */
    var immediate = readCache() || normalise(null);
    cache = immediate;
    apply(document, immediate);

    if (ready && !o.force) return ready;

    ready = new Promise(function (resolve) {
      if (!window.MB || typeof window.MB.api !== 'function') {
        return resolve(immediate);
      }
      Promise.resolve(window.MB.api('/api/config')).then(function (res) {
        var cfg = res && (res.config || res);
        var raw = cfg && cfg.contact;
        if (!raw || typeof raw !== 'object') {
          /* Older database without the contact block: keep the fallback. */
          return resolve(immediate);
        }
        var merged = normalise(raw);
        cache = merged;
        writeCache(raw);
        apply(document, merged);
        try {
          document.dispatchEvent(new CustomEvent('mb:contact-ready', { detail: merged }));
        } catch (e) { }
        resolve(merged);
      }).catch(function () {
        resolve(immediate);
      });
    });

    return ready;
  }

  MB.contact = {
    DEFAULTS: DEFAULTS,
    load: load,
    apply: apply,
    get: function () { return cache || readCache() || normalise(null); },
    /* Helpers other modules reuse so they never hardcode a number either. */
    waLink: function (message) { return waLink(MB.contact.get(), message); },
    alertsNumber: function () { return digits(MB.contact.get().alerts); },
    addressLine: function (opts) { return addressLine(MB.contact.get(), opts); },
    hoursLine: function () { return hoursLine(MB.contact.get()); },
    clock: clock
  };

  /* Apply as soon as the DOM is ready — every page loads this file. */
  function boot() { load(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
