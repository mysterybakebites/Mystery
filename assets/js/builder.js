/* ============================================================
   Mystery Bakebite: custom cake builder with realistic visuals
   Implements the documented cake configuration model:
   classic sizes + decoration levels + flavours + add-ons,
   celebration varieties (from-prices), and quote-required tiers,
   with dynamic realistic photography representing each choice.
   ============================================================ */
(function () {
  'use strict';

  if (!document.getElementById('cake-builder')) return;

  /* ---------- documented pricing & visual data ---------- */
  var SIZES = [
    { id: '5',  label: '5-inch',  serves: '6 to 8 people',   layers: '2 sponge layers',   basic: 150, image: 'assets/img/builder-size-5.webp' },
    { id: '6',  label: '6-inch',  serves: '8 to 12 people',  layers: '2 sponge layers',   basic: 220, image: 'assets/img/builder-size-6.webp' },
    { id: '7',  label: '7-inch',  serves: '12 to 16 people', layers: '2–3 sponge layers', basic: 280, image: 'assets/img/builder-size-7.webp' },
    { id: '8',  label: '8-inch',  serves: '16 to 22 people', layers: '3 sponge layers',   basic: 350, image: 'assets/img/builder-size-8.webp' },
    { id: '10', label: '10-inch', serves: '25 to 32 people', layers: '3 tall layers',     basic: 650, image: 'assets/img/builder-size-10.webp' },
    { id: '12', label: '12-inch', serves: '35 to 45 people', layers: '3–4 sheet layers',  basic: 900, image: 'assets/img/builder-size-12.webp' }
  ];

  var DECOR = {
    basic: {
      label: 'Basic cake',
      note: 'Smooth buttercream coat & neat border',
      image: 'assets/img/builder-decor-basic.webp',
      price: function (s) { return s.basic; }
    },
    simple: {
      label: 'Simple decoration',
      note: 'Piped rosettes, border & classic finish',
      image: 'assets/img/builder-decor-simple.webp',
      price: function (s) { return ({ 5: 180, 6: 250, 7: 320, 8: 400, 10: 750, 12: 1000 })[s.id]; }
    },
    custom: {
      label: 'Custom decoration',
      note: 'Artisan drip, florals or bespoke theme finish',
      image: 'assets/img/builder-decor-custom.webp',
      price: function (s) { return ({ 5: 220, 6: 300, 7: 380, 8: 500, 10: 950, 12: 1300 })[s.id]; }
    }
  };

  var FLAVOURS = [
    { id: 'vanilla',   label: 'Vanilla',    charge: 0,    kind: 'included', swatch: '#F6E7CE', image: 'assets/img/builder-flavour-vanilla.webp',   desc: 'Madagascar vanilla bean sponge' },
    { id: 'banana',    label: 'Banana',     charge: 0,    kind: 'included', swatch: '#EBCE8E', image: 'assets/img/builder-flavour-banana.webp',    desc: 'Moist ripe banana sponge' },
    { id: 'chocolate', label: 'Chocolate',  charge: 20,   kind: 'add',      swatch: '#5B3A22', image: 'assets/img/builder-flavour-chocolate.webp', desc: 'Rich dark cocoa & ganache' },
    { id: 'lemon',     label: 'Lemon',      charge: 20,   kind: 'add',      swatch: '#F0DEA0', image: 'assets/img/builder-flavour-lemon.webp',     desc: 'Zesty lemon sponge & curd' },
    { id: 'marble',    label: 'Marble',     charge: 30,   kind: 'add',      swatch: '#D8C3A8', image: 'assets/img/builder-flavour-marble.webp',    desc: 'Vanilla & chocolate swirl' },
    { id: 'coconut',   label: 'Coconut',    charge: 30,   kind: 'add',      swatch: '#F7F1E4', image: 'assets/img/builder-flavour-coconut.webp',   desc: 'Toasted coconut flake sponge' },
    { id: 'carrot',    label: 'Carrot',     charge: 30,   kind: 'add',      swatch: '#C98246', image: 'assets/img/builder-flavour-carrot.webp',    desc: 'Spiced carrot & walnut crumb' },
    { id: 'redvelvet', label: 'Red velvet', charge: 40,   kind: 'add',      swatch: '#8E2B33', image: 'assets/img/builder-flavour-redvelvet.webp', desc: 'Crimson velvet & cream cheese' },
    { id: 'fruit',     label: 'Fruit cake', charge: null, kind: 'range',    swatch: '#7A4A2B', image: 'assets/img/builder-flavour-fruit.webp',     desc: 'Rich spiced fruit & glaze', range: 'GH\u20B5 50.00 to GH\u20B5 100.00' }
  ];

  var ADDONS = [
    { id: 'writing',   label: 'Birthday writing',              price: 10,   kind: 'fixed', image: 'assets/img/builder-addon-writing.webp' },
    { id: 'piping',    label: 'Extra cream piping',            price: 30,   kind: 'fixed', image: 'assets/img/builder-addon-piping.webp' },
    { id: 'drip',      label: 'Chocolate drip',                price: 40,   kind: 'fixed', image: 'assets/img/builder-addon-drip.webp' },
    { id: 'oreo',      label: 'Oreo or biscuit topping',       price: 30,   kind: 'fixed', image: 'assets/img/builder-addon-oreo.webp' },
    { id: 'choc',      label: 'Chocolate toppings',            price: 40,   kind: 'fixed', image: 'assets/img/builder-addon-choc.webp' },
    { id: 'fruit',     label: 'Fresh fruit decoration',        price: 50,   kind: 'fixed', image: 'assets/img/builder-addon-fruit.webp' },
    { id: 'photo',     label: 'Edible photo or printed image', price: 60,   kind: 'fixed', image: 'assets/img/builder-addon-photo.webp' },
    { id: 'topper',    label: 'Cake topper',                   price: null, kind: 'range', range: 'GH\u20B5 30.00 to GH\u20B5 60.00',      image: 'assets/img/builder-addon-topper.webp' },
    { id: 'fondant',   label: 'Fondant name or message',       price: 50,   kind: 'fixed', image: 'assets/img/builder-addon-fondant.webp' },
    { id: 'fullfond',  label: 'Full fondant covering',         price: null, kind: 'range', range: 'add GH\u20B5 150.00 to GH\u20B5 300.00', image: 'assets/img/builder-addon-fullfond.webp' },
    { id: 'character', label: 'Character or theme design',     price: null, kind: 'range', range: 'add GH\u20B5 100.00 to GH\u20B5 300.00', image: 'assets/img/builder-addon-character.webp' }
  ];

  var VARIETIES = [
    { id: 'bento',     label: 'Bento gift cake',              from: 120,  detail: '4-inch personal-size cake · 2 layers',         image: 'assets/img/cake-bento.webp' },
    { id: 'birthday',  label: 'Classic birthday cake',        from: 180,  detail: '5-inch to 12-inch · piped rosettes & candles', image: 'assets/img/cake-birthday.webp' },
    { id: 'heart',     label: 'Heart-shaped cake',            from: 300,  detail: '6-inch vintage piped heart · 2–3 layers',      image: 'assets/img/cake-heart.webp' },
    { id: 'drip',      label: 'Drip cake',                    from: 350,  detail: '6-inch tall ganache drip & chocolate shards',  image: 'assets/img/cake-drip.webp' },
    { id: 'oreo',      label: 'Oreo cake',                    from: 350,  detail: '6-inch cookies & cream buttercream crown',     image: 'assets/img/cake-oreo.webp' },
    { id: 'chocolate', label: 'Chocolate-loaded cake',        from: 400,  detail: '6-inch rich chocolate truffles & curls',       image: 'assets/img/cake-chocolate.webp' },
    { id: 'fruit',     label: 'Fruit-topped cake',            from: 400,  detail: '6-inch fresh strawberry, kiwi & berry crown',  image: 'assets/img/cake-fruit.webp' },
    { id: 'redvelvet', label: 'Red velvet celebration cake',  from: 400,  detail: '6-inch 3-layer red velvet & cream cheese',     image: 'assets/img/cake-redvelvet.webp' },
    { id: 'photo',     label: 'Photo cake',                   from: 350,  detail: '6-inch edible printed portrait & piped frame', image: 'assets/img/cake-photo.webp' },
    { id: 'number',    label: 'Number milestone cake',        from: 450,  detail: 'Approx. 10-inch sculpted digits & macarons',   image: 'assets/img/cake-number.webp' },
    { id: 'kids',      label: "Kids' character or theme cake", from: 600, detail: '8-inch sculpted figures & custom scene',       image: 'assets/img/cake-kids.webp' },
    { id: 'luxury',    label: 'Luxury custom cake',           from: 1000, detail: '8-inch gold drip, florals & macarons',         image: 'assets/img/cake-lux.webp' },
    { id: 'tier2',     label: 'Two-tier wedding cake',        from: 1500, detail: '8-inch + 6-inch stacked tiers · fresh florals', image: 'assets/img/cake-tier2.webp' },
    { id: 'tier3',     label: 'Three-tier grand wedding cake', from: 2500, detail: '10-inch + 8-inch + 6-inch grand tiers',       image: 'assets/img/cake-tier3.webp' }
  ];

  var TIERS = [
    { id: '1', label: 'Single tier', note: 'Statement 1-tier cake (2–3 sponge layers), priced from size & decoration', quote: false, image: 'assets/img/builder-tier-1.webp', specs: '1 Tier · 2–3 Layers · Serves 8–35' },
    { id: '2', label: 'Two tiers',   note: '8-inch + 6-inch stacked wedding & milestone tiers, quoted by the baker',   quote: true,  from: 1500, image: 'assets/img/cake-tier2.webp', specs: '2 Tiers (8" + 6") · 6 Layers · Serves ~35–45' },
    { id: '3', label: 'Three tiers', note: '10-inch + 8-inch + 6-inch grand celebration tiers, quoted by the baker',   quote: true,  from: 2500, image: 'assets/img/cake-tier3.webp', specs: '3 Tiers (10" + 8" + 6") · 9 Layers · Serves ~70–90' }
  ];

  /* ---------- state ---------- */
  var state = {
    type: 'classic',        // classic | celebration | tiers
    size: '6',
    decor: 'basic',
    flavour: 'vanilla',
    variety: 'birthday',
    tier: '1',
    addons: [],
    writing: ''
  };

  var root = document.getElementById('cake-builder');

  function MBCart() {
    return window.MBCarts ? window.MBCarts.product : window.MBCart;
  }

  var money = function (n) {
    var val = Number(n);
    if (!isFinite(val)) return 'GH\u20B5 0.00';
    var fixed = Math.abs(val).toFixed(2);
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (val < 0 ? '\u2212 ' : '') + 'GH\u20B5 ' + parts.join('.');
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function el(id) { return document.getElementById(id); }

  /* ---------- option rendering with realistic thumbnails ---------- */
  function renderSizes() {
    el('opt-sizes').innerHTML = SIZES.map(function (s) {
      var on = state.size === s.id;
      return '<button type="button" class="opt opt--size opt--card' + (on ? ' is-on' : '') + '" data-size="' + s.id + '" aria-pressed="' + on + '">' +
        '<span class="opt__media">' +
          '<img src="' + esc(s.image) + '" alt="' + esc(s.label) + ' cake size" loading="lazy">' +
          '<span class="opt__badge">' + esc(s.id) + '&Prime;</span>' +
        '</span>' +
        '<span class="opt__content">' +
          '<span class="opt__title">' + esc(s.label) + '</span>' +
          '<span class="opt__sub">' + esc(s.layers) + ' &middot; ' + esc(s.serves) + '</span>' +
          '<span class="opt__price">' + money(s.basic) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  function renderDecor() {
    el('opt-decor').innerHTML = Object.keys(DECOR).map(function (k) {
      var d = DECOR[k];
      var size = SIZES.filter(function (s) { return s.id === state.size; })[0];
      var on = state.decor === k;
      return '<button type="button" class="opt opt--decor opt--card' + (on ? ' is-on' : '') + '" data-decor="' + k + '" aria-pressed="' + on + '">' +
        '<span class="opt__media">' +
          '<img src="' + esc(d.image) + '" alt="' + esc(d.label) + '" loading="lazy">' +
        '</span>' +
        '<span class="opt__content">' +
          '<span class="opt__title">' + esc(d.label) + '</span>' +
          '<span class="opt__sub">' + esc(d.note) + '</span>' +
          '<span class="opt__price">' + money(d.price(size)) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  function renderFlavours() {
    el('opt-flavours').innerHTML = FLAVOURS.map(function (f) {
      var on = state.flavour === f.id;
      var price = f.kind === 'included' ? 'Included' : (f.kind === 'range' ? f.range : '+' + money(f.charge));
      return '<button type="button" class="opt opt--flavour' + (on ? ' is-on' : '') + '" data-flavour="' + f.id + '" aria-pressed="' + on + '">' +
        '<span class="opt__thumb">' +
          '<img src="' + esc(f.image) + '" alt="' + esc(f.label) + ' sponge flavour" loading="lazy">' +
          '<span class="opt__swatch" style="background:' + f.swatch + '"></span>' +
        '</span>' +
        '<span class="opt__info">' +
          '<span class="opt__title">' + esc(f.label) + '</span>' +
          '<span class="opt__sub">' + esc(f.desc) + '</span>' +
          '<span class="opt__price' + (f.kind === 'range' ? ' is-range' : '') + '">' + price + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  function renderAddons() {
    el('opt-addons').innerHTML = ADDONS.map(function (a) {
      var on = state.addons.indexOf(a.id) !== -1;
      var price = a.kind === 'range' ? a.range : '+' + money(a.price);
      return '<button type="button" class="opt opt--addon' + (on ? ' is-on' : '') + '" data-addon="' + a.id + '" aria-pressed="' + on + '">' +
        '<span class="opt__check" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>' +
        '</span>' +
        '<img class="opt__addon-img" src="' + esc(a.image) + '" alt="' + esc(a.label) + '" loading="lazy">' +
        '<span class="opt__info">' +
          '<span class="opt__title">' + esc(a.label) + '</span>' +
          '<span class="opt__price' + (a.kind === 'range' ? ' is-range' : '') + '">' + price + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  function renderVarieties() {
    el('opt-varieties').innerHTML = VARIETIES.map(function (v) {
      var on = state.variety === v.id;
      var pct = Number(v.discountPct) > 0 ? Math.round(Number(v.discountPct)) : 0;
      var baseFrom = v.baseFrom || v.from;
      var netFrom = pct > 0 ? Math.round(baseFrom * (100 - pct) / 100) : baseFrom;
      return '<button type="button" class="opt opt--variety opt--card' + (on ? ' is-on' : '') + '" data-variety="' + v.id + '" aria-pressed="' + on + '">' +
        '<span class="opt__media">' +
          '<img src="' + esc(v.image) + '" alt="' + esc(v.label) + '" loading="lazy">' +
          (pct > 0 ? '<span class="opt__badge">\u2212' + pct + '%</span>' : '') +
        '</span>' +
        '<span class="opt__content">' +
          '<span class="opt__title">' + esc(v.label) + '</span>' +
          '<span class="opt__sub">' + esc(v.detail) + '</span>' +
          '<span class="opt__price">from ' +
            (pct > 0 ? '<s style="opacity:.55;margin-right:4px">' + money(baseFrom) + '</s>' + money(netFrom) : money(baseFrom)) +
          '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  function renderTiers() {
    el('opt-tiers').innerHTML = TIERS.map(function (t) {
      var on = state.tier === t.id;
      return '<button type="button" class="opt opt--tier opt--card' + (on ? ' is-on' : '') + '" data-tier="' + t.id + '" aria-pressed="' + on + '">' +
        '<span class="opt__media">' +
          '<img src="' + esc(t.image) + '" alt="' + esc(t.label) + '" loading="lazy">' +
          '<span class="opt__badge">' + esc(t.id) + (t.id === '1' ? ' Tier' : ' Tiers') + '</span>' +
        '</span>' +
        '<span class="opt__content">' +
          '<span class="opt__title">' + esc(t.label) + '</span>' +
          '<span class="opt__sub">' + esc(t.note) + '</span>' +
          '<span class="opt__price' + (t.quote ? ' is-range' : '') + '">' + (t.from ? 'from ' + money(t.from) : 'Priced by size') + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
  }

  /* ---------- panels visibility ---------- */
  function refreshPanels() {
    var isClassic = state.type === 'classic';
    var isCeleb = state.type === 'celebration';
    var isTiers = state.type === 'tiers';

    el('panel-classic').hidden = !isClassic;
    el('panel-celebration').hidden = !isCeleb;
    el('panel-tiers').hidden = !isTiers;

    Array.prototype.forEach.call(root.querySelectorAll('[data-type]'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-type') === state.type);
      b.setAttribute('aria-pressed', b.getAttribute('data-type') === state.type);
    });

    if (isClassic) { renderSizes(); renderDecor(); renderFlavours(); renderAddons(); }
    if (isCeleb) renderVarieties();
    if (isTiers) renderTiers();
  }

  /* ---------- calculation ---------- */
  function currentSize() {
    return SIZES.filter(function (s) { return s.id === state.size; })[0] || SIZES[1];
  }

  function calculate() {
    if (state.type === 'celebration') {
      var v = VARIETIES.filter(function (x) { return x.id === state.variety; })[0] || VARIETIES[0];
      var pct = Number(v.discountPct) > 0 ? Math.round(Number(v.discountPct)) : 0;
      var baseFrom = v.baseFrom || v.from;
      var netFrom = pct > 0 ? Math.round(baseFrom * (100 - pct) / 100) : baseFrom;
      var parts = [{ label: v.label, amount: baseFrom }];
      if (pct > 0) {
        parts.push({ label: 'Discount (' + pct + '% off)', amount: -(baseFrom - netFrom) });
      }
      return {
        total: netFrom,
        originalTotal: baseFrom,
        discountPct: pct,
        from: true,
        label: 'from ' + money(netFrom),
        base: baseFrom,
        flavour: 0,
        addons: 0,
        pending: false,
        headline: pct > 0 ? 'Starting price (\u2212' + pct + '% off)' : 'Starting price',
        parts: parts
      };
    }

    if (state.type === 'tiers') {
      var t = TIERS.filter(function (x) { return x.id === state.tier; })[0] || TIERS[0];
      if (t.quote) {
        return {
          total: t.from, from: true, quote: true,
          label: 'from ' + money(t.from),
          base: t.from, flavour: 0, addons: 0, pending: true,
          headline: 'Quoted by the baker',
          parts: [{ label: t.label + ' wedding cake', amount: t.from }]
        };
      }
      return { total: 0, quote: true, label: 'Quoted by the baker', pending: true, headline: 'Quoted by the baker', parts: [] };
    }

    var size = currentSize();
    var base = DECOR[state.decor].price(size);
    var flavour = FLAVOURS.filter(function (f) { return f.id === state.flavour; })[0] || FLAVOURS[0];
    var flavourCharge = typeof flavour.charge === 'number' ? flavour.charge : 0;

    var addonTotal = 0;
    var pending = false;
    var parts = [{ label: size.label + ' ' + DECOR[state.decor].label.toLowerCase(), amount: base }];

    if (flavour.charge === null) {
      pending = true;
      parts.push({ label: flavour.label + ' (board rate ' + flavour.range + ')', amount: null });
    } else if (flavourCharge > 0) {
      parts.push({ label: flavour.label + ' flavour', amount: flavourCharge });
    }

    state.addons.forEach(function (id) {
      var a = ADDONS.filter(function (x) { return x.id === id; })[0];
      if (!a) return;
      if (a.kind === 'range') {
        pending = true;
        parts.push({ label: a.label + ' (' + a.range + ')', amount: null });
      } else {
        addonTotal += a.price;
        parts.push({ label: a.label, amount: a.price });
      }
    });

    var total = base + flavourCharge + addonTotal;
    return {
      total: total,
      from: false,
      quote: false,
      pending: pending,
      label: money(total) + (pending ? ' +' : ''),
      headline: pending ? 'Estimate, some items to confirm' : 'Estimated total',
      base: base, flavour: flavourCharge, addons: addonTotal, parts: parts
    };
  }

  /* ---------- dynamic realistic visualizer ---------- */
  function resolvePreviewVisuals() {
    var has = function (id) { return state.addons.indexOf(id) !== -1; };

    if (state.type === 'celebration') {
      var v = VARIETIES.filter(function (x) { return x.id === state.variety; })[0] || VARIETIES[0];
      var vTiers = v.id === 'tier3' ? '3 Tiers' : (v.id === 'tier2' ? '2 Tiers' : '1 Tier · 2–3 Layers');
      return {
        heroImg: v.image,
        heroTitle: v.label,
        heroBadge: vTiers,
        pips: [],
        specs: [
          { key: 'style', label: 'Style', value: v.label, img: v.image },
          { key: 'structure', label: 'Structure', value: vTiers, img: v.id === 'tier3' ? 'assets/img/cake-tier3.webp' : (v.id === 'tier2' ? 'assets/img/cake-tier2.webp' : 'assets/img/builder-tier-1.webp') },
          { key: 'spec', label: 'Specification', value: v.detail, img: 'assets/img/custom-celebration-cakes.webp' }
        ],
        addons: [],
        writing: ''
      };
    }

    if (state.type === 'tiers') {
      var t = TIERS.filter(function (x) { return x.id === state.tier; })[0] || TIERS[0];
      return {
        heroImg: t.image,
        heroTitle: t.label + ' Celebration Cake',
        heroBadge: t.id + (t.id === '1' ? ' Tier' : ' Stacked Tiers'),
        pips: [],
        specs: [
          { key: 'tiers', label: 'Tiers', value: t.label, img: t.image },
          { key: 'props', label: 'Proportions', value: t.specs, img: 'assets/img/wedding-engagement-cakes.webp' },
          { key: 'finish', label: 'Finish', value: 'Bespoke floral & fondant finish', img: 'assets/img/cake-lux.webp' }
        ],
        addons: [],
        writing: ''
      };
    }

    // Classic custom cake: dynamically choose the most accurate realistic cake photograph
    var size = currentSize();
    var decor = DECOR[state.decor] || DECOR.basic;
    var flavour = FLAVOURS.filter(function (f) { return f.id === state.flavour; })[0] || FLAVOURS[0];
    var chosenAddons = state.addons.map(function (id) {
      return ADDONS.filter(function (a) { return a.id === id; })[0];
    }).filter(Boolean);

    var exteriorImg = size.image;
    if (has('character')) {
      exteriorImg = 'assets/img/cake-kids.webp';
    } else if (has('photo')) {
      exteriorImg = 'assets/img/cake-photo.webp';
    } else if (has('fullfond')) {
      exteriorImg = 'assets/img/builder-addon-fullfond.webp';
    } else if (has('fruit')) {
      exteriorImg = 'assets/img/cake-fruit.webp';
    } else if (has('oreo')) {
      exteriorImg = 'assets/img/cake-oreo.webp';
    } else if (has('drip')) {
      exteriorImg = 'assets/img/cake-drip.webp';
    } else if (has('choc')) {
      exteriorImg = 'assets/img/cake-chocolate.webp';
    } else if (has('topper')) {
      exteriorImg = 'assets/img/cake-naming.webp';
    } else if (has('fondant')) {
      exteriorImg = 'assets/img/cake-grad.webp';
    } else if (has('piping')) {
      exteriorImg = 'assets/img/cake-heart.webp';
    } else if (state.decor === 'custom') {
      exteriorImg = decor.image;
    } else if (state.decor === 'simple') {
      exteriorImg = decor.image;
    } else {
      exteriorImg = size.image;
    }

    var heroImg = exteriorImg;
    var heroTitle = size.label + ' ' + decor.label + ' · ' + flavour.label;
    if (state.stageFocus === 'size') {
      heroImg = size.image;
      heroTitle = size.label + ' (' + size.layers + ' · Serves ' + size.serves + ')';
    } else if (state.stageFocus === 'decor') {
      heroImg = decor.image;
      heroTitle = decor.label + ' · ' + decor.note;
    } else if (state.stageFocus === 'flavour') {
      heroImg = flavour.image;
      heroTitle = flavour.label + ' Sponge Cutaway · ' + flavour.desc;
    } else if (state.stageFocus && state.stageFocus.indexOf('addon:') === 0) {
      var focusAddonId = state.stageFocus.split(':')[1];
      var focusAddon = ADDONS.filter(function (a) { return a.id === focusAddonId; })[0];
      if (focusAddon) {
        heroImg = focusAddon.image;
        heroTitle = focusAddon.label + ' Detail';
      }
    }

    var inscription = state.writing || (has('writing') ? 'Happy Birthday' : '');

    return {
      heroImg: heroImg,
      heroTitle: heroTitle,
      heroBadge: size.label + ' · ' + size.layers,
      pips: [
        { key: 'size', label: size.label, img: size.image, active: state.stageFocus === 'size' || !state.stageFocus },
        { key: 'decor', label: decor.label, img: decor.image, active: state.stageFocus === 'decor' },
        { key: 'flavour', label: flavour.label + ' inside', img: flavour.image, swatch: flavour.swatch, active: state.stageFocus === 'flavour' }
      ],
      specs: [
        { key: 'size', label: 'Size & Layers', value: size.label + ' (' + size.layers + ')', sub: 'Serves ' + size.serves, img: size.image, active: state.stageFocus === 'size' },
        { key: 'decor', label: 'Icing & Finish', value: decor.label, sub: decor.note, img: decor.image, active: state.stageFocus === 'decor' },
        { key: 'flavour', label: 'Sponge Flavour', value: flavour.label, sub: flavour.desc, img: flavour.image, swatch: flavour.swatch, active: state.stageFocus === 'flavour' }
      ],
      addons: chosenAddons,
      writing: inscription
    };
  }

  function previewMarkup() {
    var vis = resolvePreviewVisuals();

    var specsHtml = vis.specs.map(function (s) {
      return '<button type="button" class="cake-vis__spec' + (s.active ? ' is-active' : '') + '" data-stage-focus="' + esc(s.key || '') + '" title="Click to preview ' + esc(s.value) + '">' +
        '<div class="cake-vis__spec-media">' +
          '<img src="' + esc(s.img) + '" alt="' + esc(s.value) + '" loading="lazy">' +
          (s.swatch ? '<span class="cake-vis__swatch" style="background:' + s.swatch + '"></span>' : '') +
        '</div>' +
        '<div class="cake-vis__spec-txt">' +
          '<span class="cake-vis__spec-lbl">' + esc(s.label) + '</span>' +
          '<strong class="cake-vis__spec-val">' + esc(s.value) + '</strong>' +
        '</div>' +
      '</button>';
    }).join('');

    var addonsHtml = vis.addons.length
      ? '<div class="cake-vis__addons">' +
          '<span class="cake-vis__addons-lbl">Selected decorations &amp; add-ons (' + vis.addons.length + ')</span>' +
          '<div class="cake-vis__addons-list">' +
            vis.addons.map(function (a) {
              var isAddonFocus = state.stageFocus === ('addon:' + a.id);
              return '<button type="button" class="cake-vis__chip' + (isAddonFocus ? ' is-active' : '') + '" data-stage-focus="addon:' + esc(a.id) + '" title="Preview ' + esc(a.label) + '">' +
                '<img src="' + esc(a.image) + '" alt="" loading="lazy">' +
                '<span>' + esc(a.label) + '</span>' +
              '</button>';
            }).join('') +
          '</div>' +
        '</div>'
      : '';

    var writingHtml = vis.writing
      ? '<div class="cake-vis__plaque" aria-label="Cake inscription preview">' +
          '<span class="cake-vis__plaque-lbl">Piped inscription</span>' +
          '<span class="cake-vis__plaque-txt">&ldquo;' + esc(vis.writing) + '&rdquo;</span>' +
        '</div>'
      : '';

    return '' +
      '<div class="cake-vis">' +
        '<div class="cake-vis__stage">' +
          '<img class="cake-vis__hero" src="' + esc(vis.heroImg) + '" alt="' + esc(vis.heroTitle) + '" loading="eager">' +
          '<div class="cake-vis__badges">' +
            '<span class="cake-vis__badge">' + esc(vis.heroBadge) + '</span>' +
            '<span class="cake-vis__badge cake-vis__badge--gold">' + esc(vis.heroTitle) + '</span>' +
          '</div>' +
        '</div>' +
        writingHtml +
        '<div class="cake-vis__grid">' + specsHtml + '</div>' +
        addonsHtml +
      '</div>';
  }

  /* ---------- summary ---------- */
  function summaryMeta() {
    if (state.type === 'celebration') {
      var v = VARIETIES.filter(function (x) { return x.id === state.variety; })[0] || VARIETIES[0];
      return v.label + ' · ' + v.detail;
    }
    if (state.type === 'tiers') {
      var t = TIERS.filter(function (x) { return x.id === state.tier; })[0] || TIERS[0];
      return t.label + ' (' + t.specs + ')' + (t.quote ? ' · quoted by the baker' : '');
    }
    var size = currentSize();
    var flv = FLAVOURS.filter(function (f) { return f.id === state.flavour; })[0] || FLAVOURS[0];
    var bits = [size.label + ' (' + size.layers + ')', DECOR[state.decor].label.toLowerCase(), flv.label + ' sponge'];
    if (state.addons.length) {
      bits.push(state.addons.map(function (id) {
        return ADDONS.filter(function (a) { return a.id === id; })[0].label.toLowerCase();
      }).join(', '));
    }
    if (state.writing) bits.push('writing: "' + state.writing + '"');
    return bits.join(' · ');
  }

  function renderSummary() {
    var calc = calculate();
    el('cake-preview').innerHTML = previewMarkup();
    el('cake-meta').textContent = summaryMeta();

    el('cake-breakdown').innerHTML = calc.parts.map(function (p) {
      return '<li><span>' + esc(p.label) + '</span><span class="' + (p.amount === null ? 'is-pending' : '') + '">' +
        (p.amount === null ? 'To confirm' : money(p.amount)) + '</span></li>';
    }).join('') || '<li><span>Configuration</span><span>Quoted by the baker</span></li>';

    el('cake-price').textContent = calc.label;
    el('cake-price-label').textContent = calc.headline;

    var note = el('cake-note');
    var prepDays = 1;
    if (state.type === 'celebration') {
      var curV = VARIETIES.filter(function (x) { return x.id === state.variety; })[0];
      if (curV && typeof curV.prepDays === 'number' && curV.prepDays > 0) prepDays = curV.prepDays;
    }
    var prepAdvice = ' Recommended: order at least ' + prepDays + ' ' + (prepDays === 1 ? 'day' : 'days') + ' ahead.';

    if (calc.quote) {
      note.textContent = 'Wedding and multi-tier cakes are quoted once the baker has your event date, serving needs, flavours and a design reference.' + prepAdvice;
      note.hidden = false;
    } else if (calc.pending) {
      note.textContent = 'Items marked "To confirm" are priced by the baker, so they are not included in the estimate above.' + prepAdvice;
      note.hidden = false;
    } else if (calc.from) {
      note.textContent = 'This is the starting price for this cake. The final price depends on design and specifications.' + prepAdvice;
      note.hidden = false;
    } else {
      note.textContent = 'This is a starting estimate, not a quotation. The baker confirms the final price before work begins.' + prepAdvice;
      note.hidden = false;
    }

    el('cake-add').disabled = false;
  }

  function renderAll() {
    refreshPanels();
    renderSummary();
  }

  /* ---------- bindings ---------- */
  root.addEventListener('click', function (e) {
    var focusBtn = e.target.closest('[data-stage-focus]');
    if (focusBtn) {
      var nextFocus = focusBtn.getAttribute('data-stage-focus') || '';
      state.stageFocus = (state.stageFocus === nextFocus) ? '' : nextFocus;
      renderSummary();
      var vBox = el('cake-preview') && el('cake-preview').querySelector('.cake-vis');
      if (vBox) {
        vBox.classList.remove('is-swapping');
        void vBox.offsetWidth;
        vBox.classList.add('is-swapping');
      }
      return;
    }

    var t = e.target.closest('[data-type],[data-size],[data-decor],[data-flavour],[data-addon],[data-variety],[data-tier]');
    if (!t) return;

    if (t.hasAttribute('data-type')) {
      state.type = t.getAttribute('data-type');
      state.stageFocus = '';
    } else if (t.hasAttribute('data-size')) {
      state.size = t.getAttribute('data-size');
      state.stageFocus = 'size';
    } else if (t.hasAttribute('data-decor')) {
      state.decor = t.getAttribute('data-decor');
      state.stageFocus = 'decor';
    } else if (t.hasAttribute('data-flavour')) {
      state.flavour = t.getAttribute('data-flavour');
      state.stageFocus = 'flavour';
    } else if (t.hasAttribute('data-variety')) {
      state.variety = t.getAttribute('data-variety');
      state.stageFocus = '';
    } else if (t.hasAttribute('data-tier')) {
      state.tier = t.getAttribute('data-tier');
      state.stageFocus = '';
    } else if (t.hasAttribute('data-addon')) {
      var id = t.getAttribute('data-addon');
      var idx = state.addons.indexOf(id);
      if (idx === -1) {
        state.addons.push(id);
        state.stageFocus = 'addon:' + id;
      } else {
        state.addons.splice(idx, 1);
        state.stageFocus = '';
      }
    }
    renderAll();

    var visBox = el('cake-preview') && el('cake-preview').querySelector('.cake-vis');
    if (visBox) {
      visBox.classList.remove('is-swapping');
      void visBox.offsetWidth;
      visBox.classList.add('is-swapping');
    }
    var priceEl = el('cake-price');
    if (priceEl) {
      priceEl.classList.remove('mb-price-flash');
      void priceEl.offsetWidth;
      priceEl.classList.add('mb-price-flash');
    }
  });

  var writingInput = el('cake-writing');
  if (writingInput) {
    writingInput.addEventListener('input', function () {
      state.writing = writingInput.value.trim();
      renderSummary();
    });
  }

  el('cake-add').addEventListener('click', function () {
    var calc = calculate();
    var meta = summaryMeta();
    var vis = resolvePreviewVisuals();
    var name = state.type === 'celebration'
      ? 'Custom cake: ' + VARIETIES.filter(function (x) { return x.id === state.variety; })[0].label
      : state.type === 'tiers'
        ? 'Custom cake: ' + TIERS.filter(function (x) { return x.id === state.tier; })[0].label
        : 'Custom cake: ' + currentSize().label + ' ' + DECOR[state.decor].label.toLowerCase();

    var spec = {
      type: state.type, size: state.size, decor: state.decor, flavour: state.flavour,
      variety: state.variety, tier: state.tier, addons: state.addons.slice(), writing: state.writing
    };

    var itemPrepDays = 1;
    if (state.type === 'celebration') {
      var selVar = VARIETIES.filter(function (x) { return x.id === state.variety; })[0];
      if (selVar && typeof selVar.prepDays === 'number' && selVar.prepDays > 0) itemPrepDays = selVar.prepDays;
    }

    // prices are whole cedis in the builder; the cart holds pesewas
    if (calc.quote && !calc.total) {
      MBCart().add({
        id: 'custom-' + Date.now(),
        kind: 'custom',
        name: name,
        meta: meta,
        image: vis.heroImg,
        unitPrice: null,
        prepDays: itemPrepDays,
        qty: 1,
        spec: spec
      });
    } else {
      var origPesewas = Math.round((calc.originalTotal || calc.total) * 100);
      MBCart().add({
        id: 'custom-' + Date.now(),
        kind: 'custom',
        name: name,
        meta: meta + (calc.from ? ' (from price)' : ''),
        image: vis.heroImg,
        unitPrice: origPesewas,
        originalPrice: origPesewas,
        discountPct: calc.discountPct || 0,
        prepDays: itemPrepDays,
        qty: 1,
        spec: spec
      });
    }
    MBCart().open('product');
  });

  /* reset */
  var reset = el('cake-reset');
  if (reset) {
    reset.addEventListener('click', function () {
      state = { type: 'classic', size: '6', decor: 'basic', flavour: 'vanilla', variety: 'birthday', tier: '1', addons: [], writing: '' };
      if (writingInput) writingInput.value = '';
      renderAll();
    });
  }

  function syncBuilderDiscounts() {
    if (!window.MB || typeof window.MB.api !== 'function') return;
    window.MB.api('/api/catalogue').then(function (d) {
      if (!d || !d.ok || !Array.isArray(d.products)) return;
      var bySku = {};
      d.products.forEach(function (p) { bySku[String(p.sku || '').toLowerCase()] = p; });
      VARIETIES.forEach(function (v) {
        if (!v.baseFrom) v.baseFrom = v.from;
        var p = bySku[v.id.toLowerCase()];
        if (p) {
          if (typeof p.price === 'number') v.baseFrom = p.price / 100;
          v.discountPct = Number(p.discountPct) > 0 ? Math.round(Number(p.discountPct)) : 0;
          if (p.prepDays !== undefined && p.prepDays !== null) {
            v.prepDays = Math.max(1, Math.round(Number(p.prepDays) || 1));
          }
        }
      });
      renderAll();
    }).catch(function () {});
  }

  renderAll();
  syncBuilderDiscounts();
  window.addEventListener('mb-catalogue-updated', syncBuilderDiscounts);
  window.addEventListener('storage', function (e) {
    if (e.key === 'mb-local-db-v1') syncBuilderDiscounts();
  });
})();
