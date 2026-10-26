-- =============================================================================
-- Mystery Bakebite — Catalogue repair and seed
-- Target: Supabase PostgreSQL 15+
-- Depends on: 20261022 (tables), 20261024 (api_catalogue)
--
-- WHY THIS EXISTS — the measured root cause of "courses are not loading"
--
--   Two independent faults were found by probing the live project on 2026-10-25:
--
--   FAULT 1 — the RPC did not exist.
--     POST /rest/v1/rpc/api_catalogue returned
--       PGRST202  "Could not find the function public.api_catalogue"
--     so classes.js took its error branch and rendered
--       "Courses could not be loaded."
--     The function s shipped in 20261024 never reached the live project.
--
--   FAULT 2 — the tables were empty.
--     Direct REST reads returned HTTP 200 with an empty array for every table:
--       classes 0 rows, products 0 rows, categories 0 rows, cake_options 0 rows
--     This is NOT Row Level Security hiding rows. public.cake_options has a
--     policy of USING (TRUE) with no published filter, and it still returned
--     zero rows, which a policy cannot do. The tables simply have no data.
--     So even with the RPC in place the page would have rendered an empty list.
--
--   FAULT 3 — bringNote was dropped on the way out.
--     classes.js renders c.bringNote, but public.classes had no such column and
--     api_catalogue() never emitted the key, so that paragraph would have been
--     blank even with data present.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds classes.bring_note (idempotent).
--   2. Redefines api_catalogue() to emit bringNote.
--   3. Seeds categories, products, classes and cake_options with the bakery's
--      OWN published catalogue, read from the LOCAL_SEED block in
--      assets/js/supabase.js — the same six courses and 53 products the site
--      was already displaying in local mode.
--
-- THIS IS NOT INVENTED DATA
--   Every row below is a faithful copy of the existing catalogue: same skus,
--   same prices in pesewas, same class fees, same recipe lists. Nothing was
--   added, renamed, repriced or invented to make the page "look working".
--   The seed is idempotent (ON CONFLICT DO NOTHING), so running it a second
--   time changes nothing and it will never overwrite an admin's later edit.
--
--   If the bakery has since changed a price in the dashboard, this migration
--   will NOT revert it — ON CONFLICT DO NOTHING leaves existing rows alone.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. classes.bring_note — the "what to bring" note the class card renders
-- -----------------------------------------------------------------------------
ALTER TABLE public.classes ADD COLUMN IF NOT EXISTS bring_note TEXT NOT NULL DEFAULT '';

-- -----------------------------------------------------------------------------
-- 2. api_catalogue() — now emits bringNote
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_catalogue()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'ok', TRUE,

    'categories', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'slug',      c.slug,
        'name',      c.name,
        'intro',     c.intro,
        'published', c.published,
        'sortOrder', c.sort_order
      ) ORDER BY c.sort_order, c.slug)
      FROM public.categories c
      WHERE c.published IS NOT FALSE
    ), '[]'::jsonb),

    'products', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'sku',         p.sku,
        'name',        p.name,
        'category',    p.category,
        'price',       p.price,          -- NULL means "quoted on request"
        'discountPct', coalesce(p.discount_pct, 0),
        'prepDays',    coalesce(p.prep_days, 0),
        'meta',        p.meta,
        'description', p.description,
        'image',       p.image,
        'published',   p.published
      ) ORDER BY p.category, p.sku)
      FROM public.products p
      WHERE p.published IS NOT FALSE
    ), '[]'::jsonb),

    'classes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'slug',        k.slug,
        'track',       k.track,
        'level',       k.level,
        'levelLabel',  k.level_label,
        'name',        k.name,
        'summary',     k.summary,
        'description', k.description,
        'fee',         k.fee,
        'hours',       k.hours,
        'schedule',    k.schedule,
        'recipes',     k.recipes,
        'skills',      k.skills,
        'provided',    k.provided,
        'bring',       k.bring,
        'bringNote',   coalesce(k.bring_note, ''),
        'prereq',      k.prereq,
        'published',   k.published
      ) ORDER BY k.track, k.level)
      FROM public.classes k
      WHERE k.published IS NOT FALSE
    ), '[]'::jsonb),

    -- Cake builder options, grouped by kind:
    --   { "size": [{key,label,price}], "decor": [{key,label,charges:{...}}], ... }
    'options', coalesce((
      SELECT jsonb_object_agg(o.kind, o.items)
      FROM (
        SELECT
          co.kind,
          jsonb_agg(
            jsonb_build_object('key', co.key, 'label', co.label) || coalesce(co.payload, '{}'::jsonb)
            ORDER BY co.key
          ) AS items
        FROM public.cake_options co
        GROUP BY co.kind
      ) o
    ), '{}'::jsonb),

    'config', (public.api_config())->'config'
  );
