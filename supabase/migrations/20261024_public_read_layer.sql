-- =============================================================================
-- Mystery Bakebite — Public Read Layer (config & catalogue)
-- Target: Supabase PostgreSQL 15+
--
-- WHY THIS EXISTS
--   The browser calls three read-only RPCs that were never defined in any
--   migration in this repository:
--
--       /api/config     -> public.api_config()      (every page)
--       /api/catalogue  -> public.api_catalogue()   (menu, products, classes,
--                                                    cart, cake builder, booking)
--       /api/price      -> public.api_price(...)    (checkout preview only)
--
--   Against a fresh Supabase project these return
--   `PGRST202 ... could not find the function`, so:
--     * checkout cannot render the MoMo / bank instructions,
--     * menu, products, classes and the cake builder cannot list anything,
--     * classes.html shows "Courses could not be loaded".
--
--   They worked before only because the local fallback in assets/js/supabase.js
--   implements them in JavaScript. That is why the test suite passed: it runs
--   against the local database, not against Postgres.
--
--   This migration implements api_config() and api_catalogue() -- the two that
--   block the storefront -- plus api_price() for product and class carts.
--
-- SECURITY
--   Both functions are SECURITY DEFINER because public.settings has no SELECT
--   grant for `anon`. They expose only fields that are meant to be public:
--   payment details, discount percentages, preparation lead times. They never
--   return a token, an order, a customer or any administrator record.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. public.api_config()
--    Mirrors buildPublicConfig() in assets/js/supabase.js so the browser sees
--    exactly the same shape from Postgres as it does from the local fallback.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_config()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  WITH s AS (
    -- LEFT JOIN keeps this returning a usable default even on a database where
    -- the settings row has not been seeded yet; every field below is coalesced.
    SELECT st.* FROM (SELECT 1 AS one) d
    LEFT JOIN public.settings st ON st.id = 1
  )
  SELECT jsonb_build_object(
    'ok', TRUE,
    'config', jsonb_build_object(
      -- The public WhatsApp line. settings.whatsapp_number may be the baker's
      -- private alert number, so only expose it once it is explicitly set.
      'whatsapp', coalesce(nullif(btrim(s.whatsapp_number), ''), ''),
      'bundle_two_pct',   coalesce(s.bundle_two_pct, 15),
      'bundle_three_pct', coalesce(s.bundle_three_pct, 25),
      -- Older rows stored the threshold in cedis (700); normalise to pesewas.
      'advance_threshold',
        CASE
          WHEN s.advance_threshold IS NULL OR s.advance_threshold <= 0 THEN 70000
          WHEN s.advance_threshold < 1000 THEN round(s.advance_threshold * 100)
          ELSE s.advance_threshold
        END,
      'cash', jsonb_build_object(
        'delivery', coalesce(s.cash_delivery_enabled, TRUE),
        'pickup',   coalesce(s.cash_pickup_enabled, TRUE)
      ),
      'momo', CASE
        WHEN coalesce(s.momo_verified, FALSE)
             AND coalesce(btrim(s.momo_name), '')   <> ''
             AND coalesce(btrim(s.momo_number), '') <> ''
        THEN jsonb_build_object(
               'name',     s.momo_name,
               'number',   s.momo_number,
               'provider', coalesce(nullif(btrim(s.momo_provider), ''), 'MTN MoMo'),
               'note',     coalesce(s.momo_note, '')
             )
        ELSE NULL::jsonb
      END,
      'bank', CASE
        WHEN coalesce(s.bank_verified, FALSE)
             AND coalesce(btrim(s.bank_name), '')           <> ''
             AND coalesce(btrim(s.bank_account_name), '')   <> ''
             AND coalesce(btrim(s.bank_account_number), '') <> ''
        THEN jsonb_build_object(
               'name',          s.bank_name,
               'accountName',   s.bank_account_name,
               'accountNumber', s.bank_account_number
             )
        ELSE NULL::jsonb
      END,
      -- Per-SKU discount and preparation lead times, so the browser can show a
      -- price preview that agrees with what api_place_order will charge.
      'product_discounts', coalesce((
        SELECT jsonb_object_agg(p.sku, p.discount_pct)
        FROM public.products p
        WHERE coalesce(p.discount_pct, 0) > 0
      ), '{}'::jsonb),
      'product_prep_days', coalesce((
        SELECT jsonb_object_agg(p.sku, p.prep_days)
        FROM public.products p
      ), '{}'::jsonb)
    )
  )
  FROM s;
$$;

