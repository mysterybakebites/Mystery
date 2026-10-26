/* ============================================================================
   Mystery Bakebite: Supabase client

   The site is static. Everything that used to be a call to the Python server is
   now a call to this file, which talks to Supabase over HTTPS:

     * Postgres functions  -> /rest/v1/rpc/<name>
     * sign in / sign out  -> /auth/v1/...
     * payment screenshots -> /storage/v1/object/proofs/...

   Only the public "anon" key lives here. It is safe to publish because every
   rule is enforced by Row Level Security and by the database functions; the
   key can read the published catalogue and call the public functions, nothing
   else. The service-role key must never appear in this file or anywhere else
   the browser can see.

   No third-party library is loaded: the REST surface is small and stable, and
   keeping the dependency out means the site still works when a CDN is blocked.
   ========================================================================== */
window.MB = window.MB || {};

(function (MB) {
  'use strict';

  var CFG = window.MB_CONFIG || {};
  function readMetaConfig(name) {
    try {
      if (typeof document === 'undefined' || !document.querySelector) return '';
      var m = document.querySelector('meta[name="' + name + '"]');
      return m ? String(m.getAttribute('content') || '').trim() : '';
    } catch (_) { return ''; }
  }
  var URL_BASE = String(CFG.url || readMetaConfig('supabase-url') || '').replace(/\/+$/, '');
  var ANON = String(CFG.anonKey || readMetaConfig('supabase-anon-key') || '');
  var SESSION_KEY = 'mb-session-v1';
  var TIMEOUT = 25000;
  var PRIMARY_SUPER_ADMIN_EMAIL = 'mysterybakebites@gmail.com';
  MB.PRIMARY_SUPER_ADMIN_EMAIL = PRIMARY_SUPER_ADMIN_EMAIL;

  /* Security Guard 1: Enforce HTTPS on remote Supabase URL (except localhost) */
  if (/^http:\/\/(?!localhost\b|127\.0\.0\.1\b)/i.test(URL_BASE)) {
    URL_BASE = URL_BASE.replace(/^http:\/\//i, 'https://');
  }

  /* Security Guard 2: Reject service_role JWTs if accidentally placed in MB_CONFIG.anonKey */
  (function guardAnonKey() {
    if (!ANON) return;
    try {
      var parts = ANON.split('.');
      if (parts.length === 3 && typeof atob === 'function') {
        var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var claims = JSON.parse(atob(b64));
        if (claims && String(claims.role || '').toLowerCase() === 'service_role') {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[Security Error] A Supabase service_role key was detected in MB_CONFIG.anonKey and blocked. Only the public anon key is permitted in browser code.');
          }
          ANON = '';
        }
      }
    } catch (_) {}
  })();

  MB.remoteConfigured = !!(URL_BASE && ANON);
  MB.localMode = !MB.remoteConfigured;
  MB.configured = true;
  MB.url = URL_BASE;

  /* ---------- Rate limiting & in-flight concurrency locks ---------- */
  var RATE_BUCKETS = {};
  var IN_FLIGHT_PROOFS = {};
  var IN_FLIGHT_ORDERS = {};

  function checkRateLimit(bucket, key, maxAttempts, windowMs) {
    var k = String(bucket) + ':' + String(key || 'global').toLowerCase();
    var now = Date.now();
    var entry = RATE_BUCKETS[k];
    if (!entry || now - entry.start > windowMs) {
      entry = { count: 0, start: now, lockedUntil: 0 };
      RATE_BUCKETS[k] = entry;
    }
    if (entry.lockedUntil && now < entry.lockedUntil) {
      var waitSec = Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
      return {
        allowed: false,
        retryAfter: waitSec,
        error: 'Too many attempts. Please wait ' + waitSec + ' seconds before trying again.'
      };
    }
    if (entry.count >= maxAttempts) {
      entry.lockedUntil = now + windowMs;
      var lockSec = Math.max(1, Math.ceil(windowMs / 1000));
      return {
        allowed: false,
        retryAfter: lockSec,
        error: 'Too many attempts. Please wait ' + lockSec + ' seconds before trying again.'
      };
    }
    return {
      allowed: true,
      recordFailure: function () {
        entry.count += 1;
        if (entry.count >= maxAttempts) {
          entry.lockedUntil = Date.now() + windowMs;
        }
      },
      reset: function () {
        delete RATE_BUCKETS[k];
      }
    };
  }

  /* ---------- Binary magic-byte image verification ---------- */
  var MAX_PROOF_BYTES = 5 * 1024 * 1024; // 5 MB

  function checkMagicBytes(bytes) {
    if (!bytes || bytes.length < 12) return { valid: false, format: null };
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
    ) {
      return { valid: true, format: 'png', mime: 'image/png' };
    }
    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return { valid: true, format: 'jpg', mime: 'image/jpeg' };
    }
    // WebP: "RIFF" (52 49 46 46) .... "WEBP" (57 45 42 50)
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return { valid: true, format: 'webp', mime: 'image/webp' };
    }
    return { valid: false, format: null };
  }

  function verifyImageDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') {
      return { ok: false, code: 'invalid_image', error: 'No image data provided.' };
    }
    var m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
    if (!m) {
      return {
        ok: false,
        code: 'invalid_image',
        error: 'Invalid image format. Only PNG, JPEG, and WebP screenshots are accepted.'
      };
    }
    var b64 = m[2].replace(/\s+/g, '');
    var approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes < 16) {
      return { ok: false, code: 'invalid_image', error: 'The uploaded image file is empty or corrupted.' };
    }
    if (approxBytes > MAX_PROOF_BYTES) {
      return { ok: false, code: 'file_too_large', error: 'The screenshot exceeds the 5 MB maximum size limit.' };
    }
    try {
      var headB64 = b64.slice(0, 64);
      var bin = typeof atob === 'function' ? atob(headB64) : Buffer.from(headB64, 'base64').toString('binary');
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var magic = checkMagicBytes(bytes);
      if (!magic.valid) {
        return {
          ok: false,
          code: 'invalid_image_signature',
          error: 'The selected file is not a valid PNG, JPEG, or WebP image (file signature check failed).'
        };
      }
      // Guard against embedded script/HTML tags inside small payloads
      var sampleBin = typeof atob === 'function'
        ? atob(b64.slice(0, Math.min(b64.length, 4096)))
        : Buffer.from(b64.slice(0, Math.min(b64.length, 4096)), 'base64').toString('binary');
      if (/<\s*(script|svg|html|iframe|object|embed)\b/i.test(sampleBin)) {
        return {
          ok: false,
          code: 'unsafe_image_content',
          error: 'The uploaded file contains unsafe embedded content and was rejected.'
        };
      }
      return { ok: true, ext: magic.format, mime: magic.mime, size: approxBytes };
    } catch (_) {
      return { ok: false, code: 'invalid_image', error: 'The screenshot could not be decoded. Please try another image.' };
    }
  }

  MB.verifyImageDataUrl = verifyImageDataUrl;
  MB.checkMagicBytes = checkMagicBytes;

  /* Frontend file validator that inspects magic bytes & size before preview/upload */
  MB.validateImageFile = function (file) {
    return new Promise(function (resolve) {
      if (!file) {
        resolve({ ok: false, error: 'No file selected.' });
        return;
      }
      if (!/^image\/(png|jpe?g|webp)$/i.test(String(file.type || ''))) {
        resolve({ ok: false, error: 'Invalid file format. Please choose a PNG, JPEG or WebP screenshot.' });
        return;
      }
      var fName = String(file.name || '').toLowerCase();
      if (/\.(svg|html?|js|php|exe|sh|bat|cmd|py|pl|jsp|asp)$/i.test(fName)) {
        resolve({ ok: false, error: 'Executable or script files are not allowed.' });
        return;
      }
      if (file.size < 16) {
        resolve({ ok: false, error: 'That file appears to be empty or corrupted.' });
        return;
      }
      if (file.size > MAX_PROOF_BYTES) {
        resolve({ ok: false, error: 'That screenshot is larger than 5 MB. Please choose a smaller image.' });
        return;
      }
      if (typeof FileReader === 'undefined') {
        resolve({ ok: true, dataUrl: '' });
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () {
        resolve({ ok: false, error: 'Could not read the selected image file.' });
      };
      reader.onload = function () {
        var dataUrl = String(reader.result || '');
        var check = verifyImageDataUrl(dataUrl);
        if (!check.ok) {
          resolve({ ok: false, error: check.error });
          return;
        }
        resolve({ ok: true, dataUrl: dataUrl, ext: check.ext, mime: check.mime, size: file.size });
      };
      reader.readAsDataURL(file);
    });
  };

  /* ---------- Local static database fallback (when MB_CONFIG is blank) ---------- */
  var LOCAL_DB_KEY = 'mb-local-db-v1';
  var LOCAL_MEM = null;
  var LOCAL_SEED = {"categories": [{"slug": "milky-doughnuts", "name": "Milky Doughnuts", "intro": "Soft, creamy and fresh, made in small batches.", "published": true}, {"slug": "mini-doughnuts", "name": "Mini Doughnuts & Doughnut Balls", "intro": "Bite-sized, finished with chocolate syrup.", "published": true}, {"slug": "cake-slices", "name": "Cake Slices", "intro": "A slice, a tasting box, or a full flavour box.", "published": true}, {"slug": "cake-loaves", "name": "Loaves & Bread", "intro": "Banana and vanilla loaves, plain or topped.", "published": true}, {"slug": "cookies", "name": "Cookies", "intro": "Chocolate and butter cookies, packed to gift or share.", "published": true}, {"slug": "cupcakes", "name": "Cupcakes", "intro": "Iced and finished by hand, in boxes of six, eight or twelve.", "published": true}, {"slug": "parfait", "name": "Parfait", "intro": "Layered cake parfait by the cup or the bowl.", "published": true}, {"slug": "chips", "name": "Chips", "intro": "Fried or baked, in three sizes, for an everyday savoury order.", "published": true}, {"slug": "celebration", "name": "Celebration Cakes", "intro": "Fourteen varieties, from a bento gift cake to a three-tier wedding cake. Add one to your cart and the baker confirms the final design and price with you.", "published": true}], "products": [{"sku": "milky-2", "name": "Milky donuts, 2 pcs", "category": "milky-doughnuts", "price": 3000, "meta": "2 pieces", "description": "", "image": "milky-doughnuts-new.webp", "prepDays": 0, "published": true}, {"sku": "milky-3", "name": "Milky donuts, 3 pcs", "category": "milky-doughnuts", "price": 4200, "meta": "3 pieces", "description": "", "image": "milky-doughnuts-new.webp", "prepDays": 0, "published": true}, {"sku": "milky-6", "name": "Milky donuts, 6 pcs", "category": "milky-doughnuts", "price": 7500, "meta": "Half dozen", "description": "", "image": "milky-doughnuts-new.webp", "prepDays": 0, "published": true}, {"sku": "milky-12", "name": "Milky donuts, 12 pcs", "category": "milky-doughnuts", "price": 14000, "meta": "Dozen", "description": "", "image": "milky-doughnuts-new.webp", "prepDays": 1, "published": true}, {"sku": "mini-10", "name": "Mini donuts, pack of 10", "category": "mini-doughnuts", "price": 3500, "meta": "Pack of 10", "description": "", "image": "hero-doughnut.webp", "prepDays": 0, "published": true}, {"sku": "balls-12", "name": "Mini donut balls, pack of 12", "category": "mini-doughnuts", "price": 3000, "meta": "Pack of 12", "description": "", "image": "hero-doughnut.webp", "prepDays": 0, "published": true}, {"sku": "balls-25", "name": "Mini donut balls, pack of 25", "category": "mini-doughnuts", "price": 5500, "meta": "Pack of 25", "description": "", "image": "hero-doughnut.webp", "prepDays": 0, "published": true}, {"sku": "slice-classic", "name": "Classic slice", "category": "cake-slices", "price": 3500, "meta": "One slice", "description": "", "image": "prod-slices.webp", "prepDays": 0, "published": true}, {"sku": "slice-signature", "name": "Signature slice", "category": "cake-slices", "price": 4000, "meta": "One slice", "description": "", "image": "prod-slices.webp", "prepDays": 0, "published": true}, {"sku": "tasting-box", "name": "Tasting box, 4 half-slices", "category": "cake-slices", "price": 7000, "meta": "4 half-slices", "description": "", "image": "prod-slices.webp", "prepDays": 1, "published": true}, {"sku": "flavour-box", "name": "Full flavour box, 4 full slices", "category": "cake-slices", "price": 13000, "meta": "4 full slices", "description": "", "image": "prod-slices.webp", "prepDays": 1, "published": true}, {"sku": "banana-small-plain", "name": "Banana loaf, small, plain", "category": "cake-loaves", "price": 3500, "meta": "Small", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "banana-small-topped", "name": "Banana loaf, small, topped", "category": "cake-loaves", "price": 4500, "meta": "Small", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "banana-big-plain", "name": "Banana loaf, big, plain", "category": "cake-loaves", "price": 7000, "meta": "Big", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "banana-big-topped", "name": "Banana loaf, big, topped", "category": "cake-loaves", "price": 8500, "meta": "Big", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "vanilla-small-plain", "name": "Vanilla loaf, small, plain", "category": "cake-loaves", "price": 3500, "meta": "Small", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "vanilla-small-topped", "name": "Vanilla loaf, small, topped", "category": "cake-loaves", "price": 4500, "meta": "Small", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "vanilla-big-plain", "name": "Vanilla loaf, big, plain", "category": "cake-loaves", "price": 6500, "meta": "Big", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "vanilla-big-topped", "name": "Vanilla loaf, big, topped", "category": "cake-loaves", "price": 8000, "meta": "Big", "description": "", "image": "prod-loaves.webp", "prepDays": 1, "published": true}, {"sku": "choc-cookies-4", "name": "Chocolate cookies, pack of 4", "category": "cookies", "price": 4000, "meta": "Pack of 4", "description": "", "image": "mystery-cookie-box.webp", "prepDays": 0, "published": true}, {"sku": "choc-cookies-8", "name": "Chocolate cookies, pack of 8", "category": "cookies", "price": 7500, "meta": "Pack of 8", "description": "", "image": "mystery-cookie-box.webp", "prepDays": 0, "published": true}, {"sku": "choc-cookies-12", "name": "Chocolate cookies, pack of 12", "category": "cookies", "price": 12000, "meta": "Pack of 12", "description": "", "image": "mystery-cookie-box.webp", "prepDays": 1, "published": true}, {"sku": "butter-cookies-4", "name": "Butter cookies, pack of 4", "category": "cookies", "price": 3000, "meta": "Pack of 4", "description": "", "image": "prod-cookies.webp", "prepDays": 0, "published": true}, {"sku": "butter-cookies-8", "name": "Butter cookies, pack of 8", "category": "cookies", "price": 6000, "meta": "Pack of 8", "description": "", "image": "prod-cookies.webp", "prepDays": 0, "published": true}, {"sku": "butter-cookies-12", "name": "Butter cookies, pack of 12", "category": "cookies", "price": 12000, "meta": "Pack of 12", "description": "", "image": "prod-cookies.webp", "prepDays": 1, "published": true}, {"sku": "mixed-cookie-box", "name": "Mixed cookie box, 14 pcs", "category": "cookies", "price": 14000, "meta": "14 pieces", "description": "", "image": "mystery-cookie-box.webp", "prepDays": 1, "published": true}, {"sku": "cupcakes-6", "name": "Cupcakes, box of 6", "category": "cupcakes", "price": 7200, "meta": "Box of 6", "description": "", "image": "prod-cupcakes.webp", "prepDays": 1, "published": true}, {"sku": "cupcakes-8", "name": "Cupcakes, box of 8", "category": "cupcakes", "price": 9500, "meta": "Box of 8", "description": "", "image": "prod-cupcakes.webp", "prepDays": 1, "published": true}, {"sku": "cupcakes-12", "name": "Cupcakes, box of 12", "category": "cupcakes", "price": 14000, "meta": "Box of 12", "description": "", "image": "prod-cupcakes.webp", "prepDays": 1, "published": true}, {"sku": "parfait-cup-plain", "name": "Cake parfait, cup, plain", "category": "parfait", "price": 6000, "meta": "Cup", "description": "", "image": "prod-parfait.webp", "prepDays": 0, "published": true}, {"sku": "parfait-cup-topped", "name": "Cake parfait, cup, topped", "category": "parfait", "price": 7500, "meta": "Cup", "description": "", "image": "prod-parfait.webp", "prepDays": 0, "published": true}, {"sku": "parfait-bowl-plain", "name": "Cake parfait, bowl, plain", "category": "parfait", "price": 8500, "meta": "Bowl", "description": "", "image": "prod-parfait.webp", "prepDays": 0, "published": true}, {"sku": "parfait-bowl-topped", "name": "Cake parfait, bowl, topped", "category": "parfait", "price": 9500, "meta": "Bowl", "description": "", "image": "prod-parfait.webp", "prepDays": 0, "published": true}, {"sku": "chips-fried-s", "name": "Fried chips, small", "category": "chips", "price": 1000, "meta": "Small", "description": "", "image": "", "prepDays": 0, "published": true}, {"sku": "chips-fried-m", "name": "Fried chips, medium", "category": "chips", "price": 3500, "meta": "Medium", "description": "", "image": "", "prepDays": 0, "published": true}, {"sku": "chips-fried-l", "name": "Fried chips, large", "category": "chips", "price": 7000, "meta": "Large", "description": "", "image": "", "prepDays": 0, "published": true}, {"sku": "chips-baked-s", "name": "Baked chips, small", "category": "chips", "price": 1000, "meta": "Small", "description": "", "image": "", "prepDays": 0, "published": true}, {"sku": "chips-baked-m", "name": "Baked chips, medium", "category": "chips", "price": 3500, "meta": "Medium", "description": "", "image": "", "prepDays": 0, "published": true}, {"sku": "chips-baked-l", "name": "Baked chips, large", "category": "chips", "price": 8000, "meta": "Large", "description": "", "image": "", "prepDays": 0, "published": true}, {"sku": "bento", "name": "Bento gift cake", "category": "celebration", "price": 12000, "meta": "4-inch personal-size cake (from price)", "description": "", "image": "cake-bento.webp", "prepDays": 1, "published": true}, {"sku": "birthday", "name": "Classic birthday cake", "category": "celebration", "price": 18000, "meta": "5-inch to 12-inch (from price)", "description": "", "image": "cake-birthday.webp", "prepDays": 1, "published": true}, {"sku": "heart", "name": "Heart-shaped cake", "category": "celebration", "price": 30000, "meta": "6-inch heart (from price)", "description": "", "image": "cake-heart.webp", "prepDays": 1, "published": true}, {"sku": "drip", "name": "Drip cake", "category": "celebration", "price": 35000, "meta": "6-inch, decorative drip finish (from price)", "description": "", "image": "cake-drip.webp", "prepDays": 1, "published": true}, {"sku": "oreo", "name": "Oreo cake", "category": "celebration", "price": 35000, "meta": "6-inch, Oreo or biscuit topping (from price)", "description": "", "image": "cake-oreo.webp", "prepDays": 1, "published": true}, {"sku": "chocolate", "name": "Chocolate-loaded cake", "category": "celebration", "price": 40000, "meta": "6-inch, chocolate toppings (from price)", "description": "", "image": "cake-chocolate.webp", "prepDays": 1, "published": true}, {"sku": "fruit", "name": "Fruit-topped cake", "category": "celebration", "price": 40000, "meta": "6-inch, fresh-fruit decoration (from price)", "description": "", "image": "cake-fruit.webp", "prepDays": 1, "published": true}, {"sku": "redvelvet", "name": "Red velvet celebration cake", "category": "celebration", "price": 40000, "meta": "6-inch, red velvet flavour (from price)", "description": "", "image": "cake-redvelvet.webp", "prepDays": 1, "published": true}, {"sku": "photo", "name": "Photo cake", "category": "celebration", "price": 35000, "meta": "6-inch, edible photo or printed image (from price)", "description": "", "image": "cake-photo.webp", "prepDays": 1, "published": true}, {"sku": "number", "name": "Number milestone cake", "category": "celebration", "price": 45000, "meta": "Approximately 10-inch (from price)", "description": "", "image": "cake-number.webp", "prepDays": 1, "published": true}, {"sku": "kids", "name": "Kids' character or theme cake", "category": "celebration", "price": 60000, "meta": "8-inch, character or theme design (from price)", "description": "", "image": "cake-kids.webp", "prepDays": 1, "published": true}, {"sku": "luxury", "name": "Luxury custom cake", "category": "celebration", "price": 100000, "meta": "8-inch, made to suit your theme (from price)", "description": "", "image": "cake-corporate.webp", "prepDays": 1, "published": true}, {"sku": "tier2", "name": "Two-tier wedding cake", "category": "celebration", "price": 150000, "meta": "8-inch and 6-inch tiers (from price)", "description": "", "image": "cake-tier2.webp", "prepDays": 1, "published": true}, {"sku": "tier3", "name": "Three-tier grand wedding cake", "category": "celebration", "price": 250000, "meta": "10-inch, 8-inch and 6-inch tiers (from price)", "description": "", "image": "cake-tier3.webp", "prepDays": 1, "published": true}], "classes": [{"slug": "bread-beginner", "track": "bread", "level": 1, "levelLabel": "Beginner", "name": "Bread Making \u00b7 Beginner", "summary": "Local favourites and foundational yeast doughs: Ghanaian Sugar Bread, Rich Butter Bread, Tea Bread and Coconut Bread.", "fee": 150000, "hours": "1 week", "schedule": "Monday to Friday \u00b7 dates agreed with student", "description": "A hands-on introduction to yeast doughs built around the four classic Ghanaian loaves. You learn accurate scaling, mixing, kneading, fermentation, shaping, proofing and oven control so you can bake consistent loaves at home or for sale.", "recipes": ["Ghanaian Sugar Bread", "Rich Butter Bread", "Ghanaian Tea Bread", "Ghanaian Coconut Bread"], "skills": ["Equipment, food safety, ingredients and accurate measuring", "Mixing, hand-kneading and windowpane dough development", "Bulk fermentation, portioning, tin shaping and proofing", "Oven temperature control, cooling, packaging and basic bake costing"], "provided": ["All flour, yeast, butter, sugar, coconut and recipe ingredients", "Loaf tins, mixers, ovens and full kitchen equipment", "Printed recipe sheets and basic costing worksheet", "Every loaf you bake during the week to take home"], "bring": ["Clean apron and closed-toe kitchen shoes", "Notebook and pen for bench notes", "Hair net or head wrap"], "bringNote": "All ingredients and equipment are provided by the school.", "prereq": "No experience needed. The beginner course assumes you have never baked bread or pastry.", "published": true}, {"slug": "bread-intermediate", "track": "bread", "level": 2, "levelLabel": "Intermediate", "name": "Bread Making \u00b7 Intermediate", "summary": "Whole-grain doughs, soft rolls and shaped loaves: Whole-meal Wheat Bread, Soft Buttermilk Rolls, Wheat Sandwich Baguettes and Wholewheat Burger Buns.", "fee": 220000, "hours": "1 week", "schedule": "Monday to Friday \u00b7 dates agreed with student", "description": "Move beyond basic tin loaves into whole-grain hydration, soft enriched dinner rolls, seeded burger buns and sandwich baguettes. Focuses on dough conditioning, uniform portioning, tension shaping and crust finishes.", "recipes": ["Whole-meal Wheat Bread", "Soft Buttermilk Rolls", "Wheat Sandwich Baguettes", "Wholewheat Burger Buns"], "skills": ["Hydration adjustments for whole-meal and wheat flours", "Dividing, rounding and uniform tension shaping for rolls and buns", "Pre-shaping, couching and scoring sandwich baguettes", "Egg-wash, seed topping, steam control, presentation and packaging"], "provided": ["All whole-grain and bread flours, buttermilk, butter and seeds", "Proofer, ovens, bench scrapers and baking trays", "Printed recipe manual and batch costing guide", "All loaves, rolls and buns baked in class"], "bring": ["Clean apron and closed-toe kitchen shoes", "Notebook and pen for bench notes", "Hair net or head wrap"], "bringNote": "All ingredients and equipment are provided by the school.", "prereq": "Beginner complete, or equivalent comfort with a basic yeast dough.", "published": true}, {"slug": "bread-advanced", "track": "bread", "level": 3, "levelLabel": "Advanced", "name": "Bread Making \u00b7 Advanced", "summary": "Artisan fermentation, braided and enriched doughs: Sourdough Boule, Classic French Baguette, Braided Challah, Brioche, Cinnamon Swirl, Rosemary Focaccia, New York Bagels and Skillet Naan.", "fee": 300000, "hours": "1 week", "schedule": "Monday to Friday \u00b7 dates agreed with student", "description": "Our flagship bread course covering natural levain management, high-hydration open-crumb doughs, multi-strand braiding, rich butter brioche, boiled bagels and flatbreads. Designed for serious home bakers and bakery founders.", "recipes": ["Artisan Sourdough Boule", "Classic French Baguette", "Braided Challah", "Brioche", "Cinnamon Swirl Butter Loaf", "Rosemary Focaccia", "New York Style Bagels", "Skillet Naan"], "skills": ["Building and maintaining an active sourdough starter and levain", "Stretch-and-fold, coil folds and cold retard fermentation", "High-butter emulsion for brioche and multi-strand challah braiding", "Kettle-boiling bagels, open-hearth steaming, scoring and troubleshooting"], "provided": ["All specialty flours, butter, inclusions and active sourdough starter to take home", "Bannetons, lame, baking steel/stone and full kitchen equipment", "Comprehensive artisan bread workbook and commercial pricing sheet", "Every loaf, bagel and flatbread baked during the week"], "bring": ["Clean apron and closed-toe kitchen shoes", "Notebook and pen for fermentation logs", "Hair net or head wrap"], "bringNote": "All ingredients, bannetons and tools are provided by the school.", "prereq": "Intermediate complete, or confident with enriched, laminated and wheat doughs.", "published": true}, {"slug": "pastry-beginner", "track": "pastry", "level": 1, "levelLabel": "Beginner", "name": "Pastry & Savoury \u00b7 Beginner", "summary": "Everyday savoury pastries and Ghanaian snacks: Meat Pie, Sausage Roll, Spring Roll, Samosa, Puff-Puff (Bofrot), Rock Buns, Atwemo and Chin Chin.", "fee": 150000, "hours": "1 week", "schedule": "Monday to Friday \u00b7 dates agreed with student", "description": "Master the everyday savoury pastries and traditional Ghanaian snacks that anchor event platters and daily bakery orders. Covers shortcrust rubbing-in, savoury fillings, folding samosas and spring rolls, and frying temperature control.", "recipes": ["Meat Pie", "Sausage Roll", "Spring Roll", "Samosa", "Puff-Puff (Bofrot)", "Ghanaian Rock Buns", "Atwemo", "Chin Chin"], "skills": ["Flaky shortcrust and rough-puff pastry without tough shrinkage", "Seasoning and binding moist meat and vegetable fillings", "Wrapping, sealing and crimping pies, rolls, spring rolls and samosas", "Frying oil temperature control, packaging and costing a snack order"], "provided": ["All flour, butter, meats, vegetables, spices, oil and packaging boxes", "Ovens, fryers, cutters, rolling pins and workstation tools", "Printed recipe booklet and small-chop platter costing guide", "All pastries and snack packs made during class"], "bring": ["Clean apron and closed-toe kitchen shoes", "Notebook and pen for bench notes", "Hair net or head wrap"], "bringNote": "All ingredients and packaging are provided by the school.", "prereq": "No experience needed. The beginner course assumes you have never baked bread or pastry.", "published": true}, {"slug": "pastry-intermediate", "track": "pastry", "level": 2, "levelLabel": "Intermediate", "name": "Pastry & Bakery \u00b7 Intermediate", "summary": "Lamination, bakery counter favourites and caf\u00e9 bakes: Croissants, Danish, Puff Pastry, Cinnamon Rolls, Doughnuts, Cupcakes, Cookies and Pizza.", "fee": 220000, "hours": "1 week", "schedule": "Monday to Friday \u00b7 dates agreed with student", "description": "Learn butter lock-in and lamination for crisp croissants, Danish and puff pastry alongside commercial-grade milky doughnuts, swirled cinnamon rolls, hand-iced cupcakes, cookies and artisan pizza dough.", "recipes": ["Croissants", "Danish Pastry", "Puff Pastry", "Cinnamon Rolls", "Doughnuts", "Cupcakes", "Cookies", "Pizza"], "skills": ["Butter block preparation, single/double turns and cold lamination", "Shaping, proofing and glazing croissants, Danish and cinnamon rolls", "Frying and filling pillowy doughnuts with stable glazes", "Creaming method for cupcakes and cookies, piping, presentation and costing"], "provided": ["Lamination butter, chocolate, glazes, fillings and all ingredients", "Chillers, mixers, piping tips, cutters and baking sheets", "Step-by-step lamination schedule and recipe manual", "Boxes of everything you bake to take home"], "bring": ["Clean apron and closed-toe kitchen shoes", "Notebook and pen for bench notes", "Hair net or head wrap"], "bringNote": "All ingredients and equipment are provided by the school.", "prereq": "Beginner complete, or equivalent comfort with basic dough and pastry handling.", "published": true}, {"slug": "pastry-advanced", "track": "pastry", "level": 3, "levelLabel": "Advanced", "name": "P\u00e2tisserie & Desserts \u00b7 Advanced", "summary": "Fine p\u00e2tisserie and plated desserts: Macarons, \u00c9clairs, Fruit and Custard Tarts, Quiche, Cheesecakes and Mousse Cakes.", "fee": 300000, "hours": "1 week", "schedule": "Monday to Friday \u00b7 dates agreed with student", "description": "Precision pastry for dessert tables and boutique orders. Covers macaronage, choux pastry for \u00e9clairs, crisp p\u00e2te sucr\u00e9e tart shells, pastry cream, baked and chilled cheesecakes, savoury quiche and mirror-finished mousse cakes.", "recipes": ["Macarons", "\u00c9clairs", "Fruit and Custard Tarts", "Quiche", "Cheesecakes", "Mousse Cakes"], "skills": ["Meringue stability and macaronage for smooth, footed macaron shells", "Piping and baking hollow choux pastry \u00e9clairs with pastry cream and glaze", "Blind-baking crisp sweet and savoury tart shells without shrinkage", "Emulsion, setting and finishing for cheesecakes and mousse cakes"], "provided": ["Almond flour, chocolate, cream cheese, fresh fruit and all ingredients", "Baking mats, tart rings, thermometers, mixers and finishing tools", "Advanced p\u00e2tisserie manual, troubleshooting and pricing guide", "Full dessert boxes of your finished creations"], "bring": ["Clean apron and closed-toe kitchen shoes", "Notebook and pen for bench notes", "Hair net or head wrap"], "bringNote": "All specialty ingredients and tools are provided by the school.", "prereq": "Intermediate complete, or confident with enriched, laminated and wheat doughs.", "published": true}], "options": {"size": [{"key": "5", "label": "5-inch (serves 6\u20138)", "price": 15000}, {"key": "6", "label": "6-inch (serves 8\u201312)", "price": 22000}, {"key": "7", "label": "7-inch (serves 12\u201316)", "price": 28000}, {"key": "8", "label": "8-inch (serves 16\u201322)", "price": 35000}, {"key": "10", "label": "10-inch (serves 25\u201332)", "price": 65000}, {"key": "12", "label": "12-inch (serves 35\u201345)", "price": 90000}], "decor": [{"key": "basic", "label": "Basic single-layer", "charges": {"5": 15000, "6": 22000, "7": 28000, "8": 35000, "10": 65000, "12": 90000}}, {"key": "simple", "label": "Simple decorated birthday", "charges": {"5": 18000, "6": 25000, "7": 32000, "8": 40000, "10": 75000, "12": 100000}}, {"key": "custom", "label": "Custom decorated single-layer", "charges": {"5": 22000, "6": 30000, "7": 38000, "8": 50000, "10": 95000, "12": 130000}}, {"key": "two-plain", "label": "Two-layer, plain finish", "charges": {"5": 22000, "6": 30000, "7": 40000, "8": 50000, "10": 80000, "12": 110000}}, {"key": "two-decor", "label": "Two-layer, decorated", "charges": {"5": 28000, "6": 38000, "7": 48000, "8": 70000, "10": 100000, "12": 140000}}], "flavour": [{"key": "vanilla", "label": "Vanilla", "extra": 0}, {"key": "banana", "label": "Banana", "extra": 0}, {"key": "chocolate", "label": "Chocolate", "extra": 2000}, {"key": "lemon", "label": "Lemon", "extra": 2000}, {"key": "marble", "label": "Marble", "extra": 3000}, {"key": "coconut", "label": "Coconut", "extra": 3000}, {"key": "carrot", "label": "Carrot", "extra": 3000}, {"key": "redvelvet", "label": "Red velvet", "extra": 4000}, {"key": "fruit", "label": "Traditional fruit cake", "extra": 5000, "priceMax": 10000}], "addon": [{"key": "writing", "label": "Birthday writing on cake", "price": 1000}, {"key": "piping", "label": "Extra cream piping", "price": 3000}, {"key": "drip", "label": "Chocolate drip", "price": 3000, "priceMax": 4000}, {"key": "oreo", "label": "Oreo or biscuit topping", "price": 3000, "priceMax": 4000}, {"key": "fruit", "label": "Fresh fruit decoration", "price": 5000}, {"key": "photo", "label": "Edible image / photo print", "price": 6000}, {"key": "topper", "label": "Acrylic cake topper", "price": 3000, "priceMax": 6000}, {"key": "fondant-name", "label": "Fondant name or age", "price": 5000}, {"key": "fondant-full", "label": "Full fondant covering / theme design", "price": null, "priceMax": 30000}], "variety": [{"key": "bento", "label": "Bento gift cake (4-inch)", "price": 12000}, {"key": "birthday", "label": "Classic birthday cake", "price": 18000}, {"key": "heart", "label": "Heart-shaped cake (6-inch)", "price": 30000}, {"key": "drip", "label": "Drip cake (6-inch)", "price": 35000}, {"key": "oreo", "label": "Oreo cake (6-inch)", "price": 35000}, {"key": "chocolate", "label": "Chocolate-loaded cake (6-inch)", "price": 40000}, {"key": "fruit", "label": "Fruit-topped cake (6-inch)", "price": 40000}, {"key": "redvelvet", "label": "Red velvet celebration cake (6-inch)", "price": 40000}, {"key": "photo", "label": "Photo cake (6-inch)", "price": 35000}, {"key": "number", "label": "Number milestone cake", "price": 45000}, {"key": "kids", "label": "Kids\u2019 character or theme cake", "price": 60000}, {"key": "corporate", "label": "Luxury custom cake", "price": 100000}, {"key": "tier2", "label": "Two-tier wedding cake", "price": 150000}, {"key": "tier3", "label": "Three-tier grand wedding cake", "price": 250000}], "tier": [{"key": "tier2", "label": "Two-tier wedding cake (8\" + 6\")", "price": 150000}, {"key": "tier3", "label": "Three-tier grand wedding cake (10\" + 8\" + 6\")", "price": 250000}]}};

  function defaultSettings() {
    return {
      momo_name: 'Mystery Bakebite',
      momo_number: '055 452 0532',
      momo_provider: 'MTN MoMo / Telecel Cash',
      momo_note: 'Use your order or booking reference as the payment reference.',
      momo_verified: true,
      bank_name: 'GCB Bank — Tamale Main Branch',
      bank_account_name: 'Mystery Bakebite',
      bank_account_number: '9011010048291',
      bank_verified: true,
      cash_delivery_enabled: true,
      cash_pickup_enabled: true,
      advance_threshold: '70000',
      auto_confirm: false,
      bundle_two_pct: 15,
      bundle_three_pct: 25,
      /* Business contact profile — kept in step with the DB column defaults so
         local mode and the live project publish the same details. */
      business_name: 'Mystery Bakebite',
      business_tagline: 'Home bakery & baking school',
      business_phone: '233554520532',
      business_phone_display: '+233 55 452 0532',
      business_email: 'mysterybakebites@gmail.com',
      whatsapp_contact: '233554520532',
      whatsapp_message: "Hello Mystery Bakebite, I'd like to place an order.",
      whatsapp_number: '',
      address_line1: '', address_line2: '',
      address_city: 'Tamale', address_region: 'Northern Region', address_country: 'Ghana',
      map_url: '',
      opening_days: 'Monday to Sunday', opening_open: '08:00', opening_close: '19:00',
      opening_note: 'Messages are answered during opening hours.',
      social_instagram: 'https://www.instagram.com/mysterybakebites/',
      social_facebook: '', social_tiktok: '', social_x: '', social_youtube: ''
    };
  }

  /* Pure-JS SHA-256 digest for one-way credential verification (no plaintext passwords in source) */
  function sha256Hex(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    var mathPow = Math.pow;
    var maxWord = mathPow(2, 32);
    var i, j, result = '';
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = sha256Hex.h = sha256Hex.h || [];
    var k = sha256Hex.k = sha256Hex.k || [];
    var primeCounter = k.length;
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while ((ascii.length % 64) - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - (i % 4)) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, (j += 16));
      var oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[i] +
          (w[i] = (i < 16) ? w[i] : (
            w[i - 16] +
            (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
            w[i - 7] +
            (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
          ) | 0);
        var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  function hashAdminCredential(email, password) {
    var normEmail = String(email || '').trim().toLowerCase();
    var raw = 'mb-auth-v1::' + normEmail + '::' + String(password || '');
    var utf8 = unescape(encodeURIComponent(raw));
    return sha256Hex(utf8);
  }

  /* Legacy hardcoded digests that must never be trusted if found in old localStorage snapshots */
  var REVOKED_LEGACY_DIGESTS = {
    '3655c09db5d8511c7cb70e44b9ea591d01f7686905fc7432f2414eced1f04090': true,
    'f0555117fa85aa718dc05877283ef3b4e99a174289971cb4ab1539c3ea9f5f8e': true
  };

  var ADMIN_ROLE_PERMISSIONS = {
    super_admin: {
      label: 'Super Administrator',
      view: true,
      orders: true,
      verify: true,
      catalogue: true,
      settings: true,
      team: true
    },
    administrator: {
      label: 'Administrator',
      view: true,
      orders: true,
      verify: true,
      catalogue: true,
      settings: true,
      team: false
    },
    manager: {
      label: 'Order & Kitchen Manager',
      view: true,
      orders: true,
      verify: true,
      catalogue: true,
      settings: false,
      team: false
    },
    viewer: {
      label: 'Read-Only Viewer',
      view: true,
      orders: false,
      verify: false,
      catalogue: false,
      settings: false,
      team: false
    }
  };

  function getRolePermissions(role) {
    var r = String(role || '').trim().toLowerCase();
    if (r === 'owner') r = 'super_admin';
    if (r === 'admin' || r === 'baker') r = 'administrator';
    return ADMIN_ROLE_PERMISSIONS[r] || ADMIN_ROLE_PERMISSIONS.viewer;
  }

  function normalizeAdminRole(role, email) {
    var em = String(email || '').trim().toLowerCase();
    if (em === PRIMARY_SUPER_ADMIN_EMAIL) return 'super_admin';
    var r = String(role || '').trim().toLowerCase();
    if (r === 'administrator' || r === 'admin' || r === 'baker') return 'administrator';
    if (r === 'manager') return 'manager';
    if (r === 'viewer') return 'viewer';
    return 'administrator';
  }

  function generateSecureTemporaryPassword() {
    var upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    var lower = 'abcdefghijkmnopqrstuvwxyz';
    var digits = '23456789';
    var symbols = '!@#$%&*';
    var all = upper + lower + digits;
    var rnd = function (max) {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        var arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        return arr[0] % max;
      }
      return Math.floor(Math.random() * max);
    };
    var chars = [
      upper.charAt(rnd(upper.length)),
      upper.charAt(rnd(upper.length)),
      lower.charAt(rnd(lower.length)),
      lower.charAt(rnd(lower.length)),
      digits.charAt(rnd(digits.length)),
      digits.charAt(rnd(digits.length)),
      symbols.charAt(rnd(symbols.length))
    ];
    for (var i = 0; i < 5; i++) {
      chars.push(all.charAt(rnd(all.length)));
    }
    for (var j = chars.length - 1; j > 0; j--) {
      var k = rnd(j + 1);
      var tmp = chars[j];
      chars[j] = chars[k];
      chars[k] = tmp;
    }
    return 'MB-' + chars.join('');
  }

  function validateStrongPassword(password, email) {
    var pw = String(password || '');
    if (pw.length < 10) {
      return { ok: false, error: 'Use at least 10 characters for your password.' };
    }
    if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) {
      return {
        ok: false,
        error: 'Password must include uppercase and lowercase letters, a number, and a special character (e.g. !@#$%).'
      };
    }
    var localPart = String(email || '').split('@')[0].toLowerCase();
    if (localPart && localPart.length >= 4 && pw.toLowerCase().indexOf(localPart) !== -1) {
      return { ok: false, error: 'Password must not contain your email username.' };
    }
    if (/^(password|12345678|qwertyui|admin123)/i.test(pw)) {
      return { ok: false, error: 'Please choose a stronger, less predictable password.' };
    }
    return { ok: true };
  }

  function defaultAdmins() {
    /* Primary Super Administrator record ONLY.
       No demo accounts and no hardcoded passwords or digests are stored in source code.
       First-time provisioning generates a temporary password and enforces a mandatory change on first login. */
    return [
      {
        userId: 'super-admin-primary',
        email: PRIMARY_SUPER_ADMIN_EMAIL,
        name: 'Mystery Bakebite (Super Admin)',
        role: 'super_admin',
        isPrimarySuperAdmin: true,
        active: true,
        isProvisioned: false,
        mustChangePassword: true,
        passwordDigest: '',
        createdAt: '2026-01-15T08:00:00Z',
        lastSignInAt: null,
        passwordChangedAt: null
      }
    ];
  }

  function ensureAdminRoster(list) {
    var current = Array.isArray(list) ? list.slice() : [];
    /* Purge any legacy demo/test accounts and revoke any old hardcoded digests */
    current = current.filter(function (a) {
      if (!a || !a.email) return false;
      var em = String(a.email).trim().toLowerCase();
      if (em === 'demo.admin@mysterybakebite.com' || a.userId === 'demo-admin-01') return false;
      if (/^demo\.|^test\./i.test(em)) return false;
      return true;
    });

    var primaryFound = false;
    current.forEach(function (a) {
      var em = String(a.email || '').trim().toLowerCase();
      a.email = em;
      if (a.passwordDigest && REVOKED_LEGACY_DIGESTS[a.passwordDigest]) {
        a.passwordDigest = '';
        a.isProvisioned = false;
        a.mustChangePassword = true;
      }
      if (em === PRIMARY_SUPER_ADMIN_EMAIL) {
        primaryFound = true;
        a.userId = a.userId || 'super-admin-primary';
        a.name = a.name || 'Mystery Bakebite (Super Admin)';
        a.role = 'super_admin';
        a.isPrimarySuperAdmin = true;
        a.active = true;
        if (typeof a.mustChangePassword !== 'boolean') {
          a.mustChangePassword = !a.passwordChangedAt;
        }
        a.isProvisioned = !!a.passwordDigest;
      } else {
        a.role = normalizeAdminRole(a.role, em);
        a.isPrimarySuperAdmin = false;
        if (typeof a.active !== 'boolean') a.active = true;
        if (typeof a.mustChangePassword !== 'boolean') a.mustChangePassword = false;
        a.isProvisioned = !!a.passwordDigest;
      }
    });

    if (!primaryFound) {
      current.unshift(defaultAdmins()[0]);
    }
    return current;
  }

  function recordAdminAudit(db, action, actorEmail, targetEmail, details) {
    if (!db) return;
    db.adminAuditLog = Array.isArray(db.adminAuditLog) ? db.adminAuditLog : [];
    var entry = {
      id: 'audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      action: String(action || 'admin_action'),
      actor: String(actorEmail || PRIMARY_SUPER_ADMIN_EMAIL).toLowerCase(),
      target: String(targetEmail || '').toLowerCase(),
      details: String(details || ''),
      at: new Date().toISOString()
    };
    db.adminAuditLog.unshift(entry);
    if (db.adminAuditLog.length > 200) db.adminAuditLog.length = 200;
    db.activity = Array.isArray(db.activity) ? db.activity : [];
    db.activity.unshift({
      kind: 'security',
      order_ref: '',
      message: entry.details || (entry.action + ' (' + entry.target + ')'),
      at: entry.at,
      actor: entry.actor
    });
  }

  var ADVANCE_PREP_SKUS = {
    'milky-12': 1,
    'tasting-box': 1,
    'flavour-box': 1,
    'banana-small-plain': 1,
    'banana-small-topped': 1,
    'banana-big-plain': 1,
    'banana-big-topped': 1,
    'vanilla-small-plain': 1,
    'vanilla-small-topped': 1,
    'vanilla-big-plain': 1,
    'vanilla-big-topped': 1,
    'choc-cookies-12': 1,
    'butter-cookies-12': 1,
    'mixed-cookie-box': 1,
    'cupcakes-6': 1,
    'cupcakes-8': 1,
    'cupcakes-12': 1,
    'bento': 1,
    'birthday': 1,
    'heart': 1,
    'drip': 1,
    'oreo': 1,
    'chocolate': 1,
    'fruit': 1,
    'redvelvet': 1,
    'photo': 1,
    'number': 1,
    'kids': 1,
    'luxury': 1,
    'corporate': 1,
    'tier2': 1,
    'tier3': 1
  };

  function defaultPrepDaysForSku(sku, category) {
    var k = String(sku || '').trim().toLowerCase();
    var c = String(category || '').trim().toLowerCase();
    if (ADVANCE_PREP_SKUS[k] !== undefined) return ADVANCE_PREP_SKUS[k];
    if (c === 'celebration' || c === 'cake-loaves' || c === 'cupcakes') return 1;
    return 0;
  }

  function productPrepDays(p) {
    if (!p || typeof p !== 'object') return 0;
    if (p.prepDays !== undefined && p.prepDays !== null && p.prepDays !== '') {
      var n = Math.round(Number(p.prepDays));
      if (isFinite(n) && n >= 0 && n <= 30) return n;
    }
    return defaultPrepDaysForSku(p.sku, p.category);
  }

  function localIsoDate(daysOffset) {
    var d = new Date();
    d.setHours(12, 0, 0, 0);
    if (daysOffset && isFinite(Number(daysOffset))) {
      d.setDate(d.getDate() + Math.round(Number(daysOffset)));
    }
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1);
    if (m.length < 2) m = '0' + m;
    var day = String(d.getDate());
    if (day.length < 2) day = '0' + day;
    return y + '-' + m + '-' + day;
  }

  function formatOrderDate(ymd) {
    if (!ymd) return '';
    var s = String(ymd).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function migrateStoredProducts(products) {
    if (!Array.isArray(products)) return products;
    products.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var sku = String(p.sku || '').toLowerCase();
      if (sku.indexOf('milky-') === 0 && (!p.image || p.image === 'prod-doughnuts.webp')) {
        p.image = 'milky-doughnuts-new.webp';
      }
      if ((sku.indexOf('choc-cookies-') === 0 || sku === 'mixed-cookie-box') && (!p.image || p.image === 'prod-cookies.webp')) {
        p.image = 'mystery-cookie-box.webp';
      }
      if (p.prepDays === undefined || p.prepDays === null || p.prepDays === '') {
        p.prepDays = defaultPrepDaysForSku(p.sku, p.category);
      } else {
        p.prepDays = productPrepDays(p);
      }
    });
    return products;
  }

  function loadLocalDb() {
    if (LOCAL_MEM) return LOCAL_MEM;
    try {
      var raw = localStorage.getItem(LOCAL_DB_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.classes) && Array.isArray(parsed.products)) {
          parsed.settings = Object.assign(defaultSettings(), parsed.settings || {});
          if (!parsed.settings.bank_name) {
            parsed.settings.bank_name = 'GCB Bank — Tamale Main Branch';
            parsed.settings.bank_account_name = 'Mystery Bakebite';
            parsed.settings.bank_account_number = '9011010048291';
            parsed.settings.bank_verified = true;
          }
          if (!parsed.settings.momo_name) {
            parsed.settings.momo_name = 'Mystery Bakebite';
            parsed.settings.momo_number = '055 452 0532';
            parsed.settings.momo_verified = true;
          }
          if (parsed.settings.cash_delivery_enabled === undefined) parsed.settings.cash_delivery_enabled = true;
          if (parsed.settings.cash_pickup_enabled === undefined) parsed.settings.cash_pickup_enabled = true;
          parsed.products = migrateStoredProducts(parsed.products);
          parsed.admins = ensureAdminRoster(parsed.admins);
          parsed.adminAuditLog = Array.isArray(parsed.adminAuditLog) ? parsed.adminAuditLog : [];
          parsed.customers = Array.isArray(parsed.customers) ? parsed.customers : [];
          parsed.orderItems = Array.isArray(parsed.orderItems) ? parsed.orderItems : [];
          parsed.payments = Array.isArray(parsed.payments) ? parsed.payments : [];
          parsed.classBookings = Array.isArray(parsed.classBookings) ? parsed.classBookings : [];
          LOCAL_MEM = parsed;
          return LOCAL_MEM;
        }
      }
    } catch (e) {}
    LOCAL_MEM = {
      categories: JSON.parse(JSON.stringify(LOCAL_SEED.categories)),
      products: migrateStoredProducts(JSON.parse(JSON.stringify(LOCAL_SEED.products))),
      classes: JSON.parse(JSON.stringify(LOCAL_SEED.classes)),
      options: JSON.parse(JSON.stringify(LOCAL_SEED.options)),
      settings: defaultSettings(),
      orders: [],
      orderItems: [],
      payments: [],
      classBookings: [],
      customers: [],
      notifications: [],
      activity: [],
      adminAuditLog: [],
      proofs: {},
      admins: defaultAdmins()
    };
    saveLocalDb(LOCAL_MEM);
    return LOCAL_MEM;
  }

  function saveLocalDb(db) {
    LOCAL_MEM = db;
    try {
      localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
    } catch (e) {}
    try {
      if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('mb-catalogue-updated'));
      }
    } catch (e) {}
  }

  function productDiscountPct(p) {
    var pct = Number(p && p.discountPct);
    return (isFinite(pct) && pct > 0 && pct <= 90) ? Math.round(pct) : 0;
  }

  function buildPublicConfig(s, db) {
    s = s || defaultSettings();
    var two = Number(s.bundle_two_pct);
    var three = Number(s.bundle_three_pct);
    if (!isFinite(two)) two = 15;
    if (!isFinite(three)) three = 25;
    /* The threshold is stored in pesewas. Older snapshots stored cedis (e.g. 700),
       so normalise anything small back into pesewas instead of comparing the wrong units. */
    var rawThresh = parseFloat(s.advance_threshold);
    if (!isFinite(rawThresh) || rawThresh <= 0) rawThresh = 70000;
    var thresh = rawThresh < 1000 ? Math.round(rawThresh * 100) : Math.round(rawThresh);
    var prodDiscounts = {};
    var prodPrepDays = {};
    if (db && Array.isArray(db.products)) {
      db.products.forEach(function (p) {
        var pct = productDiscountPct(p);
        if (pct > 0) prodDiscounts[p.sku] = pct;
        prodPrepDays[p.sku] = productPrepDays(p);
      });
    }
    /* The public WhatsApp line comes from the business profile (settings),
       never from a literal here. Blank when the administrator has not set one,
       so callers can fall back deliberately instead of dialling a stale number. */
    var waContact = String(s.whatsapp_contact || '').replace(/\D/g, '');
    var waAlerts  = String(s.whatsapp_number || '').replace(/\D/g, '');
    return {
      whatsapp: waContact || waAlerts,
      bundle_two_pct: two,
      bundle_three_pct: three,
      product_discounts: prodDiscounts,
      product_prep_days: prodPrepDays,
      advance_threshold: thresh,
      cash: {
        delivery: !!s.cash_delivery_enabled,
        pickup: !!s.cash_pickup_enabled
      },
      momo: (s.momo_verified && s.momo_name && s.momo_number) ? {
        name: s.momo_name,
        number: s.momo_number,
        provider: s.momo_provider || 'MTN MoMo',
        note: s.momo_note || ''
      } : null,
      bank: (s.bank_verified && s.bank_name && s.bank_account_name && s.bank_account_number) ? {
        name: s.bank_name,
        accountName: s.bank_account_name,
        accountNumber: s.bank_account_number
      } : null,

      /* Business contact profile. Mirrors the `contact` object that
         api_config() returns from Postgres so the browser sees one shape. */
      contact: {
        businessName: s.business_name || 'Mystery Bakebite',
        tagline: s.business_tagline || '',
        phone: String(s.business_phone || '').replace(/\D/g, ''),
        phoneDisplay: s.business_phone_display || '',
        email: s.business_email || '',
        whatsapp: String(s.whatsapp_contact || '').replace(/\D/g, ''),
        whatsappMessage: s.whatsapp_message || '',
        alerts: String(s.whatsapp_number || s.whatsapp_contact || '').replace(/\D/g, ''),
        address: {
          line1: s.address_line1 || '',
          line2: s.address_line2 || '',
          city: s.address_city || '',
          region: s.address_region || '',
          country: s.address_country || '',
          mapUrl: s.map_url || ''
        },
        hours: {
          days: s.opening_days || '',
          open: s.opening_open || '',
          close: s.opening_close || '',
          note: s.opening_note || ''
        },
        social: {
          instagram: s.social_instagram || '',
          facebook: s.social_facebook || '',
          tiktok: s.social_tiktok || '',
          x: s.social_x || '',
          youtube: s.social_youtube || ''
        }
      }
    };
  }

  function priceCustomSpec(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { valid: false, code: 'invalid_custom_spec', error: 'Custom cake configuration is missing or invalid.', unitPrice: null, quoteOnly: true, name: 'Custom cake', meta: '' };
    }
    var VARIETY_PRICES = {
      bento: 12000, birthday: 18000, heart: 30000, drip: 35000, oreo: 35000,
      chocolate: 40000, fruit: 40000, redvelvet: 40000, photo: 35000,
      number: 45000, kids: 60000, luxury: 100000, corporate: 100000, tier2: 150000, tier3: 250000
    };
    var DECOR_TABLE = {
      basic:  { '5': 15000, '6': 22000, '7': 28000, '8': 35000, '10': 65000, '12': 90000 },
      simple: { '5': 18000, '6': 25000, '7': 32000, '8': 40000, '10': 75000, '12': 100000 },
      custom: { '5': 22000, '6': 30000, '7': 38000, '8': 50000, '10': 95000, '12': 130000 }
    };
    var FLAVOUR_ADD = {
      vanilla: 0, banana: 0, chocolate: 2000, lemon: 2000,
      marble: 3000, coconut: 3000, carrot: 3000, redvelvet: 4000, fruit: null
    };
    var ADDON_ADD = {
      writing: 1000, piping: 3000, drip: 4000, oreo: 3000, choc: 4000,
      fruit: 5000, photo: 6000, fondant: 5000, topper: null, fullfond: null, character: null
    };
    var specType = String(spec.type || 'classic').trim().toLowerCase();
    if (['classic', 'celebration', 'tiers'].indexOf(specType) === -1) {
      return { valid: false, code: 'invalid_custom_spec', error: 'Unapproved custom cake type: ' + specType };
    }
    if (specType === 'celebration') {
      var vKey = String(spec.variety || '').trim().toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(VARIETY_PRICES, vKey)) {
        return { valid: false, code: 'invalid_custom_spec', error: 'Unapproved celebration cake variety: ' + (spec.variety || '') };
      }
      var vp = VARIETY_PRICES[vKey];
      return { valid: true, unitPrice: vp, quoteOnly: false, hasPending: false };
    }
    if (specType === 'tiers') {
      var tierKey = String(spec.tier || '').trim();
      if (tierKey === '2') return { valid: true, unitPrice: 150000, quoteOnly: false, hasPending: true };
      if (tierKey === '3') return { valid: true, unitPrice: 250000, quoteOnly: false, hasPending: true };
      if (tierKey !== '1') {
        return { valid: false, code: 'invalid_custom_spec', error: 'Unapproved cake tier configuration: ' + tierKey };
      }
    }
    var szRaw = String(spec.size !== undefined ? spec.size : '6').trim();
    var sz = szRaw.replace(/[^0-9]/g, '');
    if (!sz || !Object.prototype.hasOwnProperty.call(DECOR_TABLE.basic, sz)) {
      return { valid: false, code: 'invalid_custom_spec', error: 'Unapproved cake size: ' + szRaw };
    }
    var decKey = String(spec.decor !== undefined ? spec.decor : 'basic').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(DECOR_TABLE, decKey)) {
      return { valid: false, code: 'invalid_custom_spec', error: 'Unapproved cake decoration option: ' + decKey };
    }
    var flvKey = String(spec.flavour !== undefined ? spec.flavour : 'vanilla').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FLAVOUR_ADD, flvKey)) {
      return { valid: false, code: 'invalid_custom_spec', error: 'Unapproved cake sponge flavour: ' + flvKey };
    }
    var base = DECOR_TABLE[decKey][sz];
    var flv = FLAVOUR_ADD[flvKey];
    var pending = (flv === null);
    var total = base + (typeof flv === 'number' ? flv : 0);
    if (spec.addons !== undefined && spec.addons !== null) {
      if (!Array.isArray(spec.addons) || spec.addons.length > 15) {
        return { valid: false, code: 'invalid_custom_spec', error: 'Invalid custom cake add-ons list.' };
      }
      for (var ai = 0; ai < spec.addons.length; ai++) {
        var aKey = String(spec.addons[ai] || '').trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(ADDON_ADD, aKey)) {
          return { valid: false, code: 'invalid_custom_spec', error: 'Unapproved custom cake add-on: ' + aKey };
        }
        var ap = ADDON_ADD[aKey];
        if (ap === null) pending = true;
        else if (typeof ap === 'number') total += ap;
      }
    }
    return { valid: true, unitPrice: total, quoteOnly: false, hasPending: pending };
  }

  function resolveItemDetails(db, it) {
    if (!it || typeof it !== 'object') {
      return { valid: false, code: 'invalid_product', error: 'Invalid order line item.' };
    }
    var q = Math.max(1, parseInt(it.qty, 10) || 1);
    if (it.kind === 'class') {
      var slug = String(it.slug || String(it.id || '').replace(/^class-/, '')).trim();
      var cls = (db.classes || []).filter(function (x) { return x.slug.toLowerCase() === slug.toLowerCase(); })[0];
      if (!cls) {
        return {
          valid: false,
          code: 'invalid_class',
          error: 'Unknown or invalid baking class course: ' + (slug || 'unknown')
        };
      }
      if (cls.published === false) {
        return {
          valid: false,
          code: 'class_unavailable',
          error: cls.name + ' is currently unavailable for booking.'
        };
      }
      var fee = Number(cls.fee) || 0;
      return {
        valid: true,
        id: 'class-' + cls.slug,
        kind: 'class',
        slug: cls.slug,
        name: cls.name,
        meta: cls.levelLabel + ' level · ' + (cls.track === 'bread' ? 'Bread' : 'Pastry') + ' track',
        qty: 1,
        unitPrice: fee,
        discountedUnitPrice: fee,
        discountPct: 0,
        unitDiscount: 0,
        lineDiscount: 0,
        prepDays: 0,
        quoteOnly: false
      };
    }
    if (it.kind === 'custom') {
      var specRes = priceCustomSpec(it.spec);
      if (!specRes.valid) {
        return {
          valid: false,
          code: specRes.code || 'invalid_custom_spec',
          error: specRes.error || 'Unapproved custom cake configuration.'
        };
      }
      var customBase = specRes.unitPrice;
      var cDiscPct = 0;
      var cPrepDays = 1;
      if (it.spec && it.spec.type === 'celebration' && it.spec.variety) {
        var vSku = it.spec.variety === 'corporate' ? 'luxury' : String(it.spec.variety);
        var vProd = (db.products || []).filter(function (p) { return p.sku.toLowerCase() === vSku.toLowerCase(); })[0];
        if (vProd) {
          if (vProd.published === false) {
            return {
              valid: false,
              code: 'product_unavailable',
              error: vProd.name + ' is currently unavailable.'
            };
          }
          if (typeof vProd.price === 'number') customBase = vProd.price;
          cDiscPct = productDiscountPct(vProd);
          cPrepDays = Math.max(1, productPrepDays(vProd));
        }
      }
      /* Never fall back to browser-supplied it.unitPrice on custom cakes */
      var customPrice = (typeof customBase === 'number' && customBase > 0) ? customBase : null;
      var isQuoteOnly = (customPrice === null || customPrice === undefined) || !!specRes.quoteOnly;
      var cUnitDisc = (!isQuoteOnly && cDiscPct > 0) ? Math.round(Number(customPrice) * cDiscPct / 100) : 0;
      return {
        valid: true,
        id: String(it.id || 'custom-cake').slice(0, 80),
        kind: 'custom',
        spec: it.spec,
        name: String(it.name || 'Custom cake').slice(0, 140),
        meta: String(it.meta || '').slice(0, 240),
        qty: q,
        unitPrice: isQuoteOnly ? null : Number(customPrice),
        discountedUnitPrice: isQuoteOnly ? null : (Number(customPrice) - cUnitDisc),
        discountPct: cDiscPct,
        unitDiscount: cUnitDisc,
        lineDiscount: cUnitDisc * q,
        prepDays: cPrepDays,
        quoteOnly: isQuoteOnly,
        hasPending: !!specRes.hasPending
      };
    }
    var sku = String(it.sku || it.id || '').trim();
    var prod = (db.products || []).filter(function (p) {
      return p.sku.toLowerCase() === sku.toLowerCase();
    })[0];
    /* Strict server-side catalogue enforcement: never trust browser prices or unknown SKUs */
    if (!prod) {
      return {
        valid: false,
        code: 'invalid_product',
        error: 'Unknown or invalid product SKU: ' + (sku || 'unknown')
      };
    }
    if (prod.published === false) {
      return {
        valid: false,
        code: 'product_unavailable',
        error: prod.name + ' is currently unavailable.'
      };
    }
    var unit = (typeof prod.price === 'number') ? prod.price : null;
    var pDiscPct = productDiscountPct(prod);
    var pUnitDisc = (typeof unit === 'number' && pDiscPct > 0) ? Math.round(unit * pDiscPct / 100) : 0;
    var pPrepDays = productPrepDays(prod);
    return {
      valid: true,
      id: prod.sku,
      kind: 'product',
      sku: prod.sku,
      name: prod.name,
      meta: prod.meta || '',
      qty: q,
      unitPrice: unit,
      discountedUnitPrice: typeof unit === 'number' ? (unit - pUnitDisc) : null,
      discountPct: pDiscPct,
      unitDiscount: pUnitDisc,
      lineDiscount: pUnitDisc * q,
      prepDays: pPrepDays,
      quoteOnly: unit === null || unit === undefined
    };
  }

  function computeLocalPrice(db, kind, body) {
    var rawItems = (body && Array.isArray(body.items))
      ? body.items
      : ((body && Array.isArray(body.classes)) ? body.classes : (Array.isArray(body) ? body : []));
    var cfg = buildPublicConfig(db.settings, db);
    if (kind === 'class') {
      var chosen = [];
      for (var ci = 0; ci < rawItems.length; ci++) {
        var it = rawItems[ci];
        var slug = typeof it === 'string'
          ? it.replace(/^class-/, '')
          : (it && (it.slug || String(it.id || '').replace(/^class-/, '')));
        var c = (db.classes || []).filter(function (x) { return x.slug.toLowerCase() === String(slug || '').toLowerCase(); })[0];
        if (!c) {
          return {
            ok: false,
            code: 'invalid_class',
            error: 'Unknown or invalid baking class course: ' + (slug || 'unknown')
          };
        }
        if (c.published === false) {
          return {
            ok: false,
            code: 'class_unavailable',
            error: c.name + ' is currently unavailable for booking.'
          };
        }
        chosen.push(c);
      }
      var subtotal = chosen.reduce(function (s, c) { return s + c.fee; }, 0);
      var discount = 0;
      var bundles = [];
      /* Rule: class discounts ONLY apply when 2 or more classes are booked (chosen.length >= 2) */
      if (chosen.length >= 2) {
        var groups = { bread: [], pastry: [] };
        chosen.forEach(function (c) {
          var t = c.track === 'pastry' ? 'pastry' : 'bread';
          groups[t].push(c);
        });
        var remaining = [];
        ['bread', 'pastry'].forEach(function (track) {
          var g = groups[track];
          var pct = g.length >= 3 ? cfg.bundle_three_pct : (g.length === 2 ? cfg.bundle_two_pct : 0);
          if (pct > 0) {
            var gSum = g.reduce(function (s, c) { return s + c.fee; }, 0);
            var cut = Math.round(gSum * pct / 100);
            discount += cut;
            bundles.push({
              track: track,
              count: g.length,
              classes: g.length,
              percent: pct,
              pct: pct,
              discount: cut,
              amount: cut
            });
          } else if (g.length) {
            remaining = remaining.concat(g);
          }
        });
        /* If 2 or more classes were selected across both tracks (e.g. 1 Bread + 1 Pastry), apply the 2+ class discount */
        if (remaining.length > 0 && chosen.length >= 2) {
          var crossPct = chosen.length >= 3 ? cfg.bundle_three_pct : cfg.bundle_two_pct;
          if (crossPct > 0) {
            var rSum = remaining.reduce(function (s, c) { return s + c.fee; }, 0);
            var rCut = Math.round(rSum * crossPct / 100);
            discount += rCut;
            bundles.push({
              track: 'combined',
              count: remaining.length,
              classes: remaining.length,
              percent: crossPct,
              pct: crossPct,
              discount: rCut,
              amount: rCut
            });
          }
        }
      }
      return {
        ok: true,
        subtotal: subtotal,
        discount: discount,
        total: Math.max(0, subtotal - discount),
        has_quote: false,
        bundles: bundles
      };
    } else {
      var pSubtotal = 0;
      var pDiscount = 0;
      var hasQuote = false;
      var pBundles = [];
      var resolvedItems = [];
      var maxPrepDays = 0;
      var prepItems = [];
      for (var pi = 0; pi < rawItems.length; pi++) {
        var rItem = rawItems[pi];
        var resolved = resolveItemDetails(db, rItem);
        if (!resolved.valid) {
          return {
            ok: false,
            code: resolved.code || 'invalid_product',
            error: resolved.error || 'Invalid product in cart.'
          };
        }
        resolvedItems.push(resolved);
        var itemPrep = Number(resolved.prepDays) || 0;
        if (itemPrep > maxPrepDays) maxPrepDays = itemPrep;
        if (itemPrep > 0) {
          prepItems.push({
            id: resolved.id,
            name: resolved.name,
            prepDays: itemPrep
          });
        }
        if (resolved.quoteOnly) {
          hasQuote = true;
        } else {
          var gross = (Number(resolved.unitPrice) || 0) * resolved.qty;
          var cut = Number(resolved.lineDiscount) || 0;
          pSubtotal += gross;
          pDiscount += cut;
          if (cut > 0 && resolved.discountPct > 0) {
            pBundles.push({
              track: 'product',
              sku: resolved.sku || resolved.id,
              name: resolved.name,
              count: resolved.qty,
              percent: resolved.discountPct,
              pct: resolved.discountPct,
              discount: cut,
              amount: cut
            });
          }
          if (resolved.hasPending) hasQuote = true;
        }
      }
      return {
        ok: true,
        subtotal: pSubtotal,
        discount: pDiscount,
        total: Math.max(0, pSubtotal - pDiscount),
        has_quote: hasQuote,
        bundles: pBundles,
        items: resolvedItems,
        max_prep_days: maxPrepDays,
        earliest_date: localIsoDate(maxPrepDays),
        prep_items: prepItems
      };
    }
  }

  function normPhone(p) {
    return String(p || '').replace(/\D+/g, '').slice(-9);
  }

  function sanitizeOrderForClient(ord) {
    if (!ord || typeof ord !== 'object') return ord;
    var copy = Object.assign({}, ord);
    delete copy.token;
    return copy;
  }

  function validateProofEligibility(db, refRaw, tokenRaw) {
    var sRef = String(refRaw || '').trim().toUpperCase();
    var sTok = String(tokenRaw || '').trim();
    if (!sRef) {
      return { ok: false, code: 'not_found', error: 'Order reference is required.' };
    }
    var target = (db.orders || []).filter(function (o) {
      return String(o.ref || '').toUpperCase() === sRef;
    })[0];
    if (!target) {
      return { ok: false, code: 'not_found', error: 'Order not found.' };
    }
    /* Enforce customer ownership (anti-IDOR): if a different customer account is signed in,
       they cannot submit payment proof for this order even if they possess the reference or token. */
    var actor = getAuthenticatedOrderActor(db, true);
    var adminUser = getVerifiedLocalAdmin(db);
    if (target.customerId && actor && !adminUser && actor.userId !== target.customerId) {
      return {
        ok: false,
        auth: true,
        code: 'forbidden',
        error: 'Unauthorised: you cannot submit payment details for an order belonging to another customer account.'
      };
    }
    var isOwnerAuthenticated = !!(target.customerId && actor && actor.userId === target.customerId);
    if (!isOwnerAuthenticated && (!target.token || !sTok || sTok !== String(target.token))) {
      return {
        ok: false,
        code: 'token',
        error: 'Unauthorised payment submission: invalid or missing order security token.'
      };
    }
    var ordSt = String(target.orderStatus || target.order_status || 'submitted');
    if (ordSt === 'cancelled' || ordSt === 'completed') {
      return {
        ok: false,
        code: 'order_closed',
        error: 'Payment details cannot be submitted because this order is already ' + ordSt + '.'
      };
    }
    var pm = String(target.paymentMethod || target.payment_method || '');
    if (pm === 'cash_on_delivery' || pm === 'cash_on_pickup') {
      return {
        ok: false,
        code: 'not_applicable',
        error: 'Cash orders do not accept advance payment proof submissions.'
      };
    }
    var paySt = String(target.paymentStatus || target.payment_status || 'awaiting_payment');
    if (paySt === 'payment_verified') {
      return {
        ok: false,
        code: 'already_verified',
        error: 'Payment for this order has already been verified and confirmed by the baker. No further submissions are allowed.'
      };
    }
    if (paySt === 'payment_submitted' || (target.proofLocked === true && paySt !== 'payment_rejected')) {
      return {
        ok: false,
        code: 'duplicate_submission',
        error: 'Payment details have already been submitted for this order and are currently awaiting verification. Duplicate submissions are blocked.'
      };
    }
    if (paySt !== 'awaiting_payment' && paySt !== 'payment_rejected') {
      return {
        ok: false,
        code: 'invalid_state',
        error: 'This order is not currently eligible for payment submission.'
      };
    }
    return { ok: true, target: target };
  }

  function localRpc(name, args) {
    args = args || {};
    var db = loadLocalDb();
    var cfg = buildPublicConfig(db.settings, db);

    if (name === 'api_config') {
      return Promise.resolve({ ok: true, config: cfg });
    }
    if (name === 'api_catalogue') {
      return Promise.resolve({
        ok: true,
        classes: db.classes.filter(function (c) { return c.published !== false; }),
        products: db.products.filter(function (p) { return p.published !== false; }),
        categories: db.categories.filter(function (c) { return c.published !== false; }),
        options: db.options,
        config: cfg
      });
    }
    if (name === 'api_price') {
      return Promise.resolve(computeLocalPrice(db, args.p_type === 'class' ? 'class' : 'product', args.p_items || {}));
    }
    if (name === 'api_customer_whoami') {
      var actorWho = getAuthenticatedOrderActor(db, true);
      if (!actorWho) {
        return Promise.resolve({
          ok: true,
          signedIn: false,
          emailVerified: false,
          profile: null
        });
      }
      return Promise.resolve({
        ok: true,
        signedIn: true,
        emailVerified: !!actorWho.emailVerified,
        profile: {
          userId: actorWho.userId,
          email: actorWho.email,
          fullName: actorWho.fullName || '',
          phone: actorWho.phone || '',
          emailVerified: !!actorWho.emailVerified,
          createdAt: actorWho.createdAt || new Date().toISOString()
        }
      });
    }
    if (name === 'api_customer_update_profile') {
      var actorUpd = getAuthenticatedOrderActor(db, true);
      if (!actorUpd) {
        return Promise.resolve({
          ok: false,
          auth: true,
          code: 'auth_required',
          error: 'Please sign in to update your customer profile.'
        });
      }
      var newFullName = String(args.p_full_name !== undefined ? args.p_full_name : '').trim();
      var newPhone = String(args.p_phone !== undefined ? args.p_phone : '').trim();
      var phoneDigits = newPhone.replace(/\D+/g, '');
      if (newFullName.length < 2 || newFullName.length > 120) {
        return Promise.resolve({
          ok: false,
          code: 'invalid_name',
          error: 'Please enter your full name (2 to 120 characters).'
        });
      }
      if (phoneDigits.length < 7 || phoneDigits.length > 15) {
        return Promise.resolve({
          ok: false,
          code: 'invalid_phone',
          error: 'Please enter a valid phone number (7 to 15 digits).'
        });
      }
      var custRow = (db.customers || []).filter(function (c) {
        return c.userId === actorUpd.userId;
      })[0];
      var updNow = new Date().toISOString();
      if (custRow) {
        custRow.fullName = newFullName;
        custRow.phone = newPhone;
        custRow.updatedAt = updNow;
      } else {
        var admRow = (db.admins || []).filter(function (a) {
          return a.userId === actorUpd.userId;
        })[0];
        if (admRow) {
          admRow.name = newFullName;
          admRow.phone = newPhone;
        }
      }
      saveLocalDb(db);
      if (session && session.user) {
        session.user.name = newFullName;
        session.user.fullName = newFullName;
        session.user.phone = newPhone;
        var remProf = true;
        try { remProf = !!localStorage.getItem(SESSION_KEY); } catch (_) {}
        writeSession(session, remProf);
        notifyAuthChange();
      }
      return Promise.resolve({
        ok: true,
        profile: {
          userId: actorUpd.userId,
          email: actorUpd.email,
          fullName: newFullName,
          phone: newPhone,
          emailVerified: !!actorUpd.emailVerified,
          createdAt: actorUpd.createdAt || updNow,
          updatedAt: updNow
        }
      });
    }
    if (name === 'api_customer_orders') {
      var actorOrd = getAuthenticatedOrderActor(db, true);
      if (!actorOrd) {
        return Promise.resolve({
          ok: false,
          auth: true,
          code: 'auth_required',
          error: 'Please sign in to view your order and booking history.'
        });
      }
      var ownOrders = (db.orders || [])
        .filter(function (o) {
          return o && o.customerId === actorOrd.userId && o.kind !== 'class';
        })
        .map(sanitizeOrderForClient);
      var ownBookings = (db.orders || [])
        .filter(function (o) {
          return o && o.customerId === actorOrd.userId && o.kind === 'class';
        })
        .map(sanitizeOrderForClient);
      var ownItems = (db.orderItems || []).filter(function (oi) {
        return oi && oi.customerId === actorOrd.userId;
      });
      var ownPayments = (db.payments || []).filter(function (py) {
        return py && py.customerId === actorOrd.userId;
      });
      return Promise.resolve({
        ok: true,
        orders: ownOrders,
        bookings: ownBookings,
        orderItems: ownItems,
        payments: ownPayments
      });
    }
    if (name === 'api_place_order') {
      var kind = args.p_kind === 'class' ? 'class' : 'product';
      var payload = args.p_payload || {};
      var idemKey = String(args.p_idem || payload.idemKey || '').trim();

      /* 1. Guest checkout is permitted. A session is optional; when present it is
            linked to the order, but it is never required. */
      var actor = getAuthenticatedOrderActor(db, true);
      var isGuest = !actor;
      var actorId = actor ? actor.userId : null;

      /* 2. Idempotency check. A guest must never be able to recover another
            guest's order token by guessing the key, so the phone must match too. */
      var cust0 = payload.customer || {};
      var phone0 = String(cust0.phone || payload.phone || '').trim().slice(0, 24);
      if (idemKey) {
        if (IN_FLIGHT_ORDERS[idemKey]) {
          return Promise.resolve({
            ok: false,
            code: 'duplicate_in_flight',
            error: 'Your order is already being processed. Please wait.'
          });
        }
        var existingIdem = (db.orders || []).filter(function (o) {
          return o.idemKey && o.idemKey === idemKey && (o.customerId || null) === actorId;
        })[0];
        if (existingIdem) {
          if (isGuest && normPhone(existingIdem.phone || '') !== normPhone(phone0)) {
            return Promise.resolve({
              ok: false,
              code: 'idempotency_conflict',
              error: 'That request could not be completed. Please submit the order again.'
            });
          }
          return Promise.resolve({
            ok: true,
            deduplicated: true,
            token: existingIdem.token,
            statusUrl: 'order.html?ref=' + encodeURIComponent(existingIdem.ref) + '&token=' + encodeURIComponent(existingIdem.token),
            order: sanitizeOrderForClient(existingIdem)
          });
        }
      }

      var cust = payload.customer || {};
      var nameStr = String(cust.name || payload.name || (actor && actor.fullName) || '').trim().slice(0, 120);
      var phoneStr = String(cust.phone || payload.phone || (actor && actor.phone) || '').trim().slice(0, 24);
      /* The e-mail comes from the verified session for signed-in customers and
         from the form for guests. A browser-supplied customerId is never trusted. */
      var emailStr = actor ? (actor.email || '') : String(cust.email || payload.email || '').trim().slice(0, 160);
      if (nameStr.length < 2 || !phoneStr || normPhone(phoneStr).length < 7) {
        return Promise.resolve({ ok: false, code: 'invalid_customer', error: 'Please enter a valid full name and reachable phone number.' });
      }
      if (emailStr && !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(emailStr)) {
        return Promise.resolve({ ok: false, code: 'invalid_email', error: 'That e-mail address does not look right. You can also leave it blank.' });
      }

      /* Guest anti-abuse throttle: max 5 guest orders per phone per hour. */
      if (isGuest) {
        var hourAgo = Date.now() - 3600000;
        var recentSamePhone = (db.orders || []).filter(function (o) {
          return !o.customerId &&
            normPhone(o.phone || '') === normPhone(phoneStr) &&
            new Date(o.createdAt || 0).getTime() > hourAgo;
        }).length;
        if (recentSamePhone >= 5) {
          return Promise.resolve({
            ok: false,
            code: 'rate_limited',
            error: 'Several orders have just been placed with this phone number. Please wait a little while, or message the kitchen directly.'
          });
        }
      }

      var rawItems = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload.classes) ? payload.classes : []);
      if (!rawItems.length) {
        return Promise.resolve({
          ok: false,
          code: 'empty_cart',
          error: kind === 'class' ? 'Please select at least one class to book.' : 'Your cart is empty. Please add at least one item.'
        });
      }
      if (rawItems.length > 50) {
        return Promise.resolve({ ok: false, code: 'too_many_items', error: 'Too many line items in a single order.' });
      }
      for (var ii = 0; ii < rawItems.length; ii++) {
        var rIt = rawItems[ii];
        if (rIt && typeof rIt === 'object' && rIt.qty !== undefined) {
          var qNum = Number(rIt.qty);
          if (!isFinite(qNum) || qNum < 1 || qNum > 100 || Math.floor(qNum) !== qNum) {
            return Promise.resolve({ ok: false, code: 'invalid_quantity', error: 'Item quantity must be a whole number between 1 and 100.' });
          }
        }
      }

      var fulfil = payload.fulfilment === 'delivery' ? 'delivery' : 'pickup';
      var addrStr = String(payload.address || '').trim().slice(0, 300);
      if (kind === 'product' && fulfil === 'delivery' && addrStr.length < 6) {
        return Promise.resolve({ ok: false, code: 'invalid_address', error: 'Please enter a delivery address of at least 6 characters.' });
      }

      var pm = String(payload.paymentMethod || 'cash_on_pickup').trim();
      var validMethods = { momo: true, bank_transfer: true, cash_on_delivery: true, cash_on_pickup: true };
      if (!validMethods[pm]) {
        return Promise.resolve({ ok: false, code: 'invalid_payment_method', error: 'Invalid payment method selected.' });
      }

      /* 3. Server-side catalogue, custom cake spec, and price calculation */
      var priced = computeLocalPrice(db, kind, { items: rawItems });
      if (!priced || !priced.ok) {
        return Promise.resolve({
          ok: false,
          code: (priced && priced.code) || 'invalid_product',
          error: (priced && priced.error) || 'One or more items in your cart could not be validated.'
        });
      }
      var eventDateStr = String(payload.eventDate || payload.preferredDate || '').trim().slice(0, 40);
      var maxPrep = Number(priced.max_prep_days) || 0;
      var todayYmd = localIsoDate(0);
      var earliestYmd = localIsoDate(maxPrep);

      if (kind === 'product') {
        if (!eventDateStr) {
          return Promise.resolve({
            ok: false,
            code: 'date_required',
            earliestDate: earliestYmd,
            maxPrepDays: maxPrep,
            error: 'Please select a preferred order date (the day you want your pastries) before placing your order.'
          });
        }
        var dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDateStr);
        if (!dateMatch) {
          return Promise.resolve({
            ok: false,
            code: 'date_invalid',
            earliestDate: earliestYmd,
            maxPrepDays: maxPrep,
            error: 'Please choose a valid calendar date (YYYY-MM-DD) for your order.'
          });
        }
        var parsedCal = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), 12, 0, 0);
        if (
          isNaN(parsedCal.getTime()) ||
          parsedCal.getFullYear() !== Number(dateMatch[1]) ||
          (parsedCal.getMonth() + 1) !== Number(dateMatch[2]) ||
          parsedCal.getDate() !== Number(dateMatch[3])
        ) {
          return Promise.resolve({
            ok: false,
            code: 'date_invalid',
            earliestDate: earliestYmd,
            maxPrepDays: maxPrep,
            error: 'Please choose a valid calendar date for your order.'
          });
        }
        if (eventDateStr < todayYmd) {
          return Promise.resolve({
            ok: false,
            code: 'date_in_past',
            earliestDate: earliestYmd,
            maxPrepDays: maxPrep,
            error: 'Preferred order date cannot be in the past. The earliest available date for your order is ' + formatOrderDate(earliestYmd) + ' (' + earliestYmd + ').'
          });
        }
        if (eventDateStr < earliestYmd) {
          var limitingNames = (priced.prep_items || [])
            .filter(function (pi) { return pi.prepDays === maxPrep; })
            .map(function (pi) { return pi.name; });
          var itemPhrase = limitingNames.length
            ? ' (' + limitingNames.slice(0, 2).join(', ') + (limitingNames.length > 2 ? ', +' + (limitingNames.length - 2) + ' more' : '') + ')'
            : '';
          return Promise.resolve({
            ok: false,
            code: 'date_too_early',
            earliestDate: earliestYmd,
            maxPrepDays: maxPrep,
            error: 'Your cart includes pastries that require at least ' + maxPrep + ' ' + (maxPrep === 1 ? 'day' : 'days') + ' of advance preparation' + itemPhrase + '. The earliest available date is ' + formatOrderDate(earliestYmd) + ' (' + earliestYmd + ').'
          });
        }
      }

      /* 4. Special Order Threshold: strictly greater than GH₵ 700.00 (priced.total > cfg.advance_threshold) */
      var advanceRequired = !!(priced.has_quote || priced.total > cfg.advance_threshold);
      var isCashMethod = (pm === 'cash_on_delivery' || pm === 'cash_on_pickup');
      if (isCashMethod) {
        if (advanceRequired) {
          return Promise.resolve({
            ok: false,
            code: 'advance_required',
            error: 'Orders strictly above GH\u20B5 ' + (cfg.advance_threshold / 100).toFixed(2) + ' (or custom quote items) require advance payment via Mobile Money or Bank Transfer.'
          });
        }
        if (pm === 'cash_on_delivery' && !cfg.cash.delivery) {
          return Promise.resolve({ ok: false, code: 'method_disabled', error: 'Cash on delivery is currently disabled.' });
        }
        if (pm === 'cash_on_pickup' && !cfg.cash.pickup) {
          return Promise.resolve({ ok: false, code: 'method_disabled', error: 'Cash on pickup is currently disabled.' });
        }
      }

      var orderItems = rawItems.map(function (it) {
        var resolved = resolveItemDetails(db, kind === 'class' ? { kind: 'class', slug: typeof it === 'string' ? it : (it.slug || it.id) } : it);
        var q = resolved.qty;
        var u = resolved.quoteOnly ? null : resolved.unitPrice;
        var grossLine = u === null ? null : u * q;
        var itemDisc = resolved.lineDiscount || 0;
        return {
          id: resolved.id,
          kind: resolved.kind || (kind === 'class' ? 'class' : 'product'),
          sku: resolved.sku || null,
          slug: resolved.slug || null,
          name: resolved.name,
          meta: resolved.meta,
          qty: q,
          unitPrice: u,
          discountPct: resolved.discountPct || 0,
          lineTotal: grossLine === null ? null : Math.max(0, grossLine - itemDisc),
          discount: itemDisc,
          prepDays: resolved.prepDays || 0,
          custom: (it && (it.spec || it.custom)) || null
        };
      });
      var ref = (kind === 'class' ? 'MC-' : 'MB-') + Math.random().toString(36).slice(2, 8).toUpperCase();
      var token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      var payStatus = isCashMethod ? 'pay_on_collection' : 'awaiting_payment';
      var nowIso = new Date().toISOString();
      var notesStr = String(payload.notes || '').trim().slice(0, 500);
      var order = {
        ref: ref,
        token: token,
        idemKey: idemKey || null,
        kind: kind,
        customerId: actorId,
        customer_id: actorId,
        createdAt: nowIso,
        created_at: nowIso,
        receiptVersion: 1,
        customer: { name: nameStr, phone: phoneStr, email: emailStr },
        customer_name: nameStr,
        phone: phoneStr,
        email: emailStr,
        items: orderItems,
        subtotal: priced.subtotal,
        discount: priced.discount,
        total: priced.total,
        advanceRequired: advanceRequired,
        advance_required: advanceRequired,
        bundles: priced.bundles || [],
        paymentMethod: pm,
        payment_method: pm,
        paymentStatus: payStatus,
        payment_status: payStatus,
        orderStatus: 'submitted',
        order_status: 'submitted',
        fulfilment: fulfil,
        address: addrStr,
        eventDate: eventDateStr,
        event_date: eventDateStr,
        prepDays: maxPrep,
        notes: notesStr,
        paymentRef: '',
        hasProof: false,
        proofPath: '',
        proofLocked: false,
        proofSubmittedAt: null,
        submissionCount: 0,
        paymentSubmissions: [],
        verifiedAt: null,
        events: [{ kind: 'created', message: (kind === 'class' ? 'Booking' : 'Order') + ' placed by customer (' + emailStr + ')', at: nowIso, actor: emailStr }],
        notifications: []
      };

      /* 5. Atomically insert order, orderItems, payments, and classBookings */
      db.orders.unshift(order);
      db.orderItems = Array.isArray(db.orderItems) ? db.orderItems : [];
      orderItems.forEach(function (oi, idx) {
        db.orderItems.push({
          id: 'oi-' + ref + '-' + idx,
          orderRef: ref,
          customerId: actorId,
          lineIndex: idx,
          itemKind: oi.custom ? 'custom_cake' : (kind === 'class' ? 'class' : 'product'),
          productSku: oi.sku || null,
          classSlug: oi.slug || null,
          itemName: oi.name,
          itemMeta: oi.meta || '',
          qty: oi.qty,
          unitPrice: oi.unitPrice,
          discountPct: oi.discountPct || 0,
          lineDiscount: oi.discount || 0,
          lineTotal: oi.lineTotal,
          prepDays: oi.prepDays || 0,
          customSpec: oi.custom || null,
          createdAt: nowIso
        });
      });
      db.payments = Array.isArray(db.payments) ? db.payments : [];
      db.payments.unshift({
        id: 'pay-' + ref,
        orderRef: ref,
        customerId: actorId,
        paymentMethod: pm,
        expectedAmount: priced.total,
        transactionReference: '',
        proofImagePath: '',
        customerNote: '',
        verificationStatus: payStatus,
        requiresPreConfirmationVerification: advanceRequired,
        submittedAt: null,
        verifiedAt: null,
        verifiedBy: '',
        rejectReason: '',
        createdAt: nowIso,
        updatedAt: nowIso
      });
      if (kind === 'class') {
        db.classBookings = Array.isArray(db.classBookings) ? db.classBookings : [];
        db.classBookings.unshift({
          id: 'cb-' + ref,
          bookingRef: ref,
          customerId: actorId,
          courses: orderItems,
          bundles: priced.bundles || [],
          subtotal: priced.subtotal,
          discount: priced.discount,
          total: priced.total,
          paymentMethod: pm,
          paymentStatus: payStatus,
          bookingStatus: 'submitted',
          notes: notesStr,
          createdAt: nowIso,
          updatedAt: nowIso
        });
      }

      /* Sync customer profile name/phone if not already set */
      var custProf = (db.customers || []).filter(function (c) { return c.userId === actorId; })[0];
      if (custProf) {
        if (!custProf.fullName || custProf.fullName.length < 2) custProf.fullName = nameStr;
        if (!custProf.phone || custProf.phone.length < 7) custProf.phone = phoneStr;
        custProf.updatedAt = nowIso;
      }

      db.activity.unshift({ kind: 'created', order_ref: ref, message: 'New ' + (kind === 'class' ? 'class booking' : 'order') + ' from ' + nameStr, at: nowIso, actor: emailStr });
      saveLocalDb(db);
      try {
        localStorage.setItem('mb-last-order-v1', JSON.stringify({ ref: ref, token: token }));
      } catch (_) {}
      return Promise.resolve({
        ok: true,
        token: token,
        statusUrl: 'order.html?ref=' + encodeURIComponent(ref) + '&token=' + encodeURIComponent(token),
        order: sanitizeOrderForClient(order)
      });
    }
    if (name === 'api_lookup_order') {
      var qRef = String(args.p_ref || '').trim().toUpperCase();
      var qPhone = normPhone(args.p_phone || '');
      if (!qRef || !/^M[BC]-[A-Z0-9-]{4,20}$/.test(qRef)) {
        return Promise.resolve({ ok: false, error: 'Please enter a valid order or booking reference (e.g. MB-123456).' });
      }
      if (!qPhone || qPhone.length < 7) {
        return Promise.resolve({ ok: false, error: 'Please enter the phone number used when placing the order.' });
      }
      var rlLookup = checkRateLimit('lookup', qRef, 8, 5 * 60 * 1000);
      if (!rlLookup.allowed) {
        return Promise.resolve({ ok: false, code: 'rate_limited', error: rlLookup.error });
      }
      var found = db.orders.filter(function (o) {
        return o.ref.toUpperCase() === qRef && normPhone(o.phone) === qPhone;
      })[0];
      if (!found) {
        rlLookup.recordFailure();
        return Promise.resolve({ ok: false, error: 'We could not find an order matching that reference and phone number.' });
      }
      /* Anti-IDOR check: if an authenticated customer is signed in, they cannot look up another customer's order */
      var actorLookup = getAuthenticatedOrderActor(db, true);
      var adminLookup = getVerifiedLocalAdmin(db);
      if (found.customerId && actorLookup && !adminLookup && actorLookup.userId !== found.customerId) {
        return Promise.resolve({
          ok: false,
          auth: true,
          code: 'forbidden',
          error: 'Access denied: that order belongs to a different customer account.'
        });
      }
      rlLookup.reset();
      return Promise.resolve({
        ok: true,
        ref: found.ref,
        kind: found.kind,
        token: found.token,
        statusUrl: 'order.html?ref=' + encodeURIComponent(found.ref) + '&token=' + encodeURIComponent(found.token),
        order: sanitizeOrderForClient(found)
      });
    }
    if (name === 'api_order') {
      var oRef = String(args.p_ref || '').trim().toUpperCase();
      var ord = db.orders.filter(function (o) { return o.ref.toUpperCase() === oRef; })[0];
      if (!ord) {
        return Promise.resolve({ ok: false, code: 'not_found', error: 'Order not found.' });
      }
      var actorRead = getAuthenticatedOrderActor(db, true);
      var adminRead = getVerifiedLocalAdmin(db);
      /* Anti-IDOR check: if a different customer account is signed in, block access even if they pass the token */
      if (ord.customerId && actorRead && !adminRead && actorRead.userId !== ord.customerId) {
        return Promise.resolve({
          ok: false,
          auth: true,
          code: 'forbidden',
          error: 'Access denied: you can only view orders belonging to your own customer account.'
        });
      }
      var isOwnerRead = !!(ord.customerId && actorRead && actorRead.userId === ord.customerId);
      if (!adminRead && !isOwnerRead && (!ord.token || String(args.p_token || '') !== String(ord.token))) {
        return Promise.resolve({ ok: false, code: 'token', error: 'That order link is missing or has an invalid security token.' });
      }
      return Promise.resolve({
        ok: true,
        order: sanitizeOrderForClient(ord),
        kind: ord.kind || (/^MC-/.test(ord.ref) ? 'class' : 'product'),
        momo: cfg.momo || null,
        bank: cfg.bank || null,
        config: cfg
      });
    }
    if (name === 'api_begin_proof_upload') {
      var eligUpload = validateProofEligibility(db, args.p_ref, args.p_token);
      if (!eligUpload.ok) {
        return Promise.resolve(eligUpload);
      }
      var cleanExt = String(args.p_ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (['jpg', 'jpeg', 'png', 'webp'].indexOf(cleanExt) === -1) {
        return Promise.resolve({
          ok: false,
          code: 'invalid_image',
          error: 'Only PNG, JPEG, and WebP payment screenshots are allowed.'
        });
      }
      var pPath = 'local/' + eligUpload.target.ref + '-' + Date.now() + '.' + cleanExt;
      return Promise.resolve({ ok: true, path: pPath });
    }
    if (name === 'api_submit_proof') {
      var elig = validateProofEligibility(db, args.p_ref, args.p_token);
      if (!elig.ok) {
        return Promise.resolve(elig);
      }
      var target = elig.target;
      var rlProof = checkRateLimit('proof', target.ref, 6, 5 * 60 * 1000);
      if (!rlProof.allowed) {
        return Promise.resolve({ ok: false, code: 'rate_limited', error: rlProof.error });
      }

      var refClean = String(args.p_reference || '').trim();
      var imgPath = String(args.p_image_path || '').trim();
      var noteClean = String(args.p_note || '').trim().slice(0, 200);

      if (!refClean && !imgPath) {
        rlProof.recordFailure();
        return Promise.resolve({
          ok: false,
          code: 'missing_proof',
          error: 'Please provide your payment transaction reference ID, a payment screenshot, or both.'
        });
      }
      if (refClean) {
        if (refClean.length < 4 || refClean.length > 80 || !/^[A-Za-z0-9\-_./#: ]{4,80}$/.test(refClean)) {
          rlProof.recordFailure();
          return Promise.resolve({
            ok: false,
            code: 'invalid_reference',
            error: 'Transaction reference must be 4 to 80 alphanumeric characters.'
          });
        }
        var normRefUpper = refClean.toUpperCase();
        // Check if this exact reference was already submitted on another active order
        var duplicateOtherOrder = (db.orders || []).some(function (o) {
          if (!o || o.ref === target.ref) return false;
          if (o.paymentStatus !== 'payment_submitted' && o.paymentStatus !== 'payment_verified') return false;
          if (String(o.paymentRef || '').trim().toUpperCase() === normRefUpper) return true;
          if (Array.isArray(o.paymentSubmissions)) {
            return o.paymentSubmissions.some(function (sub) {
              return sub && String(sub.reference || '').trim().toUpperCase() === normRefUpper;
            });
          }
          return false;
        });
        // Or if this exact reference was already submitted and rejected on the same order
        var duplicateSameOrder = Array.isArray(target.paymentSubmissions) && target.paymentSubmissions.some(function (sub) {
          return sub && String(sub.reference || '').trim().toUpperCase() === normRefUpper;
        });
        if (duplicateOtherOrder || duplicateSameOrder) {
          rlProof.recordFailure();
          return Promise.resolve({
            ok: false,
            code: 'duplicate_reference',
            error: 'That payment transaction reference has already been submitted and cannot be reused.'
          });
        }
      }

      if (imgPath) {
        var storedDataUrl = db.proofs && db.proofs[imgPath];
        if (!storedDataUrl) {
          return Promise.resolve({
            ok: false,
            code: 'invalid_image',
            error: 'Uploaded screenshot record was not found. Please select the image and try again.'
          });
        }
        var vCheck = verifyImageDataUrl(storedDataUrl);
        if (!vCheck.ok) {
          delete db.proofs[imgPath];
          saveLocalDb(db);
          return Promise.resolve(vCheck);
        }
      }

      var tNow = new Date().toISOString();
      if (refClean) target.paymentRef = refClean;
      if (imgPath) {
        target.hasProof = true;
        target.proofPath = imgPath;
      }
      if (noteClean) target.proofNote = noteClean;

      /* Critical: Do NOT mark as payment_verified automatically; keep as payment_submitted (pending verification) */
      target.paymentStatus = 'payment_submitted';
      target.payment_status = 'payment_submitted';
      target.proofLocked = true;
      target.proofSubmittedAt = tNow;
      target.submissionCount = (Number(target.submissionCount) || 0) + 1;
      target.paymentSubmissions = Array.isArray(target.paymentSubmissions) ? target.paymentSubmissions : [];
      target.paymentSubmissions.push({
        id: 'sub-' + Date.now() + '-' + target.submissionCount,
        submittedAt: tNow,
        reference: refClean || '',
        hasImage: !!imgPath,
        imagePath: imgPath || '',
        note: noteClean || '',
        status: 'pending_verification'
      });

      /* Sync normalized payment record */
      var payRow = (db.payments || []).filter(function (py) { return py.orderRef === target.ref; })[0];
      if (payRow) {
        if (refClean) payRow.transactionReference = refClean;
        if (imgPath) payRow.proofImagePath = imgPath;
        if (noteClean) payRow.customerNote = noteClean;
        payRow.verificationStatus = 'payment_submitted';
        payRow.submittedAt = tNow;
        payRow.updatedAt = tNow;
      }
      var cbRow = (db.classBookings || []).filter(function (cb) { return cb.bookingRef === target.ref; })[0];
      if (cbRow) {
        cbRow.paymentStatus = 'payment_submitted';
        cbRow.updatedAt = tNow;
      }

      target.events = target.events || [];
      target.events.unshift({
        kind: 'proof',
        message: 'Payment details submitted by customer' + (refClean ? ' (Ref: ' + refClean + ')' : '') + ' — awaiting baker verification',
        at: tNow,
        actor: target.customer_name
      });
      db.activity.unshift({
        kind: 'proof',
        order_ref: target.ref,
        message: 'Payment proof submitted (pending verification)',
        at: tNow,
        actor: target.customer_name
      });
      saveLocalDb(db);

      try {
        localStorage.setItem('mb-proof-sync-v1', JSON.stringify({
          ref: target.ref,
          paymentStatus: 'payment_submitted',
          paymentRef: target.paymentRef || '',
          hasProof: !!target.hasProof,
          submittedAt: tNow
        }));
      } catch (_) {}
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('mb-proof-submitted', {
            detail: { ref: target.ref, order: sanitizeOrderForClient(target) }
          }));
        }
      } catch (_) {}

      return Promise.resolve({ ok: true, order: sanitizeOrderForClient(target) });
    }
    if (name === 'api_admin_whoami') {
      var signed = MB.isSignedIn();
      var sEmail = String((session && session.user && session.user.email) || '').trim().toLowerCase();
      var adminMatch = getVerifiedLocalAdmin(db, true);
      var primaryRecord = (db.admins || []).filter(function (a) {
        return String(a && a.email || '').trim().toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL;
      })[0];
      var roleName = adminMatch ? normalizeAdminRole(adminMatch.role, adminMatch.email) : (signed ? ((session && session.user && session.user.role) || 'customer') : null);
      var isActiveAdmin = !!(adminMatch && adminMatch.active !== false);
      return Promise.resolve({
        ok: true,
        signedIn: signed,
        isAdmin: isActiveAdmin,
        email: adminMatch ? adminMatch.email : (sEmail || ''),
        name: adminMatch ? (adminMatch.name || '') : '',
        role: isActiveAdmin ? roleName : null,
        isSuperAdmin: isActiveAdmin && roleName === 'super_admin',
        isPrimarySuperAdmin: !!(isActiveAdmin && adminMatch && adminMatch.email === PRIMARY_SUPER_ADMIN_EMAIL),
        mustChangePassword: !!(isActiveAdmin && adminMatch && adminMatch.mustChangePassword),
        deactivated: !!(adminMatch && adminMatch.active === false),
        setupRequired: !!(primaryRecord && !primaryRecord.isProvisioned),
        permissions: isActiveAdmin ? getRolePermissions(roleName) : null
      });
    }
    if (name === 'api_admin_complete_first_login') {
      var flMatch = getVerifiedLocalAdmin(db, true);
      if (!flMatch || flMatch.active === false) {
        return Promise.resolve({
          ok: false,
          auth: true,
          code: 'unauthorised',
          error: 'Unauthorised: please sign in to complete your first-login password change.'
        });
      }
      var curPw = String((args.p_current_password !== undefined ? args.p_current_password : (args.p_payload && args.p_payload.currentPassword)) || '');
      var nextPw = String((args.p_new_password !== undefined ? args.p_new_password : (args.p_payload && args.p_payload.newPassword)) || '');
      if (!curPw) {
        return Promise.resolve({ ok: false, code: 'current_password_required', error: 'Please enter your current temporary password.' });
      }
      var curDigest = hashAdminCredential(flMatch.email, curPw);
      if (!flMatch.passwordDigest || flMatch.passwordDigest !== curDigest) {
        return Promise.resolve({ ok: false, code: 'invalid_current_password', error: 'The current temporary password you entered is incorrect.' });
      }
      if (nextPw === curPw) {
        return Promise.resolve({ ok: false, code: 'same_password', error: 'Your new password must be different from your temporary password.' });
      }
      var pwCheck = validateStrongPassword(nextPw, flMatch.email);
      if (!pwCheck.ok) {
        return Promise.resolve({ ok: false, code: 'weak_password', error: pwCheck.error });
      }
      var changedAt = new Date().toISOString();
      flMatch.passwordDigest = hashAdminCredential(flMatch.email, nextPw);
      flMatch.mustChangePassword = false;
      flMatch.isProvisioned = true;
      flMatch.passwordChangedAt = changedAt;
      recordAdminAudit(db, 'first_login_password_changed', flMatch.email, flMatch.email, 'Mandatory first-login password change completed for ' + flMatch.email);
      saveLocalDb(db);
      if (session && session.user) {
        session.user.mustChangePassword = false;
        var rem = true;
        try { rem = !!localStorage.getItem(SESSION_KEY); } catch (_) {}
        writeSession(session, rem);
        notifyAuthChange();
      }
      return Promise.resolve({
        ok: true,
        email: flMatch.email,
        role: normalizeAdminRole(flMatch.role, flMatch.email),
        mustChangePassword: false,
        passwordChangedAt: changedAt
      });
    }
    /* Strict RBAC + Mandatory First-Login Password Gate for all administrative RPCs */
    if (name.indexOf('api_admin_') === 0) {
      var reqPerm = 'view';
      if (name === 'api_admin_verify') reqPerm = 'verify';
      else if (name === 'api_admin_update_order') reqPerm = 'orders';
      else if (name === 'api_admin_settings') reqPerm = 'settings';
      else if (name === 'api_admin_product' || name === 'api_admin_class' || name === 'api_admin_category' || name === 'api_admin_option' || name === 'api_admin_discounts') {
        reqPerm = 'catalogue';
      } else if (name === 'api_admin_team') {
        var teamAct = String((args.p_payload && args.p_payload.action) || 'list').toLowerCase();
        reqPerm = teamAct === 'list' ? 'view' : 'team';
      }
      var authErr = requireAdmin(db, reqPerm);
      if (authErr) return Promise.resolve(authErr);
    }
    if (name === 'api_admin_team') {
      var tp = args.p_payload || {};
      var act = String(tp.action || 'list').toLowerCase();
      var callerAdmin = getVerifiedLocalAdmin(db);
      var callerEmail = callerAdmin ? callerAdmin.email : '';
      var isCallerSuper = !!(callerAdmin && normalizeAdminRole(callerAdmin.role, callerAdmin.email) === 'super_admin' && callerAdmin.email === PRIMARY_SUPER_ADMIN_EMAIL);

      function sanitizeAdminRow(a) {
        var rRole = normalizeAdminRole(a.role, a.email);
        return {
          userId: a.userId,
          email: a.email,
          name: a.name || (a.email === PRIMARY_SUPER_ADMIN_EMAIL ? 'Mystery Bakebite (Super Admin)' : a.email.split('@')[0]),
          role: rRole,
          roleLabel: getRolePermissions(rRole).label,
          isPrimarySuperAdmin: a.email === PRIMARY_SUPER_ADMIN_EMAIL,
          active: a.active !== false,
          mustChangePassword: !!a.mustChangePassword,
          isProvisioned: !!a.isProvisioned,
          createdAt: a.createdAt || '2026-01-15T08:00:00Z',
          lastSignInAt: a.lastSignInAt || null,
          passwordChangedAt: a.passwordChangedAt || null,
          invitedBy: a.invitedBy || null,
          permissions: getRolePermissions(rRole)
        };
      }

      if (act === 'list') {
        var publicAdmins = (db.admins || []).map(sanitizeAdminRow);
        return Promise.resolve({
          ok: true,
          admins: publicAdmins,
          canManageTeam: isCallerSuper,
          primarySuperAdminEmail: PRIMARY_SUPER_ADMIN_EMAIL,
          roles: ADMIN_ROLE_PERMISSIONS,
          auditLog: isCallerSuper ? (db.adminAuditLog || []).slice(0, 50) : []
        });
      }

      /* Exclusive Super Administrator authority check for all user-management mutations */
      if (!isCallerSuper) {
        return Promise.resolve({
          ok: false,
          code: 'forbidden',
          error: 'Only the primary Super Administrator (' + PRIMARY_SUPER_ADMIN_EMAIL + ') is authorized to create, modify, or remove user accounts and roles.'
        });
      }

      if (act === 'create' || act === 'invite') {
        var newEm = String(tp.email || '').trim().toLowerCase();
        var newName = String(tp.name || '').trim().slice(0, 80);
        var reqRole = String(tp.role || 'administrator').trim().toLowerCase();
        var providedPw = String(tp.password || '').trim();

        if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(newEm)) {
          return Promise.resolve({ ok: false, error: 'Enter a valid email address.' });
        }
        if (/^demo\.|^test\./i.test(newEm) || newEm === 'demo.admin@mysterybakebite.com') {
          return Promise.resolve({ ok: false, code: 'demo_prohibited', error: 'Demo and test accounts are not permitted in production.' });
        }
        if (reqRole === 'super_admin' || newEm === PRIMARY_SUPER_ADMIN_EMAIL) {
          return Promise.resolve({
            ok: false,
            code: 'super_admin_exclusive',
            error: 'The Super Administrator role is exclusively reserved for ' + PRIMARY_SUPER_ADMIN_EMAIL + ' and cannot be assigned to another account.'
          });
        }
        if (['administrator', 'manager', 'viewer'].indexOf(reqRole) === -1) {
          return Promise.resolve({ ok: false, code: 'invalid_role', error: 'Select a valid role: Administrator, Order & Kitchen Manager, or Read-Only Viewer.' });
        }
        var exists = (db.admins || []).some(function (a) {
          return String(a.email || '').trim().toLowerCase() === newEm;
        });
        if (exists) {
          return Promise.resolve({ ok: false, code: 'duplicate_user', error: 'An account with that email address already exists on the roster.' });
        }

        var tempPw = providedPw || generateSecureTemporaryPassword();
        var pwValid = validateStrongPassword(tempPw, newEm);
        if (!pwValid.ok) {
          return Promise.resolve({ ok: false, code: 'weak_password', error: pwValid.error });
        }

        var createdRow = {
          userId: 'user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          email: newEm,
          name: newName || newEm.split('@')[0],
          role: reqRole,
          isPrimarySuperAdmin: false,
          active: true,
          isProvisioned: true,
          mustChangePassword: true,
          createdAt: new Date().toISOString(),
          lastSignInAt: null,
          passwordChangedAt: null,
          invitedBy: callerEmail,
          passwordDigest: hashAdminCredential(newEm, tempPw)
        };
        db.admins.push(createdRow);
        recordAdminAudit(
          db,
          'user_created',
          callerEmail,
          newEm,
          'Created user ' + newEm + ' with role "' + getRolePermissions(reqRole).label + '" (mandatory first-login password change enabled)'
        );
        saveLocalDb(db);
        return Promise.resolve({
          ok: true,
          user: sanitizeAdminRow(createdRow),
          temporaryPassword: tempPw,
          mustChangePassword: true
        });
      }

      var targetId = String(tp.userId || '').trim();
      var targetEmail = String(tp.email || '').trim().toLowerCase();
      var targetUser = (db.admins || []).filter(function (a) {
        return (targetId && a.userId === targetId) || (targetEmail && a.email === targetEmail);
      })[0];
      if (!targetUser) {
        return Promise.resolve({ ok: false, code: 'not_found', error: 'Target user account was not found.' });
      }

      /* Primary Super Administrator Immutability Protection */
      if (targetUser.email === PRIMARY_SUPER_ADMIN_EMAIL || targetUser.isPrimarySuperAdmin) {
        return Promise.resolve({
          ok: false,
          code: 'super_admin_protected',
          error: 'The primary Super Administrator (' + PRIMARY_SUPER_ADMIN_EMAIL + ') is protected and cannot be modified, demoted, deactivated, or removed.'
        });
      }

      if (act === 'update_role') {
        var nextRole = String(tp.role || '').trim().toLowerCase();
        if (nextRole === 'super_admin') {
          return Promise.resolve({
            ok: false,
            code: 'super_admin_exclusive',
            error: 'The Super Administrator role is exclusively reserved for ' + PRIMARY_SUPER_ADMIN_EMAIL + '.'
          });
        }
        if (['administrator', 'manager', 'viewer'].indexOf(nextRole) === -1) {
          return Promise.resolve({ ok: false, code: 'invalid_role', error: 'Invalid role specified.' });
        }
        var oldRole = targetUser.role;
        targetUser.role = nextRole;
        if (tp.name !== undefined && String(tp.name).trim()) {
          targetUser.name = String(tp.name).trim().slice(0, 80);
        }
        recordAdminAudit(
          db,
          'role_updated',
          callerEmail,
          targetUser.email,
          'Updated role for ' + targetUser.email + ' from "' + getRolePermissions(oldRole).label + '" to "' + getRolePermissions(nextRole).label + '"'
        );
        saveLocalDb(db);
        return Promise.resolve({ ok: true, user: sanitizeAdminRow(targetUser) });
      }

      if (act === 'set_status' || act === 'deactivate' || act === 'activate') {
        var nextActive = act === 'activate' ? true : (act === 'deactivate' ? false : !!tp.active);
        targetUser.active = nextActive;
        recordAdminAudit(
          db,
          nextActive ? 'user_activated' : 'user_deactivated',
          callerEmail,
          targetUser.email,
          (nextActive ? 'Reactivated' : 'Deactivated') + ' account for ' + targetUser.email
        );
        saveLocalDb(db);
        return Promise.resolve({ ok: true, user: sanitizeAdminRow(targetUser) });
      }

      if (act === 'reset_password') {
        var resetTempPw = String(tp.password || '').trim() || generateSecureTemporaryPassword();
        var resetValid = validateStrongPassword(resetTempPw, targetUser.email);
        if (!resetValid.ok) {
          return Promise.resolve({ ok: false, code: 'weak_password', error: resetValid.error });
        }
        targetUser.passwordDigest = hashAdminCredential(targetUser.email, resetTempPw);
        targetUser.mustChangePassword = true;
        targetUser.isProvisioned = true;
        recordAdminAudit(
          db,
          'password_reset_required',
          callerEmail,
          targetUser.email,
          'Issued temporary password reset for ' + targetUser.email + ' (mandatory password change required on next login)'
        );
        saveLocalDb(db);
        return Promise.resolve({
          ok: true,
          user: sanitizeAdminRow(targetUser),
          temporaryPassword: resetTempPw,
          mustChangePassword: true
        });
      }

      if (act === 'remove') {
        if (session && session.user && (session.user.id === targetUser.userId || String(session.user.email || '').toLowerCase() === targetUser.email)) {
          return Promise.resolve({ ok: false, code: 'self_removal', error: 'You cannot remove your own administrator account.' });
        }
        var removedEmail = targetUser.email;
        var removedRole = targetUser.role;
        db.admins = (db.admins || []).filter(function (a) { return a.userId !== targetUser.userId && a.email !== removedEmail; });
        recordAdminAudit(
          db,
          'user_removed',
          callerEmail,
          removedEmail,
          'Removed user ' + removedEmail + ' (' + getRolePermissions(removedRole).label + ') from the administrative roster'
        );
        saveLocalDb(db);
        return Promise.resolve({ ok: true, removedEmail: removedEmail });
      }

      return Promise.resolve({ ok: false, error: 'Unknown team action.' });
    }
    if (name === 'api_admin_catalogue') {
      var catsWithProds = db.categories.map(function (c) {
        return Object.assign({}, c, {
          products: db.products.filter(function (p) { return p.category === c.slug; })
        });
      });
      return Promise.resolve({
        ok: true,
        categories: catsWithProds,
        products: db.products,
        classes: db.classes,
        options: db.options,
        settings: db.settings
      });
    }
    if (name === 'api_admin_dashboard') {
      var days = Number(args.p_days) || 7;
      var series = [];
      for (var i = days - 1; i >= 0; i--) {
        var dObj = new Date(Date.now() - i * 86400000);
        var dStr = dObj.toISOString().slice(0, 10);
        var lbl = dObj.toLocaleDateString('en-GB', { weekday: 'short' });
        series.push({ date: dStr, label: lbl, orders: 0, units: 0, revenue: 0, newCustomers: 0 });
      }
      var verifiedOrders = db.orders.filter(function (o) { return o.payment_status === 'payment_verified'; });
      var totalRev = verifiedOrders.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);
      var classRev = verifiedOrders.filter(function (o) { return o.kind === 'class'; }).reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);
      return Promise.resolve({
        ok: true,
        window: { days: days },
        paymentConfigured: !!(cfg.momo || cfg.bank),
        salesTotal: totalRev,
        stats: {
          toConfirm: db.orders.filter(function (o) { return o.order_status === 'submitted'; }).length,
          proofsToReview: db.orders.filter(function (o) { return o.payment_status === 'payment_submitted'; }).length,
          awaitingPayment: db.orders.filter(function (o) { return o.payment_status === 'awaiting_payment'; }).length,
          newToday: db.orders.length
        },
        kpis: {
          revenue: { value: totalRev, previous: 0, pct: null },
          orders: { value: db.orders.length, previous: 0, pct: null },
          units: { value: db.orders.length, previous: 0, pct: null },
          newCustomers: { value: db.orders.length, previous: 0, pct: null }
        },
        series: series,
        categories: [],
        attention: db.orders.filter(function (o) { return o.order_status === 'submitted' || o.payment_status === 'payment_submitted'; }),
        activity: db.activity.slice(0, 10),
        topProducts: [],
        classes: {
          bookings: db.orders.filter(function (o) { return o.kind === 'class'; }).length,
          revenue: classRev,
          tracks: { bread: 0, pastry: 0 },
          published: db.classes.filter(function (c) { return c.published !== false; }).length
        },
        customers: { total: db.orders.length, repeat: 0, top: [] },
        channels: {
          momo: !!cfg.momo,
          bank: !!cfg.bank,
          cashDelivery: !!cfg.cash.delivery,
          cashPickup: !!cfg.cash.pickup,
          threshold: cfg.advance_threshold
        },
        catalogue: {
          productsPublished: db.products.filter(function (p) { return p.published !== false; }).length,
          productsHidden: db.products.filter(function (p) { return p.published === false; }).length,
          quoteOnly: db.products.filter(function (p) { return p.price === null; }).length,
          categories: db.categories.filter(function (c) { return c.published !== false; }).length,
          classesPublished: db.classes.filter(function (c) { return c.published !== false; }).length
        }
      });
    }
    if (name === 'api_admin_notifications') {
      return Promise.resolve({ ok: true, notifications: db.notifications || [] });
    }
    if (name === 'api_admin_orders') {
      var list = db.orders.slice();
      if (args.p_kind) list = list.filter(function (o) { return o.kind === args.p_kind; });
      if (args.p_status) list = list.filter(function (o) { return o.order_status === args.p_status; });
      if (args.p_payment) list = list.filter(function (o) { return o.payment_status === args.p_payment; });
      if (args.p_q) {
        var ql = String(args.p_q).toLowerCase();
        list = list.filter(function (o) {
          return o.ref.toLowerCase().indexOf(ql) !== -1 ||
                 String(o.customer_name || '').toLowerCase().indexOf(ql) !== -1 ||
                 String(o.phone || '').toLowerCase().indexOf(ql) !== -1;
        });
      }
      return Promise.resolve({ ok: true, orders: list });
    }
    if (name === 'api_admin_order') {
      var ao = db.orders.filter(function (o) { return o.ref === args.p_ref; })[0];
      if (!ao) return Promise.resolve({ ok: false, error: 'Order not found.' });
      return Promise.resolve({ ok: true, order: ao });
    }
    if (name === 'api_admin_verify') {
      var vo = db.orders.filter(function (o) { return o.ref === args.p_ref; })[0];
      if (!vo) return Promise.resolve({ ok: false, error: 'Order not found.' });
      var actVerify = String(args.p_action || '').trim().toLowerCase();
      var noteVerify = String(args.p_note || '').trim().slice(0, 300);
      var admActor = (session && session.user && session.user.email) || 'Baker';
      /* verified_by / reviewed_by hold the administrator's user id (a UUID),
         matching the SQL columns -- not the e-mail used in human-readable events. */
      var admActorId = (session && session.user && session.user.id) || null;
      var vNow = new Date().toISOString();
      vo.events = vo.events || [];
      if (actVerify === 'confirm') {
        vo.paymentStatus = 'payment_verified';
        vo.payment_status = 'payment_verified';
        vo.proofLocked = true;
        vo.verifiedAt = vNow;
        vo.verifiedBy = admActorId;
        if (Array.isArray(vo.paymentSubmissions) && vo.paymentSubmissions.length) {
          var subVer = vo.paymentSubmissions[vo.paymentSubmissions.length - 1];
          subVer.status = 'verified';
          subVer.verifiedAt = vNow;
          subVer.reviewedAt = vNow;
          subVer.reviewedBy = admActorId;
        }
        var payRowVer = (db.payments || []).filter(function (py) { return py.orderRef === vo.ref; })[0];
        if (payRowVer) {
          payRowVer.verificationStatus = 'payment_verified';
          payRowVer.verifiedAt = vNow;
          payRowVer.verifiedBy = admActorId;
          payRowVer.updatedAt = vNow;
        }
        var cbRowVer = (db.classBookings || []).filter(function (cb) { return cb.bookingRef === vo.ref; })[0];
        if (cbRowVer) {
          cbRowVer.paymentStatus = 'payment_verified';
          cbRowVer.updatedAt = vNow;
        }
        vo.events.unshift({
          kind: 'payment',
          message: 'Payment verified and confirmed by baker' + (noteVerify ? ' (' + noteVerify + ')' : ''),
          at: vNow,
          actor: admActor
        });
        db.activity.unshift({
          kind: 'payment',
          order_ref: vo.ref,
          message: 'Payment verified for ' + vo.ref,
          at: vNow,
          actor: admActor
        });
      } else if (actVerify === 'reject' || actVerify === 'allow_resubmit') {
        if (noteVerify.length < 3) {
          return Promise.resolve({
            ok: false,
            code: 'note_required',
            error: 'Please enter a short reason explaining why the payment proof was rejected so the customer knows what to correct.'
          });
        }
        if (vo.paymentStatus === 'payment_verified' || vo.payment_status === 'payment_verified') {
          return Promise.resolve({
            ok: false,
            code: 'already_verified',
            error: 'Verified payments are permanently locked and cannot be rejected.'
          });
        }
        vo.paymentStatus = 'payment_rejected';
        vo.payment_status = 'payment_rejected';
        vo.proofLocked = false;
        vo.rejectReason = noteVerify;
        if (Array.isArray(vo.paymentSubmissions) && vo.paymentSubmissions.length) {
          vo.paymentSubmissions[vo.paymentSubmissions.length - 1].status = 'rejected';
          vo.paymentSubmissions[vo.paymentSubmissions.length - 1].rejectReason = noteVerify;
        }
        var payRowRej = (db.payments || []).filter(function (py) { return py.orderRef === vo.ref; })[0];
        if (payRowRej) {
          payRowRej.verificationStatus = 'payment_rejected';
          payRowRej.rejectReason = noteVerify;
          payRowRej.updatedAt = vNow;
        }
        var cbRowRej = (db.classBookings || []).filter(function (cb) { return cb.bookingRef === vo.ref; })[0];
        if (cbRowRej) {
          cbRowRej.paymentStatus = 'payment_rejected';
          cbRowRej.updatedAt = vNow;
        }
        vo.events.unshift({
          kind: 'payment',
          message: 'Payment proof rejected (resubmission unlocked): ' + noteVerify,
          at: vNow,
          actor: admActor
        });
        db.activity.unshift({
          kind: 'payment',
          order_ref: vo.ref,
          message: 'Payment proof rejected for ' + vo.ref,
          at: vNow,
          actor: admActor
        });
      } else {
        return Promise.resolve({ ok: false, error: 'Invalid verification action.' });
      }
      saveLocalDb(db);
      return Promise.resolve({ ok: true, order: vo });
    }
    if (name === 'api_admin_update_order') {
      var uo = db.orders.filter(function (o) { return o.ref === args.p_ref; })[0];
      if (!uo) return Promise.resolve({ ok: false, error: 'Order not found.' });
      var patch = args.p_patch || {};
      var nextStatus = String(patch.orderStatus || patch.order_status || '').trim().toLowerCase();
      if (nextStatus) {
        var allowedStatuses = ['submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled'];
        if (allowedStatuses.indexOf(nextStatus) === -1) {
          return Promise.resolve({
            ok: false,
            code: 'invalid_status',
            error: 'Invalid order status value: ' + nextStatus
          });
        }
        var curStatus = String(uo.orderStatus || uo.order_status || 'submitted').toLowerCase();
        if ((curStatus === 'cancelled' && nextStatus !== 'cancelled') ||
            (curStatus === 'completed' && nextStatus !== 'completed')) {
          return Promise.resolve({
            ok: false,
            code: 'invalid_status_transition',
            error: 'Orders that are already ' + curStatus + ' cannot transition to ' + nextStatus + '.'
          });
        }
        /* Enforce Special Order Threshold (> GH₵ 700.00 / > cfg.advance_threshold) and advance payment verification rule */
        var uoPayStatus = String(uo.paymentStatus || uo.payment_status || 'awaiting_payment');
        var uoPayMethod = String(uo.paymentMethod || uo.payment_method || '');
        var uoTotal = Number(uo.total) || 0;
        var isAboveThreshold = uoTotal > cfg.advance_threshold || uo.advanceRequired === true || uo.advance_required === true;
        var isAdvanceMethod = (uoPayMethod === 'momo' || uoPayMethod === 'bank_transfer');
        if (['confirmed', 'in_preparation', 'ready', 'completed'].indexOf(nextStatus) !== -1 &&
            (isAboveThreshold || isAdvanceMethod) &&
            uoPayStatus !== 'payment_verified') {
          return Promise.resolve({
            ok: false,
            code: 'payment_verification_required',
            error: isAboveThreshold
              ? 'Orders strictly above GH\u20B5 ' + (cfg.advance_threshold / 100).toFixed(2) + ' require verified payment before they can be confirmed or prepared.'
              : 'Advance payment must be verified before this order can be confirmed or prepared.'
          });
        }
        uo.orderStatus = nextStatus;
        uo.order_status = nextStatus;
        uo.events = uo.events || [];
        uo.events.unshift({
          kind: 'status',
          message: 'Order status updated to ' + nextStatus,
          at: new Date().toISOString(),
          actor: (session && session.user && session.user.email) || 'Baker'
        });
        var cbUpd = (db.classBookings || []).filter(function (cb) { return cb.bookingRef === uo.ref; })[0];
        if (cbUpd) {
          cbUpd.bookingStatus = nextStatus;
          cbUpd.updatedAt = new Date().toISOString();
        }
      }
      saveLocalDb(db);
      return Promise.resolve({ ok: true, order: uo });
    }
    if (name === 'api_admin_settings') {
      var sp = args.p_payload || {};
      Object.keys(sp).forEach(function (k) {
        if (k === 'momo_verified' || k === 'bank_verified' || k === 'cash_delivery_enabled' || k === 'cash_pickup_enabled' || k === 'auto_confirm_on_verified_payment') {
          var bVal = sp[k] === true || sp[k] === '1' || sp[k] === 1;
          if (k === 'auto_confirm_on_verified_payment') db.settings.auto_confirm = bVal;
          else db.settings[k] = bVal;
        } else if (k === 'bundle_two_pct' || k === 'bundle_three_pct') {
          db.settings[k] = Number(sp[k]);
        } else {
          db.settings[k] = sp[k];
        }
      });
      if (db.settings.momo_verified && (!db.settings.momo_name || !db.settings.momo_number)) {
        db.settings.momo_verified = false;
      }
      if (db.settings.bank_verified && (!db.settings.bank_name || !db.settings.bank_account_name || !db.settings.bank_account_number)) {
        db.settings.bank_verified = false;
      }
      saveLocalDb(db);
      return Promise.resolve({ ok: true, config: buildPublicConfig(db.settings), settings: db.settings });
    }
    if (name === 'api_admin_class') {
      var cm = args.p_method;
      var cp = args.p_payload || {};
      if (cm === 'DELETE') {
        db.classes = db.classes.filter(function (c) { return c.slug !== cp.slug; });
      } else if (cm === 'POST') {
        var newSlug = String(cp.name || 'course').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        db.classes.push({
          slug: newSlug,
          track: cp.track || 'bread',
          level: Number(cp.level) || 1,
          levelLabel: cp.levelLabel || 'Beginner',
          name: cp.name || 'New Course',
          summary: cp.summary || '',
          description: cp.description || '',
          fee: Number(cp.fee) || 150000,
          hours: cp.hours || '1 week',
          schedule: 'Monday to Friday',
          recipes: [],
          skills: [],
          provided: [],
          bring: [],
          prereq: '',
          published: cp.published !== false
        });
      } else {
        db.classes.forEach(function (c) {
          if (c.slug === cp.slug) {
            if (cp.fee !== undefined) c.fee = Number(cp.fee);
            if (cp.hours !== undefined) c.hours = cp.hours;
            if (cp.published !== undefined) c.published = !!cp.published;
          }
        });
      }
      saveLocalDb(db);
      return Promise.resolve({ ok: true });
    }
    if (name === 'api_admin_product') {
      var pm2 = args.p_method;
      var pp = args.p_payload || {};
      if (pm2 === 'DELETE') {
        db.products = db.products.filter(function (p) { return p.sku !== pp.sku; });
      } else if (pm2 === 'POST') {
        var sku = String(pp.name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        var newCat = pp.category || 'milky-doughnuts';
        var newPrep = (pp.prepDays !== undefined && pp.prepDays !== null && pp.prepDays !== '')
          ? Math.max(0, Math.min(30, Math.round(Number(pp.prepDays) || 0)))
          : defaultPrepDaysForSku(sku, newCat);
        db.products.push({
          sku: sku,
          name: pp.name || 'New item',
          category: newCat,
          price: pp.price === null ? null : Number(pp.price),
          meta: pp.meta || '',
          description: pp.description || '',
          image: pp.image || '',
          prepDays: newPrep,
          published: true
        });
      } else {
        db.products.forEach(function (p) {
          if (p.sku === pp.sku) {
            Object.keys(pp).forEach(function (k) {
              if (k === 'prepDays') {
                p.prepDays = Math.max(0, Math.min(30, Math.round(Number(pp.prepDays) || 0)));
              } else if (k !== 'sku') {
                p[k] = pp[k];
              }
            });
          }
        });
      }
      saveLocalDb(db);
      return Promise.resolve({ ok: true });
    }
    if (name === 'api_admin_category') {
      var catM = args.p_method;
      var catP = args.p_payload || {};
      if (catM === 'DELETE') {
        db.categories = db.categories.filter(function (c) { return c.slug !== catP.slug; });
      } else if (catM === 'POST') {
        var cSlug = String(catP.name || 'category').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        db.categories.push({ slug: cSlug, name: catP.name || 'Category', intro: catP.intro || '', published: true });
      } else {
        db.categories.forEach(function (c) {
          if (c.slug === catP.slug && catP.published !== undefined) c.published = !!catP.published;
        });
      }
      saveLocalDb(db);
      return Promise.resolve({ ok: true });
    }
    if (name === 'api_admin_option') {
      var op = args.p_payload || {};
      var grp = db.options[op.kind] || [];
      grp.forEach(function (item) {
        if (item.key === op.key) {
          if (op.charges !== undefined) item.charges = op.charges;
          if (op.extra !== undefined) item.extra = op.extra;
          if (op.price !== undefined) item.price = op.price;
        }
      });
      saveLocalDb(db);
      return Promise.resolve({ ok: true });
    }
    if (name === 'api_admin_discounts') {
      var dp = args.p_payload || {};
      if (dp.bundle_two_pct !== undefined) {
        var b2 = Math.round(Number(dp.bundle_two_pct));
        if (!isFinite(b2) || b2 < 0 || b2 > 90) {
          return Promise.resolve({ ok: false, error: 'Two-class discount percentage must be between 0% and 90%.' });
        }
        db.settings.bundle_two_pct = b2;
      }
      if (dp.bundle_three_pct !== undefined) {
        var b3 = Math.round(Number(dp.bundle_three_pct));
        if (!isFinite(b3) || b3 < 0 || b3 > 90) {
          return Promise.resolve({ ok: false, error: 'Three-or-more class discount percentage must be between 0% and 90%.' });
        }
        db.settings.bundle_three_pct = b3;
      }
      if (dp.clearAll) {
        db.products.forEach(function (p) { p.discountPct = 0; });
      }
      if (dp.category !== undefined && dp.discountPct !== undefined) {
        var catPct = Math.max(0, Math.min(90, Math.round(Number(dp.discountPct) || 0)));
        db.products.forEach(function (p) {
          if (dp.category === 'all' || p.category === dp.category) {
            p.discountPct = catPct;
          }
        });
      }
      if (dp.sku !== undefined && dp.discountPct !== undefined) {
        var skuPct = Math.max(0, Math.min(90, Math.round(Number(dp.discountPct) || 0)));
        db.products.forEach(function (p) {
          if (p.sku === dp.sku) p.discountPct = skuPct;
        });
      }
      var prodPatch = dp.products || dp.product_discounts;
      if (prodPatch && typeof prodPatch === 'object') {
        if (Array.isArray(prodPatch)) {
          prodPatch.forEach(function (row) {
            if (!row || !row.sku) return;
            var pct = Math.max(0, Math.min(90, Math.round(Number(row.discountPct) || 0)));
            db.products.forEach(function (p) {
              if (p.sku === row.sku) p.discountPct = pct;
            });
          });
        } else {
          Object.keys(prodPatch).forEach(function (k) {
            var pct = Math.max(0, Math.min(90, Math.round(Number(prodPatch[k]) || 0)));
            db.products.forEach(function (p) {
              if (p.sku === k) p.discountPct = pct;
            });
          });
        }
      }
      saveLocalDb(db);
      return Promise.resolve({
        ok: true,
        config: buildPublicConfig(db.settings, db),
        settings: db.settings,
        bundle: {
          bundle_two_pct: Number(db.settings.bundle_two_pct) || 0,
          bundle_three_pct: Number(db.settings.bundle_three_pct) || 0
        },
        products: db.products,
        classes: db.classes,
        categories: db.categories
      });
    }
    return Promise.resolve({ ok: false, error: 'Unknown RPC: ' + name });
  }


  var ALLOWED_ADMIN_ROLES = {
    super_admin: true,
    administrator: true,
    manager: true,
    viewer: true,
    admin: true,
    owner: true,
    baker: true
  };

  function isSessionValid(s) {
    if (!s || !s.access_token || s.authVersion !== 2) return false;
    if (typeof s.expires_at === 'number' && isFinite(s.expires_at)) {
      var nowSec = Math.floor(Date.now() / 1000);
      if (s.expires_at <= nowSec) return false;
    }
    return true;
  }

  function getVerifiedLocalAdmin(db, includeDeactivated) {
    if (!isSessionValid(session)) return null;
    var u = session && session.user;
    if (!u || !u.email) return null;
    var uRole = String(u.role || '').trim().toLowerCase();
    if (uRole && !ALLOWED_ADMIN_ROLES[uRole] && uRole !== 'authenticated') {
      return null;
    }
    var sEmail = String(u.email || '').trim().toLowerCase();
    var roster = (db && Array.isArray(db.admins)) ? db.admins : [];
    var matched = roster.filter(function (a) {
      var aEmail = String(a && a.email || '').trim().toLowerCase();
      var aRole = String((a && a.role) || 'administrator').trim().toLowerCase();
      return aEmail === sEmail && !!ALLOWED_ADMIN_ROLES[aRole];
    })[0];
    if (!matched) return null;
    if (!includeDeactivated && matched.active === false) return null;
    return matched;
  }

  function requireAdmin(db, requiredPermission) {
    var database = db || loadLocalDb();
    var rawMatch = getVerifiedLocalAdmin(database, true);
    if (!rawMatch) {
      return {
        ok: false,
        auth: true,
        code: 'unauthorised',
        error: 'Unauthorised: administrator role required to access dashboard resources.'
      };
    }
    if (rawMatch.active === false) {
      return {
        ok: false,
        auth: true,
        code: 'account_deactivated',
        error: 'This administrator account has been deactivated by the Super Administrator.'
      };
    }
    if (rawMatch.mustChangePassword) {
      return {
        ok: false,
        auth: false,
        code: 'password_change_required',
        mustChangePassword: true,
        error: 'Security requirement: you must change your temporary password before accessing the dashboard.'
      };
    }
    if (requiredPermission) {
      var normRole = normalizeAdminRole(rawMatch.role, rawMatch.email);
      var perms = getRolePermissions(normRole);
      if (!perms || !perms[requiredPermission]) {
        return {
          ok: false,
          auth: false,
          code: 'forbidden',
          error: 'Insufficient permissions: your role (' + (perms ? perms.label : normRole) + ') is not authorized to perform this action.'
        };
      }
    }
    return null;
  }

  /* ---------- authenticated customer identity (never trusts browser-supplied IDs) ---------- */

  /**
   * Resolve the signed-in actor for order, booking and payment operations.
   * The user id and email always come from the verified session, never from a
   * request body, query string or hidden form field.
   *
   * opts.includeUnverified — when false, unverified e-mail addresses are rejected.
   */
  function getAuthenticatedOrderActor(db, opts) {
    opts = (typeof opts === 'object' && opts !== null) ? opts : {};
    if (!isSessionValid(session)) return null;
    var u = session.user || {};
    var uid = String(u.id || '').trim();
    var email = String(u.email || '').trim().toLowerCase();
    if (!uid || !email) return null;

    var database = db || { customers: [] };
    var adminRow = getVerifiedLocalAdmin(database, true);
    var rows = Array.isArray(database.customers) ? database.customers : [];
    var row = rows.filter(function (c) {
      if (!c) return false;
      if (c.userId === uid) return true;
      return !!email && String(c.email || '').trim().toLowerCase() === email;
    })[0] || null;

    var verified;
    if (adminRow) {
      verified = true;
    } else if (row) {
      verified = row.emailVerified !== false;
    } else {
      verified = u.emailVerified === true;
    }

    var actor = {
      userId: uid,
      email: email,
      fullName: String((row && row.fullName) || u.fullName || u.name || '').trim(),
      phone: String((row && row.phone) || u.phone || '').trim(),
      emailVerified: verified,
      createdAt: (row && row.createdAt) || new Date().toISOString(),
      isAdmin: !!adminRow
    };

    if (opts.includeUnverified === false && !verified && !actor.isAdmin) return null;
    return actor;
  }

  MB.currentActor = function () { return getAuthenticatedOrderActor(loadLocalDb(), { includeUnverified: true }); };

  /* ---------- new-order alert (WhatsApp) ----------
     Guests place orders without a session, so the baker has to be told that an
     order arrived. The message is built here identically to the Edge Function's
     version so the wa.me fallback and the automatic send read the same. */

  var PAY_LABELS = {
    awaiting_payment: 'Awaiting Payment',
    payment_submitted: 'Proof submitted \u2014 Pending Verification',
    payment_verified: 'Payment Verified',
    payment_rejected: 'Payment Rejected',
    pay_on_collection: 'Pay on Collection',
    not_required: 'Not Required'
  };

  function prettyOrderDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return ymd ? String(ymd) : 'Not specified';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d.getTime())) return String(ymd);
    try {
      return d.toLocaleDateString('en-GB', {
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
      });
    } catch (e) { return String(ymd); }
  }

  function summariseOrderItems(items) {
    if (!items || !items.length) return 'No line items recorded';
    var parts = items.slice(0, 8).map(function (raw) {
      var qty = Number(raw && raw.qty) || 1;
      var name = String((raw && (raw.name || raw.itemName || raw.sku)) || 'Item').trim();
      var meta = String((raw && (raw.meta || raw.itemMeta)) || '').trim();
      return qty + ' \u00d7 ' + name + (meta ? ' (' + meta + ')' : '');
    });
    if (items.length > 8) parts.push('+' + (items.length - 8) + ' more');
    return parts.join('; ');
  }

  var METHOD_LABELS = {
    momo: 'Mobile Money',
    bank_transfer: 'Bank transfer',
    cash_on_pickup: 'Cash on pickup',
    cash_on_delivery: 'Cash on delivery'
  };

  /** 250000 (pesewas) -> "GH\u20b52,500.00" */
  function alertMoney(pesewas) {
    var n = Number(pesewas);
    if (!isFinite(n)) return '\u2014';
    try {
      return 'GH\u20b5' + (n / 100).toLocaleString('en-GH', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });
    } catch (e) {
      return 'GH\u20b5' + (n / 100).toFixed(2);
    }
  }

  function alertFulfilment(order) {
    var f = String(order.fulfilment || '');
    if (f === 'delivery') {
      var addr = String(order.address || '').trim();
      return addr ? 'Delivery to ' + addr : 'Delivery (address not recorded)';
    }
    return 'Collection from the kitchen';
  }

  /** The exact alert text the baker receives. */
  MB.orderAlertMessage = function (order) {
    order = order || {};
    var payment = PAY_LABELS[String(order.paymentStatus || order.payment_status || '')] || 'Pending Verification';
    var method = METHOD_LABELS[String(order.paymentMethod || order.payment_method || '')]
      || String(order.paymentMethod || order.payment_method || '\u2014');
    var lines = [
      '\ud83c\udf70 *New Order | Mystery Bakebite*',
      '',
      '*Reference:* ' + (order.ref || '\u2014'),
      '*Customer:* ' + (order.customerName || (order.customer && order.customer.name) || order.customer_name || 'Not provided'),
      '*Phone:* ' + (order.phone || (order.customer && order.customer.phone) || 'Not provided'),
      '*Items:* ' + summariseOrderItems(order.items),
      '*Total:* ' + alertMoney(order.total),
      '*Date needed:* ' + prettyOrderDate(order.eventDate || order.event_date),
      '*' + alertFulfilment(order) + '*',
      '*Payment method:* ' + method,
      '*Payment status:* ' + payment,
      '',
      'Log in to the admin dashboard to review, verify payment and approve.'
    ];
    if (order.notes) lines.push('', '*Notes:* ' + String(order.notes).slice(0, 300));
    return lines.join('\n');
  };

  /** One-tap fallback link, used when the automatic send is unavailable. */
  MB.whatsappOrderLink = function (order) {
    var to = '';
    /* Priority: the alert number from the business profile (settings), then the
       legacy MB_CONFIG.bakerWhatsApp override, then the public WhatsApp line. */
    if (MB.contact && typeof MB.contact.alertsNumber === 'function') {
      to = MB.contact.alertsNumber();
    }
    if (!to) {
      var cfg = window.MB_CONFIG || {};
      to = String(cfg.bakerWhatsApp || '').replace(/\D/g, '');
    }
    if (!to && MB.contact && typeof MB.contact.get === 'function') {
      to = String((MB.contact.get() || {}).whatsapp || '').replace(/\D/g, '');
    }
    if (!to) return '';
    return 'https://wa.me/' + to + '?text=' + encodeURIComponent(MB.orderAlertMessage(order));
  };

  /**
   * Ask the notify-order Edge Function to WhatsApp the baker.
   * Fire-and-forget: an order must never fail because a notification did.
   * The order token proves the caller owns the order.
   */
  MB.notifyBaker = function (ref, token, order) {
    var payload = { ref: String(ref || '').trim(), token: String(token || '').trim() };
    if (MB.localMode || !MB.remoteConfigured) {
      return Promise.resolve({ ok: true, local: true, message: MB.orderAlertMessage(order) });
    }
    return call('/functions/v1/notify-order', { method: 'POST', body: payload })
      .then(function (res) { return res && typeof res === 'object' ? res : { ok: false }; })
      .catch(function () { return { ok: false, error: 'network' }; });
  };

  /* ---------- session storage ---------- */

  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!isSessionValid(s)) {
        localStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch (e) { return null; }
  }

  function writeSession(s, remember) {
    var raw = JSON.stringify(s);
    try {
      if (remember === false) {
        sessionStorage.setItem(SESSION_KEY, raw);
        localStorage.removeItem(SESSION_KEY);
      } else {
        localStorage.setItem(SESSION_KEY, raw);
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch (e) { /* private mode: the session simply will not survive a reload */ }
  }

  function notifyAuthChange() {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        var isAdminNow = MB.isAdmin ? MB.isAdmin() : false;
        var currentRole = MB.adminRole ? MB.adminRole() : null;
        window.dispatchEvent(new CustomEvent('mb-auth-changed', {
          detail: {
            signedIn: isSessionValid(session),
            isAdmin: isAdminNow,
            isSuperAdmin: currentRole === 'super_admin',
            mustChangePassword: MB.mustChangePassword ? MB.mustChangePassword() : false,
            role: isAdminNow ? (currentRole || 'administrator') : (session && session.user && session.user.role ? session.user.role : null),
            user: session ? session.user : null
          }
        }));
      }
    } catch (e) { }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) { }
  }

  var session = readSession();

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', function (e) {
      if (e && e.key === SESSION_KEY) {
        session = readSession();
        notifyAuthChange();
      }
    });
  }

  MB.session = function () { return isSessionValid(session) ? session : null; };
  MB.user = function () { return isSessionValid(session) ? session.user : null; };
  MB.isSignedIn = function () { return isSessionValid(session); };
  MB.isAdmin = function () {
    if (!isSessionValid(session)) return false;
    if (MB.localMode) {
      var adm = getVerifiedLocalAdmin(loadLocalDb());
      return !!(adm && adm.active !== false);
    }
    return !!(session && session.user && (session.user.isAdminVerified === true || ALLOWED_ADMIN_ROLES[String(session.user.role || '').toLowerCase()]));
  };
  MB.adminRole = function () {
    if (!MB.isAdmin()) return null;
    if (MB.localMode) {
      var adm = getVerifiedLocalAdmin(loadLocalDb());
      return adm ? normalizeAdminRole(adm.role, adm.email) : null;
    }
    var u = session && session.user;
    return u ? normalizeAdminRole(u.role, u.email) : null;
  };
  MB.isSuperAdmin = function () {
    if (!MB.isAdmin()) return false;
    var u = session && session.user;
    return MB.adminRole() === 'super_admin' && !!(u && String(u.email || '').trim().toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL);
  };
  MB.mustChangePassword = function () {
    if (!isSessionValid(session)) return false;
    if (MB.localMode) {
      var adm = getVerifiedLocalAdmin(loadLocalDb());
      return !!(adm && adm.mustChangePassword);
    }
    return !!(session && session.user && session.user.mustChangePassword);
  };
  MB.getPermissions = function () {
    var r = MB.adminRole();
    return r ? getRolePermissions(r) : null;
  };
  MB.verifyAdminSession = function () {
    if (!isSessionValid(session)) {
      return Promise.resolve({
        ok: true,
        signedIn: false,
        isAdmin: false,
        isSuperAdmin: false,
        mustChangePassword: false,
        email: '',
        role: null,
        permissions: null
      });
    }
    return MB.rpc('api_admin_whoami').then(function (d) {
      var verified = !!(d && d.ok && d.isAdmin);
      if (session && session.user) {
        session.user.isAdminVerified = verified;
        if (d && d.role) session.user.role = d.role;
        if (d && typeof d.mustChangePassword === 'boolean') {
          session.user.mustChangePassword = d.mustChangePassword;
        }
      }
      return {
        ok: true,
        signedIn: !!(d && (d.signedIn !== undefined ? d.signedIn : isSessionValid(session))),
        isAdmin: verified,
        isSuperAdmin: !!(verified && d && d.isSuperAdmin),
        isPrimarySuperAdmin: !!(verified && d && d.isPrimarySuperAdmin),
        mustChangePassword: !!(verified && d && d.mustChangePassword),
        deactivated: !!(d && d.deactivated),
        setupRequired: !!(d && d.setupRequired),
        email: (d && d.email) || (session && session.user && session.user.email) || '',
        name: (d && d.name) || (session && session.user && session.user.name) || '',
        role: verified ? ((d && d.role) || 'administrator') : ((d && d.role) || null),
        permissions: verified ? ((d && d.permissions) || getRolePermissions((d && d.role) || 'administrator')) : null
      };
    }).catch(function () {
      return {
        ok: false,
        signedIn: isSessionValid(session),
        isAdmin: false,
        isSuperAdmin: false,
        mustChangePassword: false,
        email: '',
        role: null,
        permissions: null
      };
    });
  };

  /** Inspect whether the primary Super Administrator (mysterybakebites@gmail.com) has been provisioned. */
  MB.getSuperAdminSetupStatus = function () {
    var db = loadLocalDb();
    var primary = (db.admins || []).filter(function (a) {
      return String(a && a.email || '').trim().toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL;
    })[0];
    return {
      ok: true,
      email: PRIMARY_SUPER_ADMIN_EMAIL,
      isProvisioned: !!(primary && primary.isProvisioned && primary.passwordDigest),
      mustChangePassword: !!(primary && primary.mustChangePassword),
      remoteConfigured: MB.remoteConfigured
    };
  };

  /**
   * First-time provisioning of the primary Super Administrator (mysterybakebites@gmail.com).
   * Never uses hardcoded passwords: generates a one-time cryptographic temporary password
   * (or accepts an initial setup password) and enforces a mandatory password change on first login.
   */
  MB.provisionSuperAdmin = function (email, customTemporaryPassword) {
    var em = String(email || PRIMARY_SUPER_ADMIN_EMAIL).trim().toLowerCase();
    if (em !== PRIMARY_SUPER_ADMIN_EMAIL) {
      return Promise.resolve({
        ok: false,
        code: 'super_admin_exclusive',
        error: 'Initial Super Administrator provisioning is strictly reserved for ' + PRIMARY_SUPER_ADMIN_EMAIL + '.'
      });
    }
    var db = loadLocalDb();
    var primary = (db.admins || []).filter(function (a) {
      return String(a && a.email || '').trim().toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL;
    })[0];
    if (primary && primary.isProvisioned && primary.passwordDigest) {
      return Promise.resolve({
        ok: false,
        code: 'already_provisioned',
        error: 'The Super Administrator account (' + PRIMARY_SUPER_ADMIN_EMAIL + ') has already been provisioned. Please sign in or use password recovery.'
      });
    }
    var tempPw = String(customTemporaryPassword || '').trim() || generateSecureTemporaryPassword();
    var vCheck = validateStrongPassword(tempPw, PRIMARY_SUPER_ADMIN_EMAIL);
    if (!vCheck.ok) {
      return Promise.resolve({ ok: false, code: 'weak_password', error: vCheck.error });
    }
    if (!primary) {
      primary = defaultAdmins()[0];
      db.admins.unshift(primary);
    }
    primary.role = 'super_admin';
    primary.isPrimarySuperAdmin = true;
    primary.active = true;
    primary.isProvisioned = true;
    primary.mustChangePassword = true;
    primary.passwordDigest = hashAdminCredential(PRIMARY_SUPER_ADMIN_EMAIL, tempPw);
    primary.provisionedAt = new Date().toISOString();
    recordAdminAudit(
      db,
      'super_admin_provisioned',
      PRIMARY_SUPER_ADMIN_EMAIL,
      PRIMARY_SUPER_ADMIN_EMAIL,
      'Primary Super Administrator (' + PRIMARY_SUPER_ADMIN_EMAIL + ') provisioned with one-time temporary credential (mandatory first-login password change active)'
    );
    saveLocalDb(db);

    if (MB.remoteConfigured) {
      return call('/auth/v1/signup', {
        method: 'POST',
        body: {
          email: PRIMARY_SUPER_ADMIN_EMAIL,
          password: tempPw,
          data: { role: 'super_admin', must_change_password: true, is_primary_super_admin: true }
        }
      }, ANON).then(function () {
        return {
          ok: true,
          email: PRIMARY_SUPER_ADMIN_EMAIL,
          role: 'super_admin',
          temporaryPassword: tempPw,
          mustChangePassword: true
        };
      }).catch(function () {
        return {
          ok: true,
          email: PRIMARY_SUPER_ADMIN_EMAIL,
          role: 'super_admin',
          temporaryPassword: tempPw,
          mustChangePassword: true
        };
      });
    }

    return Promise.resolve({
      ok: true,
      email: PRIMARY_SUPER_ADMIN_EMAIL,
      role: 'super_admin',
      temporaryPassword: tempPw,
      mustChangePassword: true
    });
  };

  /* ---------- low level ---------- */

  function abortable() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT);
    return { signal: ctrl ? ctrl.signal : undefined, done: function () { clearTimeout(timer); } };
  }

  function failure(err) {
    /* one shape for every failure: the pages already speak {ok,error,code} */
    var code = (err && (err.hint || err.code)) || 'network';
    var message = (err && (err.message || err.error_description || err.msg)) ||
      'We could not reach the bakery database. Check your connection and try again.';
    if (/Failed to fetch|NetworkError|aborted|Load failed/i.test(message)) {
      message = 'We could not reach the bakery database. Check your connection and try again.';
      code = 'network';
    }
    if (code === 'PGRST202' || /Could not find the function/i.test(message)) {
      /* The database function is not installed yet (migrations not applied).
         Never show a raw PostgREST error to a shopper. The code is kept as
         PGRST202 so pages can still detect the not-configured state. */
      code = 'PGRST202';
      message = 'Online ordering is still being set up. Please message us on WhatsApp and we will gladly take your order.';
    }
    return { ok: false, error: message, code: code, auth: code === 'unauthorised' || code === '42501' };
  }

  function parse(res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = null; }
      }
      if (!res.ok) {
        var err = data || {};
        err.status = res.status;
        if (res.status === 401 && !err.hint) err.hint = 'unauthorised';
        throw err;
      }
      return data;
    });
  }

  function call(path, options, token) {
    var opts = options || {};
    var t = abortable();
    var headers = {
      apikey: ANON,
      Authorization: 'Bearer ' + (token || (session && session.access_token) || ANON),
      Accept: 'application/json'
    };
    var body = opts.body;
    if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(URL_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: body
    }).then(function (res) {
      t.done();
      return parse(res);
    }).catch(function (err) {
      t.done();
      throw err;
    });
  }

  /* ---------- Postgres functions ---------- */

  function rpc(name, args) {
    return call('/rest/v1/rpc/' + encodeURIComponent(name), {
      method: 'POST',
      body: args || {}
    });
  }

  /**
   * Call a database function and resolve with its JSON payload.
   * Never rejects: a rule that stopped the call comes back as
   * { ok: false, error: "...", code: "advance_required" }.
   */
  MB.rpc = function (name, args) {
    if (MB.localMode) {
      return localRpc(name, args);
    }
    return rpc(name, args).then(function (data) {
      if (data && typeof data === 'object' && data.ok === false) return data;
      return data;
    }).catch(failure);
  };

  /* ---------- authentication ---------- */

  function storeToken(data, remember) {
    var now = Math.floor(Date.now() / 1000);
    session = {
      authVersion: 2,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: now + (data.expires_in || 3600),
      user: data.user || (session && session.user) || null
    };
    writeSession(session, remember);
    notifyAuthChange();
    return session;
  }

  function tokenRequest(path, body) {
    return call(path, { method: 'POST', body: body }, ANON).then(function (data) {
      return data;
    });
  }

  /** Sign in with the email and password of an authorized administrator account. */
  MB.signIn = function (email, password, remember) {
    var em = String(email || '').trim().toLowerCase();
    var pw = String(password || '');
    if (!em || !pw) return Promise.resolve({ ok: false, error: 'Enter your email and password.' });

    var rlSign = checkRateLimit('signin', em, 5, 5 * 60 * 1000);
    if (!rlSign.allowed) {
      return Promise.resolve({ ok: false, code: 'rate_limited', error: rlSign.error });
    }

    function verifyAndStoreLocal() {
      var db = loadLocalDb();
      var account = (db.admins || []).filter(function (a) {
        return String(a.email || '').trim().toLowerCase() === em;
      })[0];
      if (!account) {
        rlSign.recordFailure();
        return { ok: false, error: 'That email and password did not match an authorized account.' };
      }
      if (account.active === false) {
        return {
          ok: false,
          code: 'account_deactivated',
          error: 'This account has been deactivated by the Super Administrator.'
        };
      }
      if (!account.isProvisioned || !account.passwordDigest) {
        return {
          ok: false,
          code: 'setup_required',
          setupRequired: true,
          email: account.email,
          error: 'The Super Administrator account has not completed initial setup yet. Use the First-Time Setup step below to generate your one-time temporary password.'
        };
      }
      var digest = hashAdminCredential(em, pw);
      if (account.passwordDigest !== digest) {
        rlSign.recordFailure();
        return { ok: false, error: 'That email and password did not match an authorized account.' };
      }
      rlSign.reset();
      var rRole = normalizeAdminRole(account.role, account.email);
      account.lastSignInAt = new Date().toISOString();
      recordAdminAudit(
        db,
        'admin_sign_in',
        account.email,
        account.email,
        'Signed in as ' + getRolePermissions(rRole).label + (account.mustChangePassword ? ' (mandatory first-login password change pending)' : '')
      );
      saveLocalDb(db);
      storeToken({
        access_token: 'mb-admin-jwt-' + sha256Hex(em + ':' + Date.now()).slice(0, 32),
        refresh_token: 'mb-admin-refresh-' + sha256Hex(account.userId + ':' + Date.now()).slice(0, 24),
        expires_in: 86400,
        user: {
          id: account.userId,
          email: account.email,
          name: account.name || '',
          role: rRole,
          isPrimarySuperAdmin: account.email === PRIMARY_SUPER_ADMIN_EMAIL,
          mustChangePassword: !!account.mustChangePassword,
          isAdminVerified: true
        }
      }, remember);
      return {
        ok: true,
        email: account.email,
        role: rRole,
        isSuperAdmin: rRole === 'super_admin' && account.email === PRIMARY_SUPER_ADMIN_EMAIL,
        mustChangePassword: !!account.mustChangePassword
      };
    }

    if (MB.localMode) {
      return Promise.resolve(verifyAndStoreLocal());
    }
    return tokenRequest('/auth/v1/token?grant_type=password', {
      email: em,
      password: pw
    }).then(function (data) {
      if (!data || !data.access_token) {
        rlSign.recordFailure();
        return { ok: false, error: 'That email and password did not match an authorized account.' };
      }
      rlSign.reset();
      storeToken(data, remember);
      return MB.rpc('api_admin_whoami').then(function (who) {
        if (!who || !who.ok || !who.isAdmin) {
          clearSession();
          session = null;
          notifyAuthChange();
          if (who && who.deactivated) {
            return { ok: false, code: 'account_deactivated', error: 'This account has been deactivated by the Super Administrator.' };
          }
          return { ok: false, code: 'unauthorised', error: 'This account is not authorized to access the administrator dashboard.' };
        }
        if (session && session.user) {
          session.user.role = who.role || 'administrator';
          session.user.mustChangePassword = !!who.mustChangePassword;
          session.user.isAdminVerified = true;
          writeSession(session, remember);
          notifyAuthChange();
        }
        return {
          ok: true,
          email: who.email || em,
          role: who.role || 'administrator',
          isSuperAdmin: !!who.isSuperAdmin,
          mustChangePassword: !!who.mustChangePassword
        };
      });
    }).catch(function (err) {
      var msg = String((err && (err.error_description || err.message)) || '');
      if (/invalid_grant|Invalid login credentials/i.test(msg)) {
        rlSign.recordFailure();
        msg = 'That email and password did not match an authorized account.';
      } else if (/Email not confirmed/i.test(msg)) {
        msg = 'That account has not been confirmed yet. Ask the Super Administrator to confirm it.';
      } else if (!msg) {
        msg = 'We could not reach the sign-in service. Check your connection and try again.';
      }
      return { ok: false, error: msg };
    });
  };

  /** Complete the mandatory first-login password change before dashboard access is granted. */
  MB.completeFirstLoginPassword = function (currentPassword, newPassword) {
    var curPw = String(currentPassword || '');
    var nextPw = String(newPassword || '');
    if (!MB.isSignedIn() || !session || !session.user) {
      return Promise.resolve({ ok: false, auth: true, code: 'unauthorised', error: 'Please sign in first.' });
    }
    var uEmail = String(session.user.email || '').trim().toLowerCase();
    if (!curPw) {
      return Promise.resolve({ ok: false, code: 'current_password_required', error: 'Enter the temporary password you used to sign in.' });
    }
    if (nextPw === curPw) {
      return Promise.resolve({ ok: false, code: 'same_password', error: 'Your new password must be different from your temporary password.' });
    }
    var pwValid = validateStrongPassword(nextPw, uEmail);
    if (!pwValid.ok) {
      return Promise.resolve({ ok: false, code: 'weak_password', error: pwValid.error });
    }
    if (MB.localMode) {
      return localRpc('api_admin_complete_first_login', {
        p_current_password: curPw,
        p_new_password: nextPw
      });
    }
    return freshToken().then(function (token) {
      return call('/auth/v1/user', {
        method: 'PUT',
        body: { password: nextPw, data: { must_change_password: false } }
      }, token);
    }).then(function () {
      return MB.rpc('api_admin_complete_first_login', {
        p_current_password: curPw,
        p_new_password: nextPw
      });
    }).then(function (res) {
      if (session && session.user) {
        session.user.mustChangePassword = false;
        var rem = true;
        try { rem = !!localStorage.getItem(SESSION_KEY); } catch (_) {}
        writeSession(session, rem);
        notifyAuthChange();
      }
      return res && res.ok !== false ? res : { ok: true, mustChangePassword: false };
    }).catch(function (err) {
      var msg = (err && (err.msg || err.message)) || 'The password could not be updated.';
      return { ok: false, error: msg };
    });
  };

  /** Request a password recovery link via Supabase Auth. */
  MB.requestPasswordReset = function (email) {
    var em = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(em)) {
      return Promise.resolve({ ok: false, error: 'Please enter a valid administrator email address.' });
    }
    var rlRec = checkRateLimit('recover', em, 4, 10 * 60 * 1000);
    if (!rlRec.allowed) {
      return Promise.resolve({ ok: false, code: 'rate_limited', error: rlRec.error });
    }
    if (MB.remoteConfigured) {
      var redirectUrl = '';
      try {
        if (typeof window !== 'undefined' && window.location) {
          redirectUrl = window.location.origin + window.location.pathname;
        }
      } catch (_) {}
      return call('/auth/v1/recover' + (redirectUrl ? '?redirect_to=' + encodeURIComponent(redirectUrl) : ''), {
        method: 'POST',
        body: { email: em }
      }, ANON).then(function () {
        return {
          ok: true,
          message: 'If ' + em + ' is registered in Supabase Auth, a password recovery link has been sent to that inbox.'
        };
      }).catch(function () {
        return {
          ok: true,
          message: 'If ' + em + ' is registered in Supabase Auth, a password recovery link has been sent to that inbox.'
        };
      });
    }
    if (em !== PRIMARY_SUPER_ADMIN_EMAIL) {
      return Promise.resolve({
        ok: true,
        message: 'Ask the Super Administrator (' + PRIMARY_SUPER_ADMIN_EMAIL + ') to issue a temporary password reset for your account in Team & Access Control.'
      });
    }
    return Promise.resolve({
      ok: true,
      message: 'Connect Supabase Auth in assets/js/config.js to receive email recovery links for ' + PRIMARY_SUPER_ADMIN_EMAIL + ', or use the Super Administrator First-Time Setup if this browser has not been provisioned.'
    });
  };

  /** Refresh the access token a minute before it expires. */
  function freshToken() {
    if (!session) return Promise.reject({ message: 'Not signed in.' });
    var now = Math.floor(Date.now() / 1000);
    if (session.expires_at - 60 > now) return Promise.resolve(session.access_token);
    if (!session.refresh_token) return Promise.reject({ message: 'Not signed in.', hint: 'unauthorised' });
    return tokenRequest('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: session.refresh_token
    }).then(function (data) {
      if (!data || !data.access_token) throw { message: 'Not signed in.', hint: 'unauthorised' };
      var remembered = true;
      try { remembered = !!localStorage.getItem(SESSION_KEY); } catch (e) { }
      storeToken(data, remembered);
      return session.access_token;
    }).catch(function (err) {
      clearSession();
      session = null;
      throw err && err.message ? err : { message: 'Not signed in.', hint: 'unauthorised' };
    });
  }

  MB.refreshSession = freshToken;

  MB.signOut = function () {
    var token = session && session.access_token;
    clearSession();
    session = null;
    notifyAuthChange();
    if (!token || MB.localMode) return Promise.resolve({ ok: true });
    /* tell the server, but never block the sign-out on it */
    return call('/auth/v1/logout', { method: 'POST' }, token)
      .then(function () { return { ok: true }; })
      .catch(function () { return { ok: true }; });
  };

  /* ---------- customer accounts (registration, sign-in, recovery) ---------- */

  var EMAIL_RX = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;

  function customerRows(db) {
    db.customers = Array.isArray(db.customers) ? db.customers : [];
    return db.customers;
  }

  function findCustomerByEmail(db, email) {
    var em = String(email || '').trim().toLowerCase();
    return customerRows(db).filter(function (c) {
      return c && String(c.email || '').trim().toLowerCase() === em;
    })[0] || null;
  }

  function rememberPreference(remember) {
    return remember !== false;
  }

  function readRememberPreference() {
    try { return !!localStorage.getItem(SESSION_KEY); } catch (e) { return true; }
  }

  /** Validate a customer password. Deliberately stricter than Supabase's 6-character minimum. */
  MB.validateCustomerPassword = function (password) {
    var pw = String(password || '');
    if (pw.length < 10) return { ok: false, error: 'Use at least 10 characters for your password.' };
    if (pw.length > 128) return { ok: false, error: 'Password must be 128 characters or fewer.' };
    if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) {
      return { ok: false, error: 'Password must include uppercase and lowercase letters and a number.' };
    }
    if (/^(password|12345678|qwertyui|admin123)/i.test(pw)) {
      return { ok: false, error: 'Please choose a stronger, less predictable password.' };
    }
    return { ok: true };
  };

  /**
   * Register a customer account.
   *
   * Supabase Auth owns the credential. The customer profile row is created by a
   * database trigger, never by the browser, and no role or privilege is ever
   * placed in user metadata.
   */
  MB.signUpCustomer = function (input) {
    input = input || {};
    var fullName = String(input.fullName || '').trim().slice(0, 120);
    var email = String(input.email || '').trim().toLowerCase();
    var phone = String(input.phone || '').trim().slice(0, 24);
    var password = String(input.password || '');
    var confirm = input.passwordConfirm === undefined ? password : String(input.passwordConfirm || '');

    if (fullName.length < 2) return Promise.resolve({ ok: false, code: 'invalid_name', error: 'Please enter your full name.' });
    if (!EMAIL_RX.test(email)) return Promise.resolve({ ok: false, code: 'invalid_email', error: 'Please enter a valid email address.' });
    if (String(phone).replace(/\D+/g, '').length < 7) {
      return Promise.resolve({ ok: false, code: 'invalid_phone', error: 'Please enter a phone number we can reach you on for order updates.' });
    }
    var pwCheck = MB.validateCustomerPassword(password);
    if (!pwCheck.ok) return Promise.resolve({ ok: false, code: 'weak_password', error: pwCheck.error });
    if (password !== confirm) return Promise.resolve({ ok: false, code: 'password_mismatch', error: 'Both passwords must match.' });

    var rl = checkRateLimit('signup', email, 4, 10 * 60 * 1000);
    if (!rl.allowed) return Promise.resolve({ ok: false, code: 'rate_limited', error: rl.error });

    function localSignUp() {
      var db = loadLocalDb();
      if (findCustomerByEmail(db, email)) {
        /* Deliberately generic: do not confirm which addresses are registered. */
        return {
          ok: true,
          needsVerification: true,
          message: 'If that email address can be registered, a verification message is on its way.'
        };
      }
      var nowIso = new Date().toISOString();
      customerRows(db).push({
        userId: 'cust-' + sha256Hex(email + ':' + Date.now()).slice(0, 24),
        email: email,
        fullName: fullName,
        phone: phone,
        /* The local static fallback has no mail provider, so it verifies immediately.
           Supabase Auth (production) enforces a real confirmation email. */
        emailVerified: true,
        passwordDigest: hashAdminCredential(email, password),
        createdAt: nowIso,
        updatedAt: nowIso
      });
      saveLocalDb(db);
      rl.reset();
      return {
        ok: true,
        needsVerification: false,
        localMode: true,
        email: email,
        message: 'Your account is ready. You can sign in now.'
      };
    }

    if (MB.localMode) return Promise.resolve(localSignUp());

    var confirmRedirect = recoveryRedirectUrl().replace(/\?mode=reset$/, '');
    var signupBody = {
      email: email,
      password: password,
      data: { full_name: fullName, phone: phone }
    };
    /* Send the confirmation link back to the deployed account page. */
    if (confirmRedirect) signupBody.email_redirect_to = confirmRedirect;

    return call('/auth/v1/signup', {
      method: 'POST',
      body: signupBody
    }, ANON).then(function (res) {
      rl.reset();
      var hasSession = !!(res && res.access_token);
      if (hasSession) storeToken(res, rememberPreference(input.remember));
      return {
        ok: true,
        needsVerification: !hasSession || !(res.user && res.user.email_confirmed_at),
        email: email,
        message: hasSession
          ? 'Your account is ready. Please check your inbox if we ask you to confirm your email.'
          : 'Check your inbox: open the message from Mystery Bakebite and confirm your email address before ordering.'
      };
    }).catch(function (err) {
      var msg = String((err && (err.msg || err.message || err.error_description)) || '');
      var status = Number(err && err.status);
      if (status === 429) {
        return { ok: false, code: 'rate_limited', error: 'Too many sign-up attempts. Please try again in a few minutes.' };
      }
      if (/already registered|already been registered|user already exists/i.test(msg)) {
        /* Do not reveal that the address exists. */
        return {
          ok: true,
          needsVerification: true,
          email: email,
          message: 'If that email address can be registered, a verification message is on its way.'
        };
      }
      if (/password/i.test(msg)) {
        return { ok: false, code: 'weak_password', error: msg || 'Please choose a stronger password.' };
      }
      return {
        ok: false,
        code: 'signup_failed',
        error: msg || 'We could not create the account. Please check your connection and try again.'
      };
    });
  };

  /** Sign a customer in. Administrators keep using MB.signIn for the dashboard. */
  MB.signInCustomer = function (email, password, remember) {
    var em = String(email || '').trim().toLowerCase();
    var pw = String(password || '');
    if (!EMAIL_RX.test(em) || !pw) {
      return Promise.resolve({ ok: false, code: 'invalid_credentials', error: 'Enter a valid email address and your password.' });
    }
    var rl = checkRateLimit('customer-signin', em, 5, 5 * 60 * 1000);
    if (!rl.allowed) return Promise.resolve({ ok: false, code: 'rate_limited', error: rl.error });

    if (MB.localMode) {
      var db = loadLocalDb();
      var account = findCustomerByEmail(db, em);
      if (!account || !account.passwordDigest || account.passwordDigest !== hashAdminCredential(em, pw)) {
        rl.recordFailure();
        return Promise.resolve({
          ok: false,
          code: 'invalid_credentials',
          error: 'That email and password did not match an account. Check the details and try again.'
        });
      }
      if (account.emailVerified === false) {
        return Promise.resolve({
          ok: false,
          code: 'email_not_verified',
          email: em,
          error: 'Please confirm your email address before signing in.'
        });
      }
      rl.reset();
      storeToken({
        access_token: 'mb-customer-jwt-' + sha256Hex(em + ':' + Date.now()).slice(0, 32),
        refresh_token: 'mb-customer-refresh-' + sha256Hex(account.userId + ':' + Date.now()).slice(0, 24),
        expires_in: 86400 * 7,
        user: {
          id: account.userId,
          email: account.email,
          name: account.fullName || '',
          fullName: account.fullName || '',
          phone: account.phone || '',
          role: 'customer',
          emailVerified: account.emailVerified !== false
        }
      }, rememberPreference(remember));
      return Promise.resolve({
        ok: true,
        email: account.email,
        fullName: account.fullName || '',
        emailVerified: account.emailVerified !== false,
        redirectTo: 'account.html'
      });
    }

    return tokenRequest('/auth/v1/token?grant_type=password', { email: em, password: pw }).then(function (data) {
      if (!data || !data.access_token) {
        rl.recordFailure();
        return { ok: false, code: 'invalid_credentials', error: 'That email and password did not match an account.' };
      }
      rl.reset();
      storeToken(data, rememberPreference(remember));
      var confirmed = !!(data.user && (data.user.email_confirmed_at || data.user.confirmed_at));
      if (session && session.user) {
        session.user.role = 'customer';
        session.user.emailVerified = confirmed;
        writeSession(session, rememberPreference(remember));
        notifyAuthChange();
      }
      return {
        ok: true,
        email: em,
        emailVerified: confirmed,
        needsVerification: !confirmed
      };
    }).catch(function (err) {
      var msg = String((err && (err.error_description || err.msg || err.message)) || '');
      var status = Number(err && err.status);
      if (status === 400 && /email not confirmed/i.test(msg)) {
        return {
          ok: false,
          code: 'email_not_verified',
          email: em,
          error: 'Please confirm your email address. We can resend the confirmation link.'
        };
      }
      if (status === 429) {
        return { ok: false, code: 'rate_limited', error: 'Too many attempts. Please wait a few minutes and try again.' };
      }
      rl.recordFailure();
      return {
        ok: false,
        code: 'invalid_credentials',
        error: 'That email and password did not match an account. Check the details and try again.'
      };
    });
  };

  /** Sign out of the customer session (shared Supabase Auth session). */
  MB.signOutCustomer = function () {
    return MB.signOut().then(function () { return { ok: true }; });
  };

  /** Public-safe account summary read from the verified session only. */
  MB.isCustomerSignedIn = function () { return isSessionValid(session); };

  MB.customerDisplayName = function () {
    if (!isSessionValid(session) || !session.user) return '';
    var u = session.user;
    return String(u.fullName || u.name || u.email || '').trim();
  };

  /** Ask Supabase Auth to email a password-recovery link that returns to account.html. */
  MB.requestCustomerPasswordReset = function (email) {
    var em = String(email || '').trim().toLowerCase();
    if (!EMAIL_RX.test(em)) {
      return Promise.resolve({ ok: false, code: 'invalid_email', error: 'Please enter a valid email address.' });
    }
    var rl = checkRateLimit('customer-recover', em, 4, 10 * 60 * 1000);
    if (!rl.allowed) return Promise.resolve({ ok: false, code: 'rate_limited', error: rl.error });

    var generic = {
      ok: true,
      message: 'If an account exists for ' + em + ', a password reset link is on its way. Check the spam folder too.'
    };

    if (MB.localMode) {
      var db = loadLocalDb();
      if (findCustomerByEmail(db, em)) {
        return Promise.resolve({
          ok: true,
          localMode: true,
          message: 'This browser is running without the live database, so no email can be sent. Create the account again on the live site to reset the password, or use the admin dashboard.'
        });
      }
      return Promise.resolve(generic);
    }

    var redirect = recoveryRedirectUrl();
    return call('/auth/v1/recover' + (redirect ? '?redirect_to=' + encodeURIComponent(redirect) : ''), {
      method: 'POST',
      body: { email: em }
    }, ANON).then(function () {
      rl.reset();
      return generic;
    }).catch(function () {
      /* Never disclose whether the address exists. */
      return generic;
    });
  };

  function recoveryRedirectUrl() {
    try {
      if (typeof window === 'undefined' || !window.location) return '';
      var origin = window.location.origin;
      if (!/^https?:/i.test(origin)) return '';
      var path = window.location.pathname.replace(/[^/]*$/, '');
      return origin + path + 'account.html?mode=reset';
    } catch (e) { return ''; }
  }

  /** Resend the Supabase Auth confirmation email. */
  MB.resendVerificationEmail = function (email) {
    var em = String(email || (session && session.user && session.user.email) || '').trim().toLowerCase();
    if (!EMAIL_RX.test(em)) {
      return Promise.resolve({ ok: false, code: 'invalid_email', error: 'Enter the email address you registered with.' });
    }
    var rl = checkRateLimit('resend-verify', em, 3, 10 * 60 * 1000);
    if (!rl.allowed) return Promise.resolve({ ok: false, code: 'rate_limited', error: rl.error });
    if (MB.localMode) {
      return Promise.resolve({ ok: true, message: 'This preview has no mail provider. On the live site a confirmation email would be sent.' });
    }
    var redirect = recoveryRedirectUrl().replace('?mode=reset', '');
    return call('/auth/v1/resend' + (redirect ? '?redirect_to=' + encodeURIComponent(redirect) : ''), {
      method: 'POST',
      body: { type: 'signup', email: em }
    }, ANON).then(function () {
      rl.reset();
      return { ok: true, message: 'Confirmation email sent to ' + em + '. Check the spam folder if it does not arrive.' };
    }).catch(function () {
      return { ok: true, message: 'If that address is awaiting confirmation, another message is on its way.' };
    });
  };

  /**
   * Supabase Auth returns sign-in, confirmation and recovery results in the URL
   * fragment (or as ?code=). Capture the session, strip the secret from the
   * address bar, and remember what kind of redirect it was.
   */
  MB.consumeAuthRedirect = function () {
    var result = { consumed: false, type: '', error: '' };
    if (typeof window === 'undefined' || !window.location) return result;
    var loc = window.location;
    var hash = String(loc.hash || '').replace(/^#/, '');
    var search = String(loc.search || '').replace(/^\?/, '');
    var params = {};
    [hash, search].forEach(function (chunk) {
      chunk.split('&').forEach(function (pair) {
        if (!pair) return;
        var bits = pair.split('=');
        if (bits[0]) params[decodeURIComponent(bits[0])] = decodeURIComponent((bits[1] || '').replace(/\+/g, ' '));
      });
    });
    if (params.error_description || params.error) {
      result.error = String(params.error_description || params.error).replace(/\+/g, ' ');
      result.consumed = true;
    }
    result.type = String(params.type || (/(^|&)mode=reset/.test(search + '&' + hash) ? 'recovery' : '') || '');
    if (params.access_token) {
      storeToken({
        access_token: params.access_token,
        refresh_token: params.refresh_token || '',
        expires_in: Number(params.expires_in) || 3600,
        user: null
      }, readRememberPreference());
      result.consumed = true;
      if (result.type === 'recovery') result.type = 'recovery';
      /* Load the user for this session before the page renders account data. */
      freshToken().then(function (token) {
        return call('/auth/v1/user', { method: 'GET' }, token);
      }).then(function (user) {
        if (user && user.id && session) {
          session.user = {
            id: user.id,
            email: user.email,
            name: (user.user_metadata && user.user_metadata.full_name) || '',
            fullName: (user.user_metadata && user.user_metadata.full_name) || '',
            phone: (user.user_metadata && user.user_metadata.phone) || '',
            role: 'customer',
            emailVerified: !!(user.email_confirmed_at || user.confirmed_at)
          };
          writeSession(session, readRememberPreference());
          notifyAuthChange();
        }
      }).catch(function () {});
      try {
        var clean = loc.pathname + (loc.search || '').replace(/([?&])(code|type|error|error_description)=[^&]*/g, '$1').replace(/[?&]$/, '');
        window.history.replaceState(null, '', clean);
      } catch (e) {}
    }
    return result;
  };

  /** Refresh the cached profile in the session from trusted database data. */
  MB.refreshCustomerProfile = function () {
    if (!isSessionValid(session)) {
      return Promise.resolve({ ok: true, signedIn: false, emailVerified: false, profile: null });
    }
    return MB.rpc('api_customer_whoami').then(function (res) {
      if (res && res.profile && session && session.user) {
        session.user.fullName = res.profile.fullName || session.user.fullName || '';
        session.user.name = session.user.fullName;
        session.user.phone = res.profile.phone || '';
        session.user.role = 'customer';
        session.user.emailVerified = !!res.emailVerified;
        writeSession(session, readRememberPreference());
        notifyAuthChange();
      }
      return res;
    });
  };

  /** Customer password reset using a recovery session, or a change while signed in. */
  MB.updateCustomerPassword = function (newPassword, confirmPassword) {
    var pw = String(newPassword || '');
    if (confirmPassword !== undefined && pw !== String(confirmPassword || '')) {
      return Promise.resolve({ ok: false, code: 'password_mismatch', error: 'Both passwords must match.' });
    }
    var pwCheck = MB.validateCustomerPassword(pw);
    if (!pwCheck.ok) return Promise.resolve({ ok: false, code: 'weak_password', error: pwCheck.error });
    if (!isSessionValid(session)) {
      return Promise.resolve({ ok: false, code: 'auth_required', error: 'Open the reset link from your email, or sign in first.' });
    }
    if (MB.localMode) {
      var db = loadLocalDb();
      var em = String((session.user && session.user.email) || '').trim().toLowerCase();
      var account = findCustomerByEmail(db, em);
      if (!account) return Promise.resolve({ ok: false, code: 'not_found', error: 'Account not found in this preview.' });
      account.passwordDigest = hashAdminCredential(em, pw);
      account.updatedAt = new Date().toISOString();
      saveLocalDb(db);
      return Promise.resolve({ ok: true, message: 'Password updated. You can sign in with the new password.' });
    }
    return freshToken().then(function (token) {
      return call('/auth/v1/user', { method: 'PUT', body: { password: pw } }, token);
    }).then(function () {
      return { ok: true, message: 'Password updated. Keep it somewhere safe.' };
    }).catch(function (err) {
      var msg = String((err && (err.msg || err.message)) || '');
      if (/same|different from the old/i.test(msg)) {
        return { ok: false, code: 'same_password', error: 'Choose a password you have not used for this account before.' };
      }
      return { ok: false, code: 'update_failed', error: msg || 'The password could not be updated. Try the reset link again.' };
    });
  };

  /** Change the signed-in user's own password. */
  MB.changePassword = function (password) {
    var pw = String(password || '');
    var uEmail = (session && session.user && session.user.email) ? String(session.user.email).trim().toLowerCase() : '';
    var pwCheck = validateStrongPassword(pw, uEmail);
    if (!pwCheck.ok) {
      return Promise.resolve({ ok: false, code: 'weak_password', error: pwCheck.error });
    }
    if (MB.localMode) {
      if (!MB.isSignedIn() || !session || !session.user) {
        return Promise.resolve({ ok: false, error: 'Not signed in.' });
      }
      var db = loadLocalDb();
      var adm = (db.admins || []).filter(function (a) {
        return String(a.email || '').trim().toLowerCase() === uEmail;
      })[0];
      if (!adm) return Promise.resolve({ ok: false, error: 'Administrator account not found.' });
      adm.passwordDigest = hashAdminCredential(uEmail, pw);
      adm.mustChangePassword = false;
      adm.isProvisioned = true;
      adm.passwordChangedAt = new Date().toISOString();
      recordAdminAudit(db, 'password_changed', uEmail, uEmail, 'Administrator changed account password');
      saveLocalDb(db);
      if (session && session.user) {
        session.user.mustChangePassword = false;
        var rem = true;
        try { rem = !!localStorage.getItem(SESSION_KEY); } catch (_) {}
        writeSession(session, rem);
      }
      return Promise.resolve({ ok: true, message: 'Password changed.' });
    }
    return freshToken().then(function (token) {
      return call('/auth/v1/user', {
        method: 'PUT',
        body: { password: pw, data: { must_change_password: false } }
      }, token);
    }).then(function () {
      return MB.rpc('api_admin_complete_first_login', { p_current_password: '', p_new_password: pw }).catch(function () {});
    }).then(function () {
      if (session) {
        session.user = session.user || {};
        session.user.mustChangePassword = false;
      }
      return { ok: true, message: 'Password changed.' };
    }).catch(function (err) {
      var msg = (err && (err.msg || err.message)) || 'The password could not be changed.';
      if (/at least 6|weak|short/i.test(msg)) msg = 'Use at least 10 characters with uppercase, lowercase, number, and symbol.';
      return { ok: false, error: msg };
    });
  };

  /* ---------- storage: payment screenshots ---------- */

  /** A temporary link the dashboard can show for one stored screenshot. */
  MB.proofUrl = function (path) {
    if (!path) return Promise.resolve('');
    if (MB.localMode) {
      var db = loadLocalDb();
      if (requireAdmin(db)) return Promise.resolve('');
      return Promise.resolve((db.proofs && db.proofs[path]) || '');
    }
    return freshToken().then(function (token) {
      return call('/storage/v1/object/sign/proofs/' + path.split('/').map(encodeURIComponent).join('/'),
        { method: 'POST', body: { expiresIn: 3600 } }, token);
    }).then(function (data) {
      if (!data || !data.signedURL) return '';
      return URL_BASE + '/storage/v1' + data.signedURL;
    }).catch(function () { return ''; });
  };

  function uploadProof(path, dataUrl, token) {
    var vCheck = verifyImageDataUrl(dataUrl);
    if (!vCheck.ok) {
      return Promise.reject({ message: vCheck.error, code: vCheck.code });
    }
    if (MB.localMode) {
      var db = loadLocalDb();
      db.proofs = db.proofs || {};
      db.proofs[path] = dataUrl;
      saveLocalDb(db);
      return Promise.resolve(path);
    }
    var blob;
    try {
      blob = dataUrlToBlob(dataUrl);
    } catch (e) {
      return Promise.reject({ message: 'That screenshot could not be read. Try another image.' });
    }
    if (!blob) return Promise.resolve(null);
    return call('/storage/v1/object/proofs/' + path.split('/').map(encodeURIComponent).join('/'), {
      method: 'POST',
      body: blob,
      /* the storage API wants the type and no JSON envelope */
      headers: {}
    }, token).then(function () { return path; });
  }

  function dataUrlToBlob(dataUrl) {
    if (!dataUrl) return null;
    var m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl);
    if (!m) throw new Error('not a data url');
    var binary = atob(m[2]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  MB.dataUrlToBlob = dataUrlToBlob;

  /* ---------- the route table ---------- */

  function query(params) {
    var out = {};
    if (!params) return out;
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null) out[k] = v;
    });
    return out;
  }

  function splitPath(path) {
    var qIndex = path.indexOf('?');
    var raw = qIndex === -1 ? path : path.slice(0, qIndex);
    var search = qIndex === -1 ? '' : path.slice(qIndex + 1);
    var params = {};
    search.split('&').forEach(function (pair) {
      if (!pair) return;
      var bits = pair.split('=');
      params[decodeURIComponent(bits[0])] = decodeURIComponent((bits[1] || '').replace(/\+/g, ' '));
    });
    return { path: raw.replace(/\/+$/, ''), params: params };
  }

  var ADMIN_WRITE = {
    products: 'api_admin_product',
    classes: 'api_admin_class',
    categories: 'api_admin_category',
    options: 'api_admin_option'
  };

  /**
   * The one entry point the pages use. Takes the same paths the site used when
   * it had a server, and answers with the same JSON shapes.
   *
   * Resolves with { ok: true, ... } or { ok: false, error, code }. It never
   * rejects, so a lost connection cannot leave a button spinning forever.
   */
  MB.api = function (path, opts) {
    opts = opts || {};
    var body = opts.body;
    var method = (opts.method || 'GET').toUpperCase();
    var route = splitPath(String(path || ''));
    var p = route.path;
    var q = query(route.params);
    var idem = (opts.headers && (opts.headers['Idempotency-Key'] || opts.headers['idempotency-key'])) || '';

    if (!MB.configured) {
      return Promise.resolve({ ok: false, code: 'not_configured',
        error: 'The bakery database has not been connected yet.' });
    }

    /* ---- public ---- */
    if (p === '/api/config') return MB.rpc('api_config');
    if (p === '/api/catalogue') return MB.rpc('api_catalogue');

    if (p === '/api/price') return MB.rpc('api_price', { p_type: 'product', p_items: body || {} });
    if (p === '/api/price/booking') return MB.rpc('api_price', { p_type: 'class', p_items: body || {} });

    if (p === '/api/orders') return MB.rpc('api_place_order', { p_kind: 'product', p_payload: body || {}, p_idem: idem });
    if (p === '/api/bookings') return MB.rpc('api_place_order', { p_kind: 'class', p_payload: body || {}, p_idem: idem });

    if (p === '/api/orders/lookup') {
      return MB.rpc('api_lookup_order', { p_ref: (body && body.ref) || q.ref || '', p_phone: (body && body.phone) || q.phone || '' });
    }

    var orderMatch = /^\/api\/orders\/([^/]+)(\/proof)?$/.exec(p);
    if (orderMatch) {
      var ref = decodeURIComponent(orderMatch[1]);
      var token = q.token || (body && body.token) || '';
      if (orderMatch[2]) {
        return submitProof(ref, token, body || {});
      }
      return MB.rpc('api_order', { p_ref: ref, p_token: token });
    }

    /* ---- customer account ---- */
    if (p === '/api/account/session') return MB.rpc('api_customer_whoami');
    if (p === '/api/account/orders') return MB.rpc('api_customer_orders');
    if (p === '/api/account/profile') {
      if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
        return MB.rpc('api_customer_update_profile', {
          p_full_name: (body && (body.fullName || body.full_name)) || '',
          p_phone: (body && body.phone) || ''
        });
      }
      return MB.rpc('api_customer_whoami');
    }

    /* ---- admin ---- */
    if (p === '/api/admin/session') return MB.rpc('api_admin_whoami');
    if (p === '/api/admin/first-login-password') {
      return MB.completeFirstLoginPassword(
        (body && body.currentPassword) || '',
        (body && body.newPassword) || ''
      );
    }

    if (p.indexOf('/api/admin/') === 0) {
      if (!MB.isSignedIn()) {
        return Promise.resolve({
          ok: false,
          auth: true,
          code: 'unauthorised',
          error: 'Unauthorised: please sign in as an administrator.'
        });
      }
      if (MB.localMode) {
        var rErr = requireAdmin(loadLocalDb());
        if (rErr) return Promise.resolve(rErr);
      } else if (session && session.user) {
        if (session.user.mustChangePassword) {
          return Promise.resolve({
            ok: false,
            auth: false,
            code: 'password_change_required',
            mustChangePassword: true,
            error: 'Security requirement: you must change your temporary password before accessing the dashboard.'
          });
        }
        var sRole = String(session.user.role || '').trim().toLowerCase();
        if (sRole && !ALLOWED_ADMIN_ROLES[sRole] && sRole !== 'authenticated') {
          return Promise.resolve({
            ok: false,
            auth: true,
            code: 'unauthorised',
            error: 'Unauthorised: administrator role required.'
          });
        }
      }
    }

    if (p === '/api/admin/team') {
      var teamBody = body || {};
      var teamAction = String(teamBody.action || 'list').toLowerCase();
      if (!MB.localMode && teamAction !== 'list') {
        /* Try the privileged Supabase Edge Function first (which manages auth.users + public.admin_users),
           falling back to the SECURITY DEFINER RPC api_admin_team if Edge Functions are not yet deployed. */
        return freshToken().then(function (token) {
          return call('/functions/v1/admin-users', { method: 'POST', body: teamBody }, token);
        }).then(function (res) {
          if (res && typeof res === 'object') return res;
          return MB.rpc('api_admin_team', { p_payload: teamBody });
        }).catch(function () {
          return MB.rpc('api_admin_team', { p_payload: teamBody });
        });
      }
      return MB.rpc('api_admin_team', { p_payload: teamBody });
    }
    if (p === '/api/admin/discounts') return MB.rpc('api_admin_discounts', { p_payload: method === 'POST' ? (body || {}) : {} });
    if (p === '/api/admin/catalogue') return MB.rpc('api_admin_catalogue');
    if (p === '/api/admin/dashboard') return MB.rpc('api_admin_dashboard', { p_days: parseInt(q.days, 10) || 7 });
    if (p === '/api/admin/notifications') return MB.rpc('api_admin_notifications');

    if (p === '/api/admin/orders') {
      return MB.rpc('api_admin_orders', {
        p_q: q.q || '',
        p_status: q.status || '',
        p_payment: q.payment || '',
        p_kind: q.kind || '',
        p_limit: parseInt(q.limit, 10) || 100
      });
    }

    var adminOrder = /^\/api\/admin\/orders\/([^/]+)(?:\/(verify|proof|receipt\.pdf))?$/.exec(p);
    if (adminOrder) {
      var aref = decodeURIComponent(adminOrder[1]);
      var what = adminOrder[2];
      if (what === 'verify') {
        return MB.rpc('api_admin_verify', {
          p_ref: aref,
          p_action: (body && body.action) || '',
          p_note: (body && (body.note || body.reason)) || ''
        });
      }
      if (what === 'proof') return MB.proofUrl((body && body.path) || q.path || '');
      if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
        return MB.rpc('api_admin_update_order', { p_ref: aref, p_patch: body || {} });
      }
      return MB.rpc('api_admin_order', { p_ref: aref });
    }

    if (p === '/api/admin/settings') {
      return MB.rpc('api_admin_settings', { p_payload: body || {} });
    }

    if (p === '/api/admin/discounts') {
      return MB.rpc('api_admin_discounts', { p_payload: body || {} });
    }

    var adminWrite = /^\/api\/admin\/(products|classes|categories|options)$/.exec(p);
    if (adminWrite) {
      var fn = ADMIN_WRITE[adminWrite[1]];
      var how = method === 'POST' ? 'POST' : (method === 'DELETE' ? 'DELETE' : 'PATCH');
      return MB.rpc(fn, { p_method: how, p_payload: body || {} });
    }

    if (p === '/api/admin/login' || p === '/api/admin/logout' || p === '/api/admin/password') {
      return Promise.resolve({ ok: false, code: 'moved',
        error: 'Sign-in is handled by Supabase Auth now.' });
    }

    return Promise.resolve({ ok: false, code: 'not_found', error: 'Unknown request: ' + p });
  };

  /* ---------- payment proof: authorise, upload, record ---------- */

  function submitProof(ref, token, body) {
    var normRef = String(ref || '').trim().toUpperCase();
    if (!normRef) {
      return Promise.resolve({ ok: false, code: 'not_found', error: 'Order reference is required.' });
    }
    if (IN_FLIGHT_PROOFS[normRef]) {
      return Promise.resolve({
        ok: false,
        code: 'duplicate_in_flight',
        error: 'Your payment submission is already being processed. Please wait.'
      });
    }

    var dataUrl = String((body && body.image) || '').trim();
    var reference = String((body && body.reference) || '').trim();
    var note = String((body && body.note) || '').trim().slice(0, 200);

    if (dataUrl) {
      var imgCheck = verifyImageDataUrl(dataUrl);
      if (!imgCheck.ok) {
        return Promise.resolve(imgCheck);
      }
    }

    IN_FLIGHT_PROOFS[normRef] = true;

    function release(res) {
      delete IN_FLIGHT_PROOFS[normRef];
      return res;
    }

    function record(path) {
      return MB.rpc('api_submit_proof', {
        p_ref: normRef,
        p_token: token,
        p_reference: reference,
        p_image_path: path || '',
        p_note: note
      });
    }

    if (!dataUrl) {
      return record('').then(release, function (err) {
        delete IN_FLIGHT_PROOFS[normRef];
        return failure(err);
      });
    }

    var ext = 'jpg';
    var m = /^data:image\/([a-z0-9.+-]+);/i.exec(dataUrl);
    if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg');

    return MB.rpc('api_begin_proof_upload', { p_ref: normRef, p_token: token, p_ext: ext })
      .then(function (res) {
        if (!res || res.ok === false) return release(res);
        return uploadProof(res.path, dataUrl, null).then(function () {
          return record(res.path);
        }).catch(function (err) {
          /* If the user also provided a valid reference, record the reference; otherwise fail cleanly */
          if (reference && reference.length >= 4) {
            return record('').then(function (saved) {
              if (saved && saved.ok) {
                saved.warning = (err && err.message) ||
                  'The screenshot could not be uploaded, so only the transaction reference was saved.';
              }
              return saved;
            });
          }
          return {
            ok: false,
            code: (err && err.code) || 'upload_failed',
            error: (err && err.message) || 'The screenshot could not be uploaded. Please try again.'
          };
        }).then(release);
      }).catch(function (err) {
        delete IN_FLIGHT_PROOFS[normRef];
        return failure(err);
      });
  }

  /* ---------- receipts (strictly for product orders only, auto-downloaded A6 PDF) ---------- */

  var RECEIPT_LOGO_B64 = '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';

  function decodeBase64Bytes(b64) {
    if (typeof atob === 'function') {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
      return out;
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    return new Uint8Array(0);
  }

  function asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function concatUint8Arrays(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var res = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      res.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return res;
  }

  function pdfCleanText(s) {
    return String(s == null ? '' : s)
      .replace(/\u20B5/g, 'S')
      .replace(/GH\s*S/g, 'GHS')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u00B7/g, ' | ')
      .replace(/\u2212/g, '-')
      .replace(/\u00D7/g, 'x')
      .replace(/[^\x20-\x7E]/g, '');
  }

  function pdfEsc(s) {
    return pdfCleanText(s)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  function pdfMoney(p) {
    if (typeof p !== 'number' || !isFinite(p)) return 'On request';
    var val = p / 100;
    var neg = val < 0;
    var fixed = Math.abs(val).toFixed(2);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '- ' : '') + 'GHS ' + parts.join('.');
  }

  function wrapPdfText(str, maxChars) {
    var clean = pdfCleanText(str).trim();
    if (!clean) return [];
    var words = clean.split(/\s+/);
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!cur) {
        cur = w;
      } else if ((cur + ' ' + w).length <= maxChars) {
        cur += ' ' + w;
      } else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function isProductOrderOnly(orderOrRef) {
    if (!orderOrRef) return false;
    if (typeof orderOrRef === 'string') {
      var r = orderOrRef.trim().toUpperCase();
      return /^MB-[A-Z0-9-]{4,20}$/.test(r);
    }
    var ref = String(orderOrRef.ref || '').trim().toUpperCase();
    var kind = String(orderOrRef.kind || '').trim().toLowerCase();
    if (kind === 'class' || /^MC-/i.test(ref)) return false;
    return /^MB-[A-Z0-9-]{4,20}$/.test(ref) || kind === 'product';
  }

  /**
   * Generates a standalone ISO A6 (105mm x 148mm / 297.64pt x 419.53pt) PDF
   * byte array strictly for a valid product order. Returns null if the object
   * is not a valid product order.
   */
  function generateReceiptPdfBytes(order, config, extra) {
    if (!isProductOrderOnly(order)) return null;
    extra = extra || {};
    config = config || {};

    var W = 297.64; // 105mm in points
    var H = 419.53; // 148mm in points
    function Y(topPt) { return +(H - topPt).toFixed(2); }

    var ops = [];
    function fillRgb(r, g, b) { ops.push((r / 255).toFixed(3) + ' ' + (g / 255).toFixed(3) + ' ' + (b / 255).toFixed(3) + ' rg'); }
    function strokeRgb(r, g, b) { ops.push((r / 255).toFixed(3) + ' ' + (g / 255).toFixed(3) + ' ' + (b / 255).toFixed(3) + ' RG'); }
    function rectFill(x, top, w, h, r, g, b) {
      fillRgb(r, g, b);
      ops.push(x.toFixed(2) + ' ' + Y(top + h) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re f');
    }
    function rectStroke(x, top, w, h, lw, r, g, b) {
      ops.push(lw.toFixed(2) + ' w');
      strokeRgb(r, g, b);
      ops.push(x.toFixed(2) + ' ' + Y(top + h) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re S');
    }
    function rectFillStroke(x, top, w, h, lw, fr, fg, fb, sr, sg, sb) {
      ops.push(lw.toFixed(2) + ' w');
      fillRgb(fr, fg, fb);
      strokeRgb(sr, sg, sb);
      ops.push(x.toFixed(2) + ' ' + Y(top + h) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re B');
    }
    function hLine(x1, x2, top, lw, r, g, b) {
      ops.push(lw.toFixed(2) + ' w');
      strokeRgb(r, g, b);
      ops.push(x1.toFixed(2) + ' ' + Y(top) + ' m ' + x2.toFixed(2) + ' ' + Y(top) + ' l S');
    }
    function text(font, size, x, topBaseline, str, r, g, b) {
      if (r !== undefined) fillRgb(r, g, b);
      ops.push('BT /' + font + ' ' + size.toFixed(2) + ' Tf ' + x.toFixed(2) + ' ' + Y(topBaseline) + ' Td (' + pdfEsc(str) + ') Tj ET');
    }
    function textRight(font, size, rightX, topBaseline, str, r, g, b) {
      var clean = pdfCleanText(str);
      var charW = font === 'F4' ? 0.60 : (font === 'F2' ? 0.55 : 0.51);
      var estW = clean.length * size * charW;
      var x = Math.max(10, rightX - estW);
      text(font, size, x, topBaseline, clean, r, g, b);
    }

    // 1. Page Background & Luxury Borders
    rectFill(0, 0, W, H, 251, 246, 238);
    rectStroke(7, 7, W - 14, H - 14, 1.1, 197, 155, 39);
    rectStroke(9.5, 9.5, W - 19, H - 19, 0.45, 224, 200, 148);
    rectFill(7, 7, W - 14, 4.2, 31, 16, 8);
    rectFill(7, 11.2, W - 14, 1.3, 212, 164, 55);

    // 2. Header: Logo + Brand Identity + Reference Box
    rectFillStroke(14, 16.5, 36, 36, 0.8, 26, 13, 6, 212, 164, 55);
    ops.push('q 34 0 0 34 15 ' + Y(51.5) + ' cm /ImLogo Do Q');

    text('F2', 4.6, 55, 21.5, 'BAKING  |  TRAINING  |  CREATIVE', 154, 110, 21);
    text('F2', 11.2, 55, 32.2, 'Mystery Bakebite', 31, 16, 8);
    text('F3', 6.4, 55, 40.2, 'Unveiling The Uniqueness of A Recipe', 128, 78, 24);
    text('F1', 4.6, 55, 47.5, 'Artisan Home Bakery & Practical Baking School | Tamale, Ghana', 92, 72, 58);

    var payStatus = order.paymentStatus || order.payment_status || 'awaiting_payment';
    var ordStatus = order.orderStatus || order.order_status || 'submitted';
    var payShortMap = {
      awaiting_payment: 'PAYMENT PENDING',
      payment_submitted: 'UNDER REVIEW',
      payment_verified: 'PAYMENT VERIFIED',
      payment_rejected: 'NOT VERIFIED',
      pay_on_collection: 'PAY ON HANDOVER',
      not_required: 'NO PAYMENT DUE'
    };
    var ordShortMap = {
      submitted: 'SUBMITTED',
      confirmed: 'CONFIRMED',
      in_preparation: 'IN PREPARATION',
      completed: 'COMPLETED',
      cancelled: 'CANCELLED'
    };
    var payShort = payShortMap[payStatus] || String(payStatus).toUpperCase();
    var ordShort = 'ORDER: ' + (ordShortMap[ordStatus] || String(ordStatus).toUpperCase());

    textRight('F2', 4.8, 283, 19.8, 'OFFICIAL ORDER RECEIPT', 122, 84, 32);
    rectFillStroke(194, 22, 89, 19.5, 0.65, 245, 235, 214, 204, 162, 62);
    text('F2', 4.1, 198, 27.8, 'RECEIPT / REFERENCE NO.', 122, 90, 43);
    text('F4', 8.0, 198, 37.8, order.ref, 31, 16, 8);

    var isPaid = payStatus === 'payment_verified';
    rectFillStroke(194, 43.5, 44, 9, 0.45, isPaid ? 226 : 248, isPaid ? 243 : 235, isPaid ? 222 : 204, isPaid ? 62 : 196, isPaid ? 138 : 142, isPaid ? 74 : 38);
    text('F2', 3.9, 196.5, 49.4, payShort, isPaid ? 30 : 128, isPaid ? 98 : 82, isPaid ? 42 : 14);

    rectFillStroke(240, 43.5, 43, 9, 0.45, 238, 232, 222, 168, 148, 122);
    text('F2', 3.9, 242.5, 49.4, ordShort, 68, 52, 38);

    hLine(14, 283.64, 56.5, 0.5, 212, 164, 55);

    // 3. 2x2 Customer & Schedule Metadata Grid
    var cust = order.customer || { name: order.customer_name || 'Valued Customer', phone: order.phone || '', email: order.email || '' };
    var createdRaw = order.createdAt || order.created_at || new Date().toISOString();
    var createdDate = new Date(createdRaw);
    var createdStr = !isNaN(createdDate.getTime())
      ? createdDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
        createdDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : String(createdRaw).slice(0, 16).replace('T', ' ');

    var eventDateRaw = order.eventDate || order.event_date || '';
    var eventDateFmt = eventDateRaw ? formatOrderDate(eventDateRaw) : '';
    var fulfilTitle = order.fulfilment === 'delivery' ? 'Delivery within Tamale' : 'Bakery Collection | Tamale';
    var fulfilSub = (eventDateFmt ? 'Preferred date: ' + eventDateFmt : 'Tamale, Northern Region') +
      (order.address ? ' | ' + order.address : '');

    var payMethod = order.paymentMethod || order.payment_method || 'cash_on_pickup';
    var methodMap = {
      momo: 'Mobile Money (MTN / Telecel)',
      bank_transfer: 'Bank Transfer',
      cash_on_delivery: 'Cash on Delivery',
      cash_on_pickup: 'Cash on Bakery Collection'
    };
    var methodTitle = methodMap[payMethod] || String(payMethod);
    var methodSub = payShort + (order.paymentRef ? ' | Ref: ' + order.paymentRef : '');

    rectFillStroke(14, 59.5, 132.5, 25, 0.4, 255, 252, 246, 222, 204, 172);
    text('F2', 4.1, 18, 65.2, 'CUSTOMER / BILLED TO', 138, 102, 42);
    text('F2', 6.3, 18, 73.2, String(cust.name || 'Customer').slice(0, 34), 31, 16, 8);
    text('F1', 4.8, 18, 80.5, ([cust.phone, cust.email].filter(Boolean).join(' | ') || 'Tamale, Ghana').slice(0, 44), 96, 76, 58);

    rectFillStroke(150.5, 59.5, 133, 25, 0.4, 255, 252, 246, 222, 204, 172);
    text('F2', 4.1, 154.5, 65.2, 'DATE & TIME ISSUED', 138, 102, 42);
    text('F2', 6.1, 154.5, 73.2, createdStr.slice(0, 34), 31, 16, 8);
    text('F1', 4.8, 154.5, 80.5, 'Receipt No. ' + order.ref + ' | Official Order Copy', 96, 76, 58);

    rectFillStroke(14, 87, 132.5, 25, 0.4, 255, 252, 246, 222, 204, 172);
    text('F2', 4.1, 18, 92.7, 'FULFILMENT & PREFERRED DATE', 138, 102, 42);
    text('F2', 6.1, 18, 100.7, fulfilTitle.slice(0, 34), 31, 16, 8);
    text('F2', 4.8, 18, 108.0, fulfilSub.slice(0, 44), 142, 92, 20);

    rectFillStroke(150.5, 87, 133, 25, 0.4, 255, 252, 246, 222, 204, 172);
    text('F2', 4.1, 154.5, 92.7, 'PAYMENT METHOD & STATUS', 138, 102, 42);
    text('F2', 6.1, 154.5, 100.7, methodTitle.slice(0, 34), 31, 16, 8);
    text('F1', 4.8, 154.5, 108.0, methodSub.slice(0, 44), 96, 76, 58);

    // 4. Purchased Bakery Items Table
    var itemsList = Array.isArray(order.items) ? order.items : [];
    var totalUnits = itemsList.reduce(function (s, it) { return s + (Number(it.qty) || 1); }, 0);

    text('F2', 5.2, 14, 120.5, 'PURCHASED BAKERY ITEMS & SPECIFICATIONS', 31, 16, 8);
    textRight('F2', 4.8, 283.5, 120.5, itemsList.length + (itemsList.length === 1 ? ' line item (' : ' line items (') + totalUnits + (totalUnits === 1 ? ' unit)' : ' units)'), 122, 90, 43);

    var tblTop = 123.5;
    var headH = 12;
    rectFill(14, tblTop, 269.5, headH, 36, 18, 9);
    text('F2', 4.5, 17, tblTop + 8.0, '#', 245, 230, 214);
    text('F2', 4.5, 30, tblTop + 8.0, 'ITEM & SPECIFICATION', 245, 230, 214);
    text('F2', 4.5, 179, tblTop + 8.0, 'QTY', 245, 230, 214);
    textRight('F2', 4.5, 234, tblTop + 8.0, 'UNIT PRICE', 245, 230, 214);
    textRight('F2', 4.5, 280, tblTop + 8.0, 'LINE TOTAL', 245, 230, 214);

    var maxTableBodyH = 136;
    var rowCount = Math.max(1, itemsList.length);
    var rowH = Math.min(20, Math.max(11.5, Math.floor(maxTableBodyH / rowCount)));
    var curY = tblTop + headH;

    itemsList.slice(0, 11).forEach(function (item, idx) {
      var isEven = idx % 2 === 1;
      rectFill(14, curY, 269.5, rowH, isEven ? 248 : 254, isEven ? 241 : 250, isEven ? 229 : 243);
      hLine(14, 283.5, curY + rowH, 0.3, 224, 208, 182);

      var numStr = idx < 9 ? '0' + (idx + 1) : String(idx + 1);
      var q = Number(item.qty) || 1;
      var unitP = typeof item.unitPrice === 'number' ? item.unitPrice : null;
      var grossLine = unitP !== null ? unitP * q : null;
      var itemDisc = Number(item.discount) || 0;
      var netLine = typeof item.lineTotal === 'number'
        ? item.lineTotal
        : (grossLine !== null ? Math.max(0, grossLine - itemDisc) : null);

      var nameFont = rowH >= 15 ? 5.6 : 4.9;
      var metaFont = rowH >= 15 ? 4.4 : 3.9;
      var nameY = curY + (item.meta ? rowH * 0.44 : rowH * 0.62);

      text('F4', 4.8, 17, nameY, numStr, 138, 102, 42);
      text('F2', nameFont, 30, nameY, String(item.name || 'Bakery Item').slice(0, 42), 31, 16, 8);
      if (item.meta && rowH >= 12) {
        var metaStr = String(item.meta) + (itemDisc > 0 ? ' (Saved ' + pdfMoney(itemDisc) + ')' : '');
        text('F1', metaFont, 30, curY + rowH * 0.82, metaStr.slice(0, 56), 112, 88, 66);
      }
      text('F2', nameFont, 182, nameY, String(q), 31, 16, 8);
      textRight('F1', nameFont, 234, nameY, unitP !== null ? pdfMoney(unitP) : 'On request', 68, 52, 38);
      textRight('F2', nameFont, 280, nameY, netLine !== null ? pdfMoney(netLine) : 'On request', 31, 16, 8);

      curY += rowH;
    });
    rectStroke(14, tblTop, 269.5, curY - tblTop, 0.45, 204, 182, 146);

    // 5. Bottom Section: Payment & Verification Record (Left) + Financial Summary (Right)
    var botTop = 276;
    var botH = 104;

    rectFillStroke(14, botTop, 148, botH, 0.45, 255, 252, 246, 218, 198, 164);
    text('F2', 4.8, 18, botTop + 8.5, 'PAYMENT & VERIFICATION RECORD', 31, 16, 8);

    var descMap = {
      awaiting_payment: 'Payment pending: no payment has been verified yet. Complete payment using the reference on this receipt.',
      payment_submitted: 'Payment under review: transaction details received; the baker is verifying the funds.',
      payment_verified: 'Payment verified: the baker has confirmed receipt of funds for this order.',
      payment_rejected: 'Payment not verified: last proof could not be verified. Please submit updated details.',
      pay_on_collection: 'Pay in cash upon collection or delivery. No advance payment has been collected yet.'
    };
    var descText = descMap[payStatus] || 'Official payment record for this Mystery Bakebite order.';
    rectFillStroke(18, botTop + 12, 140, 20, 0.35, isPaid ? 232 : 250, isPaid ? 245 : 240, isPaid ? 228 : 218, isPaid ? 112 : 212, isPaid ? 168 : 164, isPaid ? 118 : 55);
    wrapPdfText(descText, 48).slice(0, 2).forEach(function (ln, idx) {
      text('F1', 4.3, 21, botTop + 19.2 + idx * 6.2, ln, 48, 32, 18);
    });

    text('F2', 3.9, 18, botTop + 40, 'PAYMENT METHOD', 138, 102, 42);
    text('F2', 4.8, 18, botTop + 46.2, methodTitle.slice(0, 26), 31, 16, 8);

    text('F2', 3.9, 92, botTop + 40, 'VERIFICATION STATUS', 138, 102, 42);
    text('F2', 4.8, 92, botTop + 46.2, payShort.slice(0, 22), isPaid ? 30 : 142, isPaid ? 98 : 92, isPaid ? 42 : 20);

    text('F2', 3.9, 18, botTop + 55.5, 'TRANSACTION REFERENCE', 138, 102, 42);
    text('F4', 4.6, 18, botTop + 61.7, String(order.paymentRef || 'Not yet recorded').slice(0, 24), 31, 16, 8);

    text('F2', 3.9, 92, botTop + 55.5, 'PREFERRED ORDER DATE', 138, 102, 42);
    text('F2', 4.8, 92, botTop + 61.7, (eventDateFmt || 'Agreed with baker').slice(0, 22), 142, 92, 20);

    var subtotalVal = typeof order.subtotal === 'number' ? order.subtotal : 0;
    var discountVal = Number(order.discount) || 0;
    var deliveryFeeVal = typeof order.deliveryFee === 'number' ? order.deliveryFee : null;
    var totalVal = typeof order.total === 'number' ? order.total : Math.max(0, subtotalVal - discountVal + (deliveryFeeVal || 0));

    var momo = extra.momo || config.momo || config.momo_details || { name: 'Mystery Bakebite', number: '055 452 0532', provider: 'MTN MoMo' };
    var bank = extra.bank || config.bank || config.bank_details || { name: 'GCB Bank', accountName: 'Mystery Bakebite', accountNumber: '9011010048291' };

    var remitText = '';
    if (!isPaid && payMethod === 'momo' && momo && momo.number) {
      remitText = 'MoMo Remittance: Send ' + pdfMoney(totalVal) + ' to ' + momo.number + ' (' + (momo.name || 'Mystery Bakebite') + ') using ref ' + order.ref + '.';
    } else if (!isPaid && payMethod === 'bank_transfer' && bank && bank.accountNumber) {
      remitText = 'Bank Transfer: Send ' + pdfMoney(totalVal) + ' to ' + bank.name + ' Acct ' + bank.accountNumber + ' (' + (bank.accountName || 'Mystery Bakebite') + ') ref ' + order.ref + '.';
    } else if (order.notes) {
      remitText = 'Customer Notes: ' + order.notes;
    } else {
      remitText = 'Present this official receipt and reference ' + order.ref + ' when collecting or receiving your order.';
    }

    rectFillStroke(18, botTop + 68, 140, 30, 0.35, 248, 241, 229, 216, 194, 156);
    wrapPdfText(remitText, 48).slice(0, 3).forEach(function (ln, idx) {
      text('F1', 4.3, 21, botTop + 75.5 + idx * 6.5, ln, 62, 44, 28);
    });

    // Right Box: Financial Summary
    rectFillStroke(166, botTop, 117.5, botH, 0.45, 255, 252, 246, 218, 198, 164);
    text('F2', 4.8, 170, botTop + 8.5, 'FINANCIAL SUMMARY', 31, 16, 8);

    text('F1', 4.8, 170, botTop + 20, 'Subtotal', 78, 60, 44);
    textRight('F2', 4.8, 279.5, botTop + 20, pdfMoney(subtotalVal), 31, 16, 8);
    hLine(170, 279.5, botTop + 24, 0.25, 228, 214, 192);

    text('F1', 4.8, 170, botTop + 32, 'Discounts applied', 78, 60, 44);
    textRight('F2', 4.8, 279.5, botTop + 32, discountVal > 0 ? '- ' + pdfMoney(discountVal) : 'GHS 0.00', discountVal > 0 ? 42 : 78, discountVal > 0 ? 118 : 60, discountVal > 0 ? 54 : 44);
    hLine(170, 279.5, botTop + 36, 0.25, 228, 214, 192);

    var delivLbl = order.fulfilment === 'delivery' ? 'Delivery (Tamale)' : 'Bakery Collection';
    var delivVal = deliveryFeeVal !== null
      ? (deliveryFeeVal === 0 ? 'Complimentary' : pdfMoney(deliveryFeeVal))
      : (order.fulfilment === 'delivery' ? 'Confirmed by baker' : 'GHS 0.00 (Pickup)');
    text('F1', 4.8, 170, botTop + 44, delivLbl, 78, 60, 44);
    textRight('F2', 4.6, 279.5, botTop + 44, delivVal, 31, 16, 8);

    rectFill(170, botTop + 51, 109.5, 20, 36, 18, 9);
    text('F2', 4.6, 174, botTop + 63, 'TOTAL AMOUNT', 245, 230, 214);
    textRight('F2', 6.8, 275.5, botTop + 63.5, pdfMoney(totalVal), 212, 164, 55);

    rectFillStroke(170, botTop + 75, 109.5, 23, 0.35, 248, 241, 229, 212, 164, 55);
    text('F2', 3.9, 174, botTop + 82.5, isPaid ? 'AMOUNT VERIFIED PAID' : 'BALANCE STATUS', 122, 90, 43);
    text('F2', 4.7, 174, botTop + 91.5, pdfMoney(totalVal) + ' (' + (isPaid ? 'Paid in Full' : payShort) + ')', 31, 16, 8);

    // 6. Footer
    hLine(14, 283.64, 385, 0.5, 212, 164, 55);
    text('F2', 4.6, 14, 393.5, 'AUTHENTIC MYSTERY BAKEBITE ORDER RECEIPT', 31, 16, 8);
    text('F1', 4.2, 14, 400.5, 'Because every bite has a story | Tamale, Northern Region, Ghana', 96, 76, 58);
    textRight('F2', 4.3, 283.5, 393.5, '+233 55 452 0532 | mysterybakebites@gmail.com', 96, 76, 58);
    textRight('F1', 4.1, 283.5, 400.5, 'Keep reference ' + order.ref + ' safe. Thank you for your order!', 122, 90, 43);

    var contentStreamBytes = asciiBytes(ops.join('\n'));
    var logoJpegBytes = decodeBase64Bytes(RECEIPT_LOGO_B64);

    var chunks = [];
    var offsets = [0];
    var byteLen = 0;

    function pushStr(s) {
      var b = asciiBytes(s);
      chunks.push(b);
      byteLen += b.length;
    }
    function pushBytes(b) {
      chunks.push(b);
      byteLen += b.length;
    }
    function startObj(id) {
      offsets[id] = byteLen;
      pushStr(id + ' 0 obj\n');
    }
    function endObj() {
      pushStr('\nendobj\n');
    }

    pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    startObj(1);
    pushStr('<< /Type /Catalog /Pages 2 0 R >>');
    endObj();

    startObj(2);
    pushStr('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    endObj();

    startObj(3);
    pushStr('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 297.64 419.53] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R /F4 7 0 R >> /XObject << /ImLogo 8 0 R >> >> /Contents 9 0 R >>');
    endObj();

    startObj(4);
    pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    endObj();

    startObj(5);
    pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    endObj();

    startObj(6);
    pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>');
    endObj();

    startObj(7);
    pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
    endObj();

    startObj(8);
    pushStr('<< /Type /XObject /Subtype /Image /Width 160 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + logoJpegBytes.length + ' >>\nstream\n');
    pushBytes(logoJpegBytes);
    pushStr('\nendstream');
    endObj();

    startObj(9);
    pushStr('<< /Length ' + contentStreamBytes.length + ' >>\nstream\n');
    pushBytes(contentStreamBytes);
    pushStr('\nendstream');
    endObj();

    var xrefPos = byteLen;
    pushStr('xref\n0 10\n0000000000 65535 f \n');
    for (var k = 1; k <= 9; k++) {
      var offStr = String(offsets[k]);
      while (offStr.length < 10) offStr = '0' + offStr;
      pushStr(offStr + ' 00000 n \n');
    }
    pushStr('trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');

    return concatUint8Arrays(chunks);
  }

  function triggerReceiptFileDownload(pdfBytes, filename) {
    if (!pdfBytes || !pdfBytes.length) return false;
    MB._lastDownloadedReceipt = {
      filename: filename,
      byteLength: pdfBytes.length,
      at: new Date().toISOString()
    };
    if (typeof document === 'undefined' || !document.body || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return true;
    }
    try {
      var blob = new Blob([pdfBytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      if (typeof a.click === 'function') a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
        try { URL.revokeObjectURL(url); } catch (_) {}
      }, 2500);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Strictly generates and automatically downloads the official A6 PDF receipt
   * for a product order only (`MB-...`) directly to the user's device.
   */
  MB.downloadReceiptPdf = function (orderOrRef, configOrToken, extra) {
    extra = extra || {};
    if (!orderOrRef) {
      return Promise.resolve({ ok: false, code: 'not_found', error: 'Order is required to download a receipt.' });
    }
    if (typeof orderOrRef === 'object' && orderOrRef.ref) {
      if (!isProductOrderOnly(orderOrRef)) {
        return Promise.resolve({ ok: false, code: 'orders_only', error: 'Receipts are strictly available for product orders only.' });
      }
      var pdfBytes = generateReceiptPdfBytes(orderOrRef, configOrToken || {}, extra);
      var filename = 'Mystery-Bakebite-Order-Receipt-' + String(orderOrRef.ref).trim().toUpperCase() + '.pdf';
      triggerReceiptFileDownload(pdfBytes, filename);
      return Promise.resolve({ ok: true, filename: filename, byteLength: pdfBytes ? pdfBytes.length : 0 });
    }

    var refStr = String(orderOrRef).trim().toUpperCase();
    if (!isProductOrderOnly(refStr)) {
      return Promise.resolve({ ok: false, code: 'orders_only', error: 'Receipts are strictly available for product orders only.' });
    }
    var tokenStr = typeof configOrToken === 'string' ? configOrToken : '';
    var fetchOrder = extra.admin
      ? MB.api('/api/admin/orders/' + encodeURIComponent(refStr))
      : MB.api('/api/orders/' + encodeURIComponent(refStr) + '?token=' + encodeURIComponent(tokenStr));

    return Promise.all([fetchOrder, MB.api('/api/config')]).then(function (out) {
      var res = out[0];
      var cfg = (out[1] && out[1].config) ? out[1].config : {};
      if (!res || !res.ok || !res.order || !isProductOrderOnly(res.order)) {
        return { ok: false, code: (res && res.code) || 'orders_only', error: (res && res.error) || 'Receipt is strictly available for valid product orders only.' };
      }
      var bytes = generateReceiptPdfBytes(res.order, cfg, { momo: res.momo, bank: res.bank });
      var fname = 'Mystery-Bakebite-Order-Receipt-' + res.order.ref + '.pdf';
      triggerReceiptFileDownload(bytes, fname);
      return { ok: true, filename: fname, byteLength: bytes ? bytes.length : 0, order: res.order };
    });
  };

  MB.generateReceiptPdfBytes = generateReceiptPdfBytes;
  MB.isProductOrderOnly = isProductOrderOnly;

  MB.receiptUrl = function (ref, token) {
    return 'receipt.html?ref=' + encodeURIComponent(ref) + '&token=' + encodeURIComponent(token || '') + '&autodownload=1';
  };

  MB.openReceipt = function (ref, token, orderObj, cfgObj) {
    if (orderObj && orderObj.ref) {
      return MB.downloadReceiptPdf(orderObj, cfgObj || {});
    }
    return MB.downloadReceiptPdf(ref, token);
  };

  MB.localIsoDate = localIsoDate;
  MB.formatOrderDate = formatOrderDate;
  MB.defaultPrepDaysForSku = defaultPrepDaysForSku;
  MB.productPrepDays = productPrepDays;

})(window.MB);