$$;
-- -----------------------------------------------------------------------------
-- 3. Seed. The payload is a single JSONB document so the SQL stays compact and
--    every string is escaped exactly once.
-- -----------------------------------------------------------------------------
DO $$
-- JSON payload, assembled from the site's published catalogue.
DECLARE
  v_src JSONB;
  rec   JSONB;
BEGIN
  v_src := (
    '{"categories":[{"slug":"milky-doughnuts","name":"Milky Doughnuts","intro":"Soft, creamy and fresh, made in small batches.","published":true,"sort_order":0},{"slug":"mini-doughnuts","name":"Mini Doughnuts & Doughnut Balls","intro":"Bite-sized, finished with chocolate syrup.","published":true,"sort_order":1},{"slug":"cake-slices","name":"Cake Slices","intro":"A slice, a tasting box, or a full flavour box.","published":true,"sort_order":2},{"slug":"cake-loaves","name":"Loaves & Bread","intro":"Banana and vanilla loaves, plain or topped.","published":true,"sort_order":3},{"slug":"cookies","name":"Cookies","intro":"Chocolate and butter cookies, packed to gift or share.","published":true,"sort_order":4},{"slug":"cupcakes","name":"Cupcakes","intro":"Iced and finished by hand, in boxes of six, eight or twelve.","published":true,"sort_order":5},{"slug":"parfait","name":"Parfait","intro":"Layered cake parfait by the cup or the bowl.","published":true,"sort_order":6},{"slug":"chips","name":"Chips","intro":"Fried or baked, in three sizes, for an everyday savoury order.","published":true,"sort_order":7},{"slug":"celebration","name":"Celebration Cakes","intro":"Fourteen varieties, from a bento gift cake to a three-tier wedding cake. Add one to your cart and the baker confirms the final design and price with you.","published":true,"sort_order":8}],"products":[{"sku":"milky-2","name":"Milky donuts, 2 pcs","category":"milky-doughnuts","price":3000,"discount_pct":0,"prep_days":0,"meta":"2 pieces","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"milky-3","name":"Milky donuts, 3 pcs","category":"milky-doughnuts","price":4200,"discount_pct":0,"prep_days":0,"meta":"3 pieces","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"milky-6","name":"Milky donuts, 6 pcs","category":"milky-doughnuts","price":7500,"discount_pct":0,"prep_days":0,"meta":"Half dozen","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"milky-12","name":"Milky donuts, 12 pcs","category":"milky-doughnuts","price":14000,"discount_pct":0,"prep_days":1,"meta":"Dozen","description":"","image":"milky-doughnuts-new.webp","published":true},{"sku":"mini-10","name":"Mini donuts, pack of 10","category":"mini-doughnuts","price":3500,"discount_pct":0,"prep_days":0,"meta":"Pack of 10","description":"","image":"hero-doughnut.webp","published":true},{"sku":"balls-12","name":"Mini donut balls, pack of 12","category":"mini-doughnuts","price":3000,"discount_pct":0,"prep_days":0,"meta":"Pack of 12","description":"","image":"hero-doughnut.webp","published":true},{"sku":"balls-25","name":"Mini donut balls, pack of 25","category":"mini-doughnuts","price":5500,"discount_pct":0,"prep_days":0,"meta":"Pack of 25","description":"","image":"hero-doughnut.webp","published":true},{"sku":"slice-classic","name":"Classic slice","category":"cake-slices","price":3500,"discount_pct":0,"prep_days":0,"meta":"One slice","description":"","image":"prod-slices.w'
    || 'ebp","published":true},{"sku":"slice-signature","name":"Signature slice","category":"cake-slices","price":4000,"discount_pct":0,"prep_days":0,"meta":"One slice","description":"","image":"prod-slices.webp","published":true},{"sku":"tasting-box","name":"Tasting box, 4 half-slices","category":"cake-slices","price":7000,"discount_pct":0,"prep_days":1,"meta":"4 half-slices","description":"","image":"prod-slices.webp","published":true},{"sku":"flavour-box","name":"Full flavour box, 4 full slices","category":"cake-slices","price":13000,"discount_pct":0,"prep_days":1,"meta":"4 full slices","description":"","image":"prod-slices.webp","published":true},{"sku":"banana-small-plain","name":"Banana loaf, small, plain","category":"cake-loaves","price":3500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"banana-small-topped","name":"Banana loaf, small, topped","category":"cake-loaves","price":4500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"banana-big-plain","name":"Banana loaf, big, plain","category":"cake-loaves","price":7000,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"banana-big-topped","name":"Banana loaf, big, topped","category":"cake-loaves","price":8500,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-small-plain","name":"Vanilla loaf, small, plain","category":"cake-loaves","price":3500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-small-topped","name":"Vanilla loaf, small, topped","category":"cake-loaves","price":4500,"discount_pct":0,"prep_days":1,"meta":"Small","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-big-plain","name":"Vanilla loaf, big, plain","category":"cake-loaves","price":6500,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"vanilla-big-topped","name":"Vanilla loaf, big, topped","category":"cake-loaves","price":8000,"discount_pct":0,"prep_days":1,"meta":"Big","description":"","image":"prod-loaves.webp","published":true},{"sku":"choc-cookies-4","name":"Chocolate cookies, pack of 4","category":"cookies","price":4000,"discount_pct":0,"prep_days":0,"meta":"Pack of 4","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"choc-cookies-8","name":"Chocolate cookies, pack of 8","category":"cookies","price":7500,"discount_pct":0,"prep_days":0,"meta":"Pack of 8","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"choc-cookies-12","name":"Chocolate cookies, pack of 12","category":"cookies","price":12000,"discount_pct":0,"prep_days":1,"meta":"Pack of 12","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"butter-cookies-4","name":"Bu'
    || 'tter cookies, pack of 4","category":"cookies","price":3000,"discount_pct":0,"prep_days":0,"meta":"Pack of 4","description":"","image":"prod-cookies.webp","published":true},{"sku":"butter-cookies-8","name":"Butter cookies, pack of 8","category":"cookies","price":6000,"discount_pct":0,"prep_days":0,"meta":"Pack of 8","description":"","image":"prod-cookies.webp","published":true},{"sku":"butter-cookies-12","name":"Butter cookies, pack of 12","category":"cookies","price":12000,"discount_pct":0,"prep_days":1,"meta":"Pack of 12","description":"","image":"prod-cookies.webp","published":true},{"sku":"mixed-cookie-box","name":"Mixed cookie box, 14 pcs","category":"cookies","price":14000,"discount_pct":0,"prep_days":1,"meta":"14 pieces","description":"","image":"mystery-cookie-box.webp","published":true},{"sku":"cupcakes-6","name":"Cupcakes, box of 6","category":"cupcakes","price":7200,"discount_pct":0,"prep_days":1,"meta":"Box of 6","description":"","image":"prod-cupcakes.webp","published":true},{"sku":"cupcakes-8","name":"Cupcakes, box of 8","category":"cupcakes","price":9500,"discount_pct":0,"prep_days":1,"meta":"Box of 8","description":"","image":"prod-cupcakes.webp","published":true},{"sku":"cupcakes-12","name":"Cupcakes, box of 12","category":"cupcakes","price":14000,"discount_pct":0,"prep_days":1,"meta":"Box of 12","description":"","image":"prod-cupcakes.webp","published":true},{"sku":"parfait-cup-plain","name":"Cake parfait, cup, plain","category":"parfait","price":6000,"discount_pct":0,"prep_days":0,"meta":"Cup","description":"","image":"prod-parfait.webp","published":true},{"sku":"parfait-cup-topped","name":"Cake parfait, cup, topped","category":"parfait","price":7500,"discount_pct":0,"prep_days":0,"meta":"Cup","description":"","image":"prod-parfait.webp","published":true},{"sku":"parfait-bowl-plain","name":"Cake parfait, bowl, plain","category":"parfait","price":8500,"discount_pct":0,"prep_days":0,"meta":"Bowl","description":"","image":"prod-parfait.webp","published":true},{"sku":"parfait-bowl-topped","name":"Cake parfait, bowl, topped","category":"parfait","price":9500,"discount_pct":0,"prep_days":0,"meta":"Bowl","description":"","image":"prod-parfait.webp","published":true},{"sku":"chips-fried-s","name":"Fried chips, small","category":"chips","price":1000,"discount_pct":0,"prep_days":0,"meta":"Small","description":"","image":"","published":true},{"sku":"chips-fried-m","name":"Fried chips, medium","category":"chips","price":3500,"discount_pct":0,"prep_days":0,"meta":"Medium","description":"","image":"","published":true},{"sku":"chips-fried-l","name":"Fried chips, large","category":"chips","price":7000,"discount_pct":0,"prep_days":0,"meta":"Large","description":"","image":"","published":true},{"sku":"chips-baked-s","name":"Baked chips, small","category":"chips","price":1000,"discount_pct":0,"prep_days":0,"meta":"Small","description":"","image":"","published":true},{"sku":"chips-baked-m","name":"Baked chips, medium","category":"chips","price":350'
    || '0,"discount_pct":0,"prep_days":0,"meta":"Medium","description":"","image":"","published":true},{"sku":"chips-baked-l","name":"Baked chips, large","category":"chips","price":8000,"discount_pct":0,"prep_days":0,"meta":"Large","description":"","image":"","published":true},{"sku":"bento","name":"Bento gift cake","category":"celebration","price":12000,"discount_pct":0,"prep_days":1,"meta":"4-inch personal-size cake (from price)","description":"","image":"cake-bento.webp","published":true},{"sku":"birthday","name":"Classic birthday cake","category":"celebration","price":18000,"discount_pct":0,"prep_days":1,"meta":"5-inch to 12-inch (from price)","description":"","image":"cake-birthday.webp","published":true},{"sku":"heart","name":"Heart-shaped cake","category":"celebration","price":30000,"discount_pct":0,"prep_days":1,"meta":"6-inch heart (from price)","description":"","image":"cake-heart.webp","published":true},{"sku":"drip","name":"Drip cake","category":"celebration","price":35000,"discount_pct":0,"prep_days":1,"meta":"6-inch, decorative drip finish (from price)","description":"","image":"cake-drip.webp","published":true},{"sku":"oreo","name":"Oreo cake","category":"celebration","price":35000,"discount_pct":0,"prep_days":1,"meta":"6-inch, Oreo or biscuit topping (from price)","description":"","image":"cake-oreo.webp","published":true},{"sku":"chocolate","name":"Chocolate-loaded cake","category":"celebration","price":40000,"discount_pct":0,"prep_days":1,"meta":"6-inch, chocolate toppings (from price)","description":"","image":"cake-chocolate.webp","published":true},{"sku":"fruit","name":"Fruit-topped cake","category":"celebration","price":40000,"discount_pct":0,"prep_days":1,"meta":"6-inch, fresh-fruit decoration (from price)","description":"","image":"cake-fruit.webp","published":true},{"sku":"redvelvet","name":"Red velvet celebration cake","category":"celebration","price":40000,"discount_pct":0,"prep_days":1,"meta":"6-inch, red velvet flavour (from price)","description":"","image":"cake-redvelvet.webp","published":true},{"sku":"photo","name":"Photo cake","category":"celebration","price":35000,"discount_pct":0,"prep_days":1,"meta":"6-inch, edible photo or printed image (from price)","description":"","image":"cake-photo.webp","published":true},{"sku":"number","name":"Number milestone cake","category":"celebration","price":45000,"discount_pct":0,"prep_days":1,"meta":"Approximately 10-inch (from price)","description":"","image":"cake-number.webp","published":true},{"sku":"kids","name":"Kids'' character or theme cake","category":"celebration","price":60000,"discount_pct":0,"prep_days":1,"meta":"8-inch, character or theme design (from price)","description":"","image":"cake-kids.webp","published":true},{"sku":"luxury","name":"Luxury custom cake","category":"celebration","price":100000,"discount_pct":0,"prep_days":1,"meta":"8-inch, made to suit your theme (from price)","description":"","image":"cake-corporate.webp","published":true},{"sku":"tier2","name":"T'
    || 'wo-tier wedding cake","category":"celebration","price":150000,"discount_pct":0,"prep_days":1,"meta":"8-inch and 6-inch tiers (from price)","description":"","image":"cake-tier2.webp","published":true},{"sku":"tier3","name":"Three-tier grand wedding cake","category":"celebration","price":250000,"discount_pct":0,"prep_days":1,"meta":"10-inch, 8-inch and 6-inch tiers (from price)","description":"","image":"cake-tier3.webp","published":true}],"classes":[{"slug":"bread-beginner","track":"bread","level":1,"level_label":"Beginner","name":"Bread Making · Beginner","summary":"Local favourites and foundational yeast doughs: Ghanaian Sugar Bread, Rich Butter Bread, Tea Bread and Coconut Bread.","description":"A hands-on introduction to yeast doughs built around the four classic Ghanaian loaves. You learn accurate scaling, mixing, kneading, fermentation, shaping, proofing and oven control so you can bake consistent loaves at home or for sale.","fee":150000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Ghanaian Sugar Bread","Rich Butter Bread","Ghanaian Tea Bread","Ghanaian Coconut Bread"],"skills":["Equipment, food safety, ingredients and accurate measuring","Mixing, hand-kneading and windowpane dough development","Bulk fermentation, portioning, tin shaping and proofing","Oven temperature control, cooling, packaging and basic bake costing"],"provided":["All flour, yeast, butter, sugar, coconut and recipe ingredients","Loaf tins, mixers, ovens and full kitchen equipment","Printed recipe sheets and basic costing worksheet","Every loaf you bake during the week to take home"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and equipment are provided by the school.","prereq":"No experience needed. The beginner course assumes you have never baked bread or pastry.","published":true},{"slug":"bread-intermediate","track":"bread","level":2,"level_label":"Intermediate","name":"Bread Making · Intermediate","summary":"Whole-grain doughs, soft rolls and shaped loaves: Whole-meal Wheat Bread, Soft Buttermilk Rolls, Wheat Sandwich Baguettes and Wholewheat Burger Buns.","description":"Move beyond basic tin loaves into whole-grain hydration, soft enriched dinner rolls, seeded burger buns and sandwich baguettes. Focuses on dough conditioning, uniform portioning, tension shaping and crust finishes.","fee":220000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Whole-meal Wheat Bread","Soft Buttermilk Rolls","Wheat Sandwich Baguettes","Wholewheat Burger Buns"],"skills":["Hydration adjustments for whole-meal and wheat flours","Dividing, rounding and uniform tension shaping for rolls and buns","Pre-shaping, couching and scoring sandwich baguettes","Egg-wash, seed topping, steam control, presentation and packaging"],"provided":["All whole-grain and bread flours, buttermilk, butter and seeds","Proofer, ovens, benc'
    || 'h scrapers and baking trays","Printed recipe manual and batch costing guide","All loaves, rolls and buns baked in class"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and equipment are provided by the school.","prereq":"Beginner complete, or equivalent comfort with a basic yeast dough.","published":true},{"slug":"bread-advanced","track":"bread","level":3,"level_label":"Advanced","name":"Bread Making · Advanced","summary":"Artisan fermentation, braided and enriched doughs: Sourdough Boule, Classic French Baguette, Braided Challah, Brioche, Cinnamon Swirl, Rosemary Focaccia, New York Bagels and Skillet Naan.","description":"Our flagship bread course covering natural levain management, high-hydration open-crumb doughs, multi-strand braiding, rich butter brioche, boiled bagels and flatbreads. Designed for serious home bakers and bakery founders.","fee":300000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Artisan Sourdough Boule","Classic French Baguette","Braided Challah","Brioche","Cinnamon Swirl Butter Loaf","Rosemary Focaccia","New York Style Bagels","Skillet Naan"],"skills":["Building and maintaining an active sourdough starter and levain","Stretch-and-fold, coil folds and cold retard fermentation","High-butter emulsion for brioche and multi-strand challah braiding","Kettle-boiling bagels, open-hearth steaming, scoring and troubleshooting"],"provided":["All specialty flours, butter, inclusions and active sourdough starter to take home","Bannetons, lame, baking steel/stone and full kitchen equipment","Comprehensive artisan bread workbook and commercial pricing sheet","Every loaf, bagel and flatbread baked during the week"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for fermentation logs","Hair net or head wrap"],"bring_note":"All ingredients, bannetons and tools are provided by the school.","prereq":"Intermediate complete, or confident with enriched, laminated and wheat doughs.","published":true},{"slug":"pastry-beginner","track":"pastry","level":1,"level_label":"Beginner","name":"Pastry & Savoury · Beginner","summary":"Everyday savoury pastries and Ghanaian snacks: Meat Pie, Sausage Roll, Spring Roll, Samosa, Puff-Puff (Bofrot), Rock Buns, Atwemo and Chin Chin.","description":"Master the everyday savoury pastries and traditional Ghanaian snacks that anchor event platters and daily bakery orders. Covers shortcrust rubbing-in, savoury fillings, folding samosas and spring rolls, and frying temperature control.","fee":150000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Meat Pie","Sausage Roll","Spring Roll","Samosa","Puff-Puff (Bofrot)","Ghanaian Rock Buns","Atwemo","Chin Chin"],"skills":["Flaky shortcrust and rough-puff pastry without tough shrinkage","Seasoning and binding moist meat and vegetable fillings","Wrapping, sealing and crimping pies, '
    || 'rolls, spring rolls and samosas","Frying oil temperature control, packaging and costing a snack order"],"provided":["All flour, butter, meats, vegetables, spices, oil and packaging boxes","Ovens, fryers, cutters, rolling pins and workstation tools","Printed recipe booklet and small-chop platter costing guide","All pastries and snack packs made during class"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and packaging are provided by the school.","prereq":"No experience needed. The beginner course assumes you have never baked bread or pastry.","published":true},{"slug":"pastry-intermediate","track":"pastry","level":2,"level_label":"Intermediate","name":"Pastry & Bakery · Intermediate","summary":"Lamination, bakery counter favourites and café bakes: Croissants, Danish, Puff Pastry, Cinnamon Rolls, Doughnuts, Cupcakes, Cookies and Pizza.","description":"Learn butter lock-in and lamination for crisp croissants, Danish and puff pastry alongside commercial-grade milky doughnuts, swirled cinnamon rolls, hand-iced cupcakes, cookies and artisan pizza dough.","fee":220000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Croissants","Danish Pastry","Puff Pastry","Cinnamon Rolls","Doughnuts","Cupcakes","Cookies","Pizza"],"skills":["Butter block preparation, single/double turns and cold lamination","Shaping, proofing and glazing croissants, Danish and cinnamon rolls","Frying and filling pillowy doughnuts with stable glazes","Creaming method for cupcakes and cookies, piping, presentation and costing"],"provided":["Lamination butter, chocolate, glazes, fillings and all ingredients","Chillers, mixers, piping tips, cutters and baking sheets","Step-by-step lamination schedule and recipe manual","Boxes of everything you bake to take home"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All ingredients and equipment are provided by the school.","prereq":"Beginner complete, or equivalent comfort with basic dough and pastry handling.","published":true},{"slug":"pastry-advanced","track":"pastry","level":3,"level_label":"Advanced","name":"Pâtisserie & Desserts · Advanced","summary":"Fine pâtisserie and plated desserts: Macarons, Éclairs, Fruit and Custard Tarts, Quiche, Cheesecakes and Mousse Cakes.","description":"Precision pastry for dessert tables and boutique orders. Covers macaronage, choux pastry for éclairs, crisp pâte sucrée tart shells, pastry cream, baked and chilled cheesecakes, savoury quiche and mirror-finished mousse cakes.","fee":300000,"hours":"1 week","schedule":"Monday to Friday · dates agreed with student","recipes":["Macarons","Éclairs","Fruit and Custard Tarts","Quiche","Cheesecakes","Mousse Cakes"],"skills":["Meringue stability and macaronage for smooth, footed macaron shells","Piping and baking hollow choux pastry éclairs with pastry crea'
    || 'm and glaze","Blind-baking crisp sweet and savoury tart shells without shrinkage","Emulsion, setting and finishing for cheesecakes and mousse cakes"],"provided":["Almond flour, chocolate, cream cheese, fresh fruit and all ingredients","Baking mats, tart rings, thermometers, mixers and finishing tools","Advanced pâtisserie manual, troubleshooting and pricing guide","Full dessert boxes of your finished creations"],"bring":["Clean apron and closed-toe kitchen shoes","Notebook and pen for bench notes","Hair net or head wrap"],"bring_note":"All specialty ingredients and tools are provided by the school.","prereq":"Intermediate complete, or confident with enriched, laminated and wheat doughs.","published":true}],"options":[{"kind":"size","key":"5","label":"5-inch (serves 6–8)","payload":{"price":15000}},{"kind":"size","key":"6","label":"6-inch (serves 8–12)","payload":{"price":22000}},{"kind":"size","key":"7","label":"7-inch (serves 12–16)","payload":{"price":28000}},{"kind":"size","key":"8","label":"8-inch (serves 16–22)","payload":{"price":35000}},{"kind":"size","key":"10","label":"10-inch (serves 25–32)","payload":{"price":65000}},{"kind":"size","key":"12","label":"12-inch (serves 35–45)","payload":{"price":90000}},{"kind":"decor","key":"basic","label":"Basic single-layer","payload":{"charges":{"5":15000,"6":22000,"7":28000,"8":35000,"10":65000,"12":90000}}},{"kind":"decor","key":"simple","label":"Simple decorated birthday","payload":{"charges":{"5":18000,"6":25000,"7":32000,"8":40000,"10":75000,"12":100000}}},{"kind":"decor","key":"custom","label":"Custom decorated single-layer","payload":{"charges":{"5":22000,"6":30000,"7":38000,"8":50000,"10":95000,"12":130000}}},{"kind":"decor","key":"two-plain","label":"Two-layer, plain finish","payload":{"charges":{"5":22000,"6":30000,"7":40000,"8":50000,"10":80000,"12":110000}}},{"kind":"decor","key":"two-decor","label":"Two-layer, decorated","payload":{"charges":{"5":28000,"6":38000,"7":48000,"8":70000,"10":100000,"12":140000}}},{"kind":"flavour","key":"vanilla","label":"Vanilla","payload":{"extra":0}},{"kind":"flavour","key":"banana","label":"Banana","payload":{"extra":0}},{"kind":"flavour","key":"chocolate","label":"Chocolate","payload":{"extra":2000}},{"kind":"flavour","key":"lemon","label":"Lemon","payload":{"extra":2000}},{"kind":"flavour","key":"marble","label":"Marble","payload":{"extra":3000}},{"kind":"flavour","key":"coconut","label":"Coconut","payload":{"extra":3000}},{"kind":"flavour","key":"carrot","label":"Carrot","payload":{"extra":3000}},{"kind":"flavour","key":"redvelvet","label":"Red velvet","payload":{"extra":4000}},{"kind":"flavour","key":"fruit","label":"Traditional fruit cake","payload":{"extra":5000,"priceMax":10000}},{"kind":"addon","key":"writing","label":"Birthday writing on cake","payload":{"price":1000}},{"kind":"addon","key":"piping","label":"Extra cream piping","payload":{"price":3000}},{"kind":"addon","key":"drip","label":"Chocolate drip","payload":{"price":3000,"priceMax":4000}'
    || '},{"kind":"addon","key":"oreo","label":"Oreo or biscuit topping","payload":{"price":3000,"priceMax":4000}},{"kind":"addon","key":"fruit","label":"Fresh fruit decoration","payload":{"price":5000}},{"kind":"addon","key":"photo","label":"Edible image / photo print","payload":{"price":6000}},{"kind":"addon","key":"topper","label":"Acrylic cake topper","payload":{"price":3000,"priceMax":6000}},{"kind":"addon","key":"fondant-name","label":"Fondant name or age","payload":{"price":5000}},{"kind":"addon","key":"fondant-full","label":"Full fondant covering / theme design","payload":{"price":null,"priceMax":30000}},{"kind":"variety","key":"bento","label":"Bento gift cake (4-inch)","payload":{"price":12000}},{"kind":"variety","key":"birthday","label":"Classic birthday cake","payload":{"price":18000}},{"kind":"variety","key":"heart","label":"Heart-shaped cake (6-inch)","payload":{"price":30000}},{"kind":"variety","key":"drip","label":"Drip cake (6-inch)","payload":{"price":35000}},{"kind":"variety","key":"oreo","label":"Oreo cake (6-inch)","payload":{"price":35000}},{"kind":"variety","key":"chocolate","label":"Chocolate-loaded cake (6-inch)","payload":{"price":40000}},{"kind":"variety","key":"fruit","label":"Fruit-topped cake (6-inch)","payload":{"price":40000}},{"kind":"variety","key":"redvelvet","label":"Red velvet celebration cake (6-inch)","payload":{"price":40000}},{"kind":"variety","key":"photo","label":"Photo cake (6-inch)","payload":{"price":35000}},{"kind":"variety","key":"number","label":"Number milestone cake","payload":{"price":45000}},{"kind":"variety","key":"kids","label":"Kids’ character or theme cake","payload":{"price":60000}},{"kind":"variety","key":"corporate","label":"Luxury custom cake","payload":{"price":100000}},{"kind":"variety","key":"tier2","label":"Two-tier wedding cake","payload":{"price":150000}},{"kind":"variety","key":"tier3","label":"Three-tier grand wedding cake","payload":{"price":250000}},{"kind":"tier","key":"tier2","label":"Two-tier wedding cake (8\" + 6\")","payload":{"price":150000}},{"kind":"tier","key":"tier3","label":"Three-tier grand wedding cake (10\" + 8\" + 6\")","payload":{"price":250000}}]}'
  )::jsonb;

  -- Categories first: products reference them by slug.
  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'categories') LOOP
    INSERT INTO public.categories (slug, name, intro, published, sort_order)
    VALUES (
      rec->>'slug',
      rec->>'name',
      coalesce(rec->>'intro', ''),
      coalesce((rec->>'published')::BOOLEAN, TRUE),
      coalesce((rec->>'sort_order')::INTEGER, 0)
    )
    ON CONFLICT (slug) DO NOTHING;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'products') LOOP
    INSERT INTO public.products (sku, name, category, price, discount_pct, prep_days, meta, description, image, published)
    VALUES (
      rec->>'sku',
      rec->>'name',
      rec->>'category',
      CASE WHEN rec->>'price' IS NULL OR rec->>'price' = 'null' THEN NULL ELSE (rec->>'price')::INTEGER END,
      coalesce((rec->>'discount_pct')::INTEGER, 0),
      coalesce((rec->>'prep_days')::INTEGER, 0),
      coalesce(rec->>'meta', ''),
      coalesce(rec->>'description', ''),
      coalesce(rec->>'image', ''),
      coalesce((rec->>'published')::BOOLEAN, TRUE)
    )
    ON CONFLICT (sku) DO NOTHING;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'classes') LOOP
    INSERT INTO public.classes (
      slug, track, level, level_label, name, summary, description, fee,
      hours, schedule, recipes, skills, provided, bring, bring_note, prereq, published
    )
    VALUES (
      rec->>'slug',
      coalesce(rec->>'track', 'bread'),
      coalesce((rec->>'level')::INTEGER, 1),
      coalesce(rec->>'level_label', 'Beginner'),
      rec->>'name',
      coalesce(rec->>'summary', ''),
      coalesce(rec->>'description', ''),
      coalesce((rec->>'fee')::INTEGER, 0),
      coalesce(rec->>'hours', '1 week'),
      coalesce(rec->>'schedule', ''),
      coalesce(rec->'recipes', '[]'::jsonb),
      coalesce(rec->'skills', '[]'::jsonb),
      coalesce(rec->'provided', '[]'::jsonb),
      coalesce(rec->'bring', '[]'::jsonb),
      coalesce(rec->>'bring_note', ''),
      coalesce(rec->>'prereq', ''),
      coalesce((rec->>'published')::BOOLEAN, TRUE)
    )
    ON CONFLICT (slug) DO NOTHING;
  END LOOP;

  FOR rec IN SELECT * FROM jsonb_array_elements(v_src->'options') LOOP
    INSERT INTO public.cake_options (kind, key, label, payload)
    VALUES (
      rec->>'kind',
      rec->>'key',
      rec->>'label',
      coalesce(rec->'payload', '{}'::jsonb)
    )
    ON CONFLICT (kind, key) DO NOTHING;
  END LOOP;

  RAISE NOTICE 'Catalogue seed complete. Rows after seed: categories=%, products=%, classes=%, options=%',
    (SELECT count(*) FROM public.categories),
    (SELECT count(*) FROM public.products),
    (SELECT count(*) FROM public.classes),
    (SELECT count(*) FROM public.cake_options);
END $$;

COMMIT;