-- -----------------------------------------------------------------------------
-- 2. public.api_catalogue()
--    Every field is returned in camelCase because that is what the browser
--    reads (p.prepDays, p.discountPct, c.levelLabel).
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
-- 3. public.api_price()
--    A PREVIEW only. api_place_order recomputes every price from the catalogue
--    at submission time and is the sole authority on what is charged.
--
--    Deliberately conservative: a cart containing a custom cake is answered with
--    ok = false ('unsupported') rather than an approximate number. The checkout
--    page treats ok = false as "keep using the locally computed preview", so the
--    customer never sees a figure that might differ from the agreed total.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_price(
  p_type  TEXT DEFAULT 'product',
  p_items JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind      TEXT := CASE WHEN lower(coalesce(p_type, 'product')) = 'class' THEN 'class' ELSE 'product' END;
  v_raw       JSONB := coalesce(p_items->'items', p_items->'classes', '[]'::jsonb);
  v_item      JSONB;
  v_subtotal  INTEGER := 0;
  v_discount  INTEGER := 0;
  v_count     INTEGER := 0;
  v_qty       INTEGER;
  v_id        TEXT;
  v_price     INTEGER;
  v_pct       INTEGER;
  v_prep      INTEGER;
  v_max_prep  INTEGER := 0;
  v_settings  public.settings%ROWTYPE;
  v_lines     JSONB := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(v_raw) <> 'array' OR jsonb_array_length(v_raw) = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'empty_cart', 'error', 'Your cart is empty.');
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_raw) LOOP

    -- A custom cake has no catalogue price; refuse rather than invent one.
    IF v_item ? 'spec' OR v_item ? 'custom' THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'unsupported',
        'error', 'Custom cake pricing is confirmed by the baker.');
    END IF;

    v_qty := coalesce((v_item->>'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 100 THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_quantity',
        'error', 'Item quantity must be a whole number between 1 and 100.');
    END IF;

    IF v_kind = 'class' THEN
      v_id := btrim(coalesce(v_item->>'slug', v_item->>'id', ''));
      SELECT k.fee INTO v_price
      FROM public.classes k
      WHERE k.slug = v_id AND k.published IS NOT FALSE;
      IF v_price IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_class',
          'error', 'Unknown or unavailable class: ' || coalesce(v_id, 'unknown'));
      END IF;
      v_prep := 0;   -- classes carry no preparation lead time
      v_count := v_count + 1;
    ELSE
      v_id := btrim(coalesce(v_item->>'sku', v_item->>'id', ''));
      SELECT p.price, coalesce(p.discount_pct, 0), coalesce(p.prep_days, 0)
        INTO v_price, v_pct, v_prep
      FROM public.products p
      WHERE p.sku = v_id AND p.published IS NOT FALSE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_product',
          'error', 'Unknown or unavailable product: ' || coalesce(v_id, 'unknown'));
      END IF;
      -- NULL price = quoted on request; cannot be previewed.
      IF v_price IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'unsupported',
          'error', 'This item is quoted on request.');
      END IF;
      v_max_prep := greatest(v_max_prep, v_prep);
    END IF;

    v_subtotal := v_subtotal + (v_price * v_qty);

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'id',        v_id,
      'qty',       v_qty,
      'unitPrice', v_price,
      'lineTotal', v_price * v_qty
    ));
  END LOOP;

  -- Class bundle discount applies only when 2 or more classes are selected.
  IF v_kind = 'class' AND v_count >= 2 THEN
    v_pct := CASE WHEN v_count >= 3
                  THEN coalesce(v_settings.bundle_three_pct, 25)
                  ELSE coalesce(v_settings.bundle_two_pct, 15) END;
    v_discount := round(v_subtotal * v_pct / 100.0)::INTEGER;
  END IF;

  RETURN jsonb_build_object(
    'ok',            TRUE,
    'subtotal',      v_subtotal,
    'discount',      v_discount,
    'total',         greatest(0, v_subtotal - v_discount),
    'has_quote',     FALSE,
    'bundles',       CASE WHEN v_discount > 0
                          THEN jsonb_build_array(jsonb_build_object('pct', v_pct))
                          ELSE '[]'::jsonb END,
    'items',         v_lines,
    'max_prep_days', v_max_prep,
    'earliest_date', to_char(current_date + v_max_prep, 'YYYY-MM-DD')
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Grants
--    These are read-only, public-by-design functions. Nothing here can read an
--    order, a customer or an administrator.
-- -----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.api_config()                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_catalogue()              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_price(TEXT, JSONB)       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.api_config()            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_catalogue()         TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_price(TEXT, JSONB)  TO anon, authenticated;

COMMIT;
