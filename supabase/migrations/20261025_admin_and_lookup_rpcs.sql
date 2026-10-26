-- =============================================================================
-- Mystery Bakebite — Administrator & Order-Lookup RPCs
-- Target: Supabase PostgreSQL 15+
--
-- WHY THIS EXISTS
--   The admin dashboard and the "find my order" form call these RPCs, none of
--   which existed in any earlier migration:
--
--       api_lookup_order          order.html — find an order by ref + phone
--       api_admin_orders          dashboard order list
--       api_admin_order           single order
--       api_admin_dashboard       dashboard KPIs, chart series, attention list
--       api_admin_settings        payment details & business rules (read/write)
--       api_admin_catalogue       catalogue read for the admin panels
--       api_admin_discounts       product & class discount control
--       api_admin_notifications   baker-alert outbox view
--       api_admin_product         product create / update / delete
--       api_admin_class           class   create / update / delete
--       api_admin_category        category create / update / delete
--       api_admin_option          cake builder option pricing
--
--   Without them the dashboard could list nothing and no payment could ever be
--   approved, because nothing could be seen to approve.
--
-- AUTHORISATION
--   Every api_admin_* function begins with a has_admin_permission() gate:
--     orders / verify   -> order list, single order, dashboard
--     settings          -> payment details & rules
--     catalogue         -> products, classes, categories, options, discounts
--   api_lookup_order is public but needs BOTH the exact reference and the phone
--   number used on the order.
--
-- SHAPE
--   The browser reads a mix of camelCase (paymentStatus, orderStatus,
--   eventDate) and snake_case (payment_status, order_status, customer_name), so
--   order objects are serialised with BOTH. That is not cosmetic: order.js
--   reads camelCase and admin.js reads both.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Shared order serialiser
--    Never exposes the order token: administrators act through the RPCs, and
--    the token is the customer's capability to prove ownership.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.order_admin_json(o public.orders)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'ref',            o.ref,
    'kind',           o.kind,
    'customerId',     o.customer_id,
    'customer_id',    o.customer_id,
    'customerName',   o.customer_name,
    'customer_name',  o.customer_name,
    'phone',          o.phone,
    'email',          o.email,
    'fulfilment',     o.fulfilment,
    'address',        o.address,
    'eventDate',      o.event_date,
    'event_date',     o.event_date,
    'paymentMethod',  o.payment_method,
    'payment_method', o.payment_method,
    'paymentStatus',  o.payment_status,
    'payment_status', o.payment_status,
    'orderStatus',    o.order_status,
    'order_status',   o.order_status,
    'subtotal',       o.subtotal,
    'discount',       o.discount,
    'total',          o.total,
    'hasUnpriced',    o.has_unpriced,
    'has_unpriced',   o.has_unpriced,
    'advanceRequired',  o.advance_required,
    'advance_required', o.advance_required,
    'items',          o.items,
    'bundles',        o.bundles,
    'notes',          o.notes,
    'paymentRef',     o.payment_ref,
    'payment_ref',    o.payment_ref,
    'hasProof',       o.has_proof,
    'has_proof',      o.has_proof,
    'proofPath',      o.proof_path,
    'proof_path',     o.proof_path,
    'proofNote',      o.proof_note,
    'proof_note',     o.proof_note,
    'proofLocked',    o.proof_locked,
    'proof_locked',   o.proof_locked,
    'proofSubmittedAt',  o.proof_submitted_at,
    'proof_submitted_at', o.proof_submitted_at,
    'submissionCount',   o.submission_count,
    'submission_count',  o.submission_count,
    'rejectReason',   o.reject_reason,
    'reject_reason',  o.reject_reason,
    'verifiedAt',     o.verified_at,
    'verified_at',    o.verified_at,
    'verifiedBy',     o.verified_by,
    'verified_by',    o.verified_by,
    'notifiedAt',     o.notified_at,
    'notified_at',    o.notified_at,
    'events',         o.events,
    'createdAt',      o.created_at,
    'created_at',     o.created_at,
    'updatedAt',      o.updated_at,
    'updated_at',     o.updated_at
  );
$$;

-- -----------------------------------------------------------------------------
-- 1. api_lookup_order — "find my order" on order.html
--    Requires the exact reference AND the phone number on the order. Returns the
--    order token so the customer can open the order page, which is the same
--    capability a guest receives on the confirmation screen.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_lookup_order(
  p_ref   TEXT,
  p_phone TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref   TEXT := upper(btrim(coalesce(p_ref, '')));
  v_dig   TEXT := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_order public.orders%ROWTYPE;
  v_uid   UUID := auth.uid();
BEGIN
  IF v_ref !~ '^M[BC]-[A-Z0-9-]{4,20}$' THEN
    RETURN jsonb_build_object('ok', FALSE,
      'error', 'Please enter a valid order or booking reference (e.g. MB-123456).');
  END IF;

  IF char_length(v_dig) < 7 THEN
    RETURN jsonb_build_object('ok', FALSE,
      'error', 'Please enter the phone number used when placing the order.');
  END IF;

  SELECT * INTO v_order
  FROM public.orders o
  WHERE o.ref = v_ref
    AND regexp_replace(o.phone, '\D', '', 'g') = v_dig;

  IF NOT FOUND THEN
    -- The reference space is small and this function is callable by anon, so a
    -- failed attempt costs fractionally slow time. That makes blind enumeration
    -- of references impractical without needing a throttle table.
    PERFORM pg_sleep(0.35);
    RETURN jsonb_build_object('ok', FALSE,
      'error', 'We could not find an order matching that reference and phone number.');
  END IF;

  -- A signed-in customer must not be able to pivot into another account's order.
  IF v_order.customer_id IS NOT NULL
     AND v_uid IS NOT NULL
     AND v_order.customer_id <> v_uid
     AND NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'forbidden',
      'error', 'Access denied: that order belongs to a different customer account.');
  END IF;

  RETURN jsonb_build_object(
    'ok',        TRUE,
    'ref',       v_order.ref,
    'kind',      v_order.kind,
    'token',     v_order.token,
    'statusUrl', 'order.html?ref=' || v_order.ref || '&token=' || v_order.token,
    'order',     public.order_admin_json(v_order)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. api_admin_orders — filtered order list
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_orders(
  p_kind    TEXT    DEFAULT '',
  p_status  TEXT    DEFAULT '',
  p_payment TEXT    DEFAULT '',
  p_q       TEXT    DEFAULT '',
  p_limit   INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_q      TEXT := lower(btrim(coalesce(p_q, '')));
  v_limit  INTEGER := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_rows   JSONB;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator order-management permission required.');
  END IF;

  SELECT coalesce(jsonb_agg(public.order_admin_json(o) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT *
    FROM public.orders o
    WHERE (coalesce(p_kind, '')    = '' OR o.kind           = p_kind)
      AND (coalesce(p_status, '')  = '' OR o.order_status   = p_status)
      AND (coalesce(p_payment, '') = '' OR o.payment_status = p_payment)
      AND (
            v_q = ''
            OR lower(o.ref) LIKE '%' || v_q || '%'
            OR lower(o.customer_name) LIKE '%' || v_q || '%'
            OR lower(o.phone) LIKE '%' || v_q || '%'
          )
    ORDER BY o.created_at DESC
    LIMIT v_limit
  ) o;

  RETURN jsonb_build_object('ok', TRUE, 'orders', v_rows);
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. api_admin_order — single order
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_order(p_ref TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref   TEXT := upper(btrim(coalesce(p_ref, '')));
  v_order public.orders%ROWTYPE;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator order-management permission required.');
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'order', public.order_admin_json(v_order));
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. api_admin_dashboard — KPIs, 7/14/30-day series, attention list
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_dashboard(p_days INTEGER DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days     INTEGER := least(greatest(coalesce(p_days, 7), 1), 90);
  v_start    DATE := current_date - (v_days - 1);
  v_prev_start DATE := current_date - (v_days * 2) + 1;
  v_settings public.settings%ROWTYPE;
  v_revenue      INTEGER := 0;
  v_rev_prev     INTEGER := 0;
  v_orders       INTEGER := 0;
  v_orders_prev  INTEGER := 0;
  v_units        INTEGER := 0;
  v_units_prev   INTEGER := 0;
  v_new_cust     INTEGER := 0;
  v_new_cust_prev INTEGER := 0;
  v_series       JSONB;
  v_cats         JSONB;
  v_attention    JSONB;
  v_top          JSONB;
  v_class_bookings INTEGER := 0;
  v_class_rev      INTEGER := 0;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator order-management permission required.');
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;

  -- Current window
  SELECT coalesce(sum(total), 0), count(*),
         coalesce(sum((SELECT coalesce(sum((it->>'qty')::INTEGER), 0)
                       FROM jsonb_array_elements(o.items) it)), 0),
         count(DISTINCT nullif(o.phone, ''))
  INTO v_revenue, v_orders, v_units, v_new_cust
  FROM public.orders o
  WHERE o.created_at >= v_start;

  -- Previous window of the same length, for the percentage deltas
  SELECT coalesce(sum(total), 0), count(*),
         coalesce(sum((SELECT coalesce(sum((it->>'qty')::INTEGER), 0)
                       FROM jsonb_array_elements(o.items) it)), 0),
         count(DISTINCT nullif(o.phone, ''))
  INTO v_rev_prev, v_orders_prev, v_units_prev, v_new_cust_prev
  FROM public.orders o
  WHERE o.created_at >= v_prev_start AND o.created_at < v_start;

  -- Daily series, zero-filled so the chart never has gaps
  SELECT jsonb_agg(jsonb_build_object(
           'date',         to_char(d, 'YYYY-MM-DD'),
           'label',        to_char(d, 'Dy'),
           'orders',       coalesce(agg.orders, 0),
           'units',        coalesce(agg.units, 0),
           'revenue',      coalesce(agg.revenue, 0),
           'newCustomers', coalesce(agg.new_customers, 0)
         ) ORDER BY d)
  INTO v_series
  FROM generate_series(v_start, current_date, INTERVAL '1 day') AS g(d)
  LEFT JOIN LATERAL (
    SELECT count(*) AS orders,
           coalesce(sum((SELECT coalesce(sum((it->>'qty')::INTEGER), 0)
                         FROM jsonb_array_elements(o.items) it)), 0) AS units,
           coalesce(sum(o.total), 0) AS revenue,
           count(DISTINCT nullif(o.phone, '')) AS new_customers
    FROM public.orders o
    WHERE o.created_at >= g.d AND o.created_at < g.d + INTERVAL '1 day'
  ) agg ON TRUE;

  -- Orders needing a human: unconfirmed, or payment evidence waiting
  SELECT coalesce(jsonb_agg(public.order_admin_json(o) ORDER BY o.created_at ASC), '[]'::jsonb)
  INTO v_attention
  FROM (
    SELECT * FROM public.orders
    WHERE order_status = 'submitted' OR payment_status = 'payment_submitted'
    ORDER BY created_at ASC
    LIMIT 20
  ) o;

  -- Best sellers inside the window
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name',  t.name,
           'units', t.units,
           'revenue', t.revenue
         ) ORDER BY t.units DESC), '[]'::jsonb)
  INTO v_top
  FROM (
    SELECT coalesce(it->>'name', it->>'sku', 'Item') AS name,
           sum(coalesce((it->>'qty')::INTEGER, 0)) AS units,
           sum(coalesce((it->>'lineTotal')::INTEGER, 0)) AS revenue
    FROM public.orders o,
         LATERAL jsonb_array_elements(o.items) it
    WHERE o.created_at >= v_start
    GROUP BY 1
    ORDER BY units DESC
    LIMIT 8
  ) t;

  SELECT coalesce(jsonb_agg(jsonb_build_object('category', cat, 'revenue', rev) ORDER BY rev DESC), '[]'::jsonb)
  INTO v_cats
  FROM (
    SELECT coalesce(p.category, 'other') AS cat,
           sum(coalesce((it->>'lineTotal')::INTEGER, 0)) AS rev
    FROM public.orders o,
         LATERAL jsonb_array_elements(o.items) it
    LEFT JOIN public.products p ON p.sku = it->>'sku'
    WHERE o.created_at >= v_start AND it ? 'sku'
    GROUP BY 1
  ) c;

  SELECT count(*), coalesce(sum(total), 0)
  INTO v_class_bookings, v_class_rev
  FROM public.orders
  WHERE kind = 'class';

  RETURN jsonb_build_object(
    'ok', TRUE,
    'window', jsonb_build_object('days', v_days, 'from', to_char(v_start, 'YYYY-MM-DD')),
    'paymentConfigured', (coalesce(v_settings.momo_verified, FALSE) AND coalesce(btrim(v_settings.momo_number), '') <> '')
                      OR (coalesce(v_settings.bank_verified, FALSE) AND coalesce(btrim(v_settings.bank_account_number), '') <> ''),
    'salesTotal', v_revenue,
    'stats', jsonb_build_object(
      'toConfirm',      (SELECT count(*) FROM public.orders WHERE order_status = 'submitted'),
      'proofsToReview', (SELECT count(*) FROM public.orders WHERE payment_status = 'payment_submitted'),
      'awaitingPayment',(SELECT count(*) FROM public.orders WHERE payment_status = 'awaiting_payment'),
      'newToday',       (SELECT count(*) FROM public.orders WHERE created_at >= current_date)
    ),
    'kpis', jsonb_build_object(
      'revenue',      jsonb_build_object('value', v_revenue,   'previous', v_rev_prev,      'pct', public.pct_change(v_revenue, v_rev_prev)),
      'orders',       jsonb_build_object('value', v_orders,    'previous', v_orders_prev,   'pct', public.pct_change(v_orders, v_orders_prev)),
      'units',        jsonb_build_object('value', v_units,     'previous', v_units_prev,    'pct', public.pct_change(v_units, v_units_prev)),
      'newCustomers', jsonb_build_object('value', v_new_cust,  'previous', v_new_cust_prev, 'pct', public.pct_change(v_new_cust, v_new_cust_prev))
    ),
    'series',     v_series,
    'categories', v_cats,
    'attention',  v_attention,
    'activity',   coalesce((
      SELECT jsonb_agg(ev ORDER BY ev->>'at' DESC)
      FROM (
        SELECT e.ev
        FROM public.orders o, LATERAL jsonb_array_elements(o.events) e(ev)
        ORDER BY o.created_at DESC
        LIMIT 12
      ) x
    ), '[]'::jsonb),
    'topProducts', v_top,
    'classes', jsonb_build_object(
      'bookings', v_class_bookings,
      'revenue',  v_class_rev,
      'tracks', jsonb_build_object(
        'bread',  (SELECT count(*) FROM public.orders o, LATERAL jsonb_array_elements(o.items) it
                    WHERE o.kind = 'class' AND it->>'slug' LIKE 'bread-%'),
        'pastry', (SELECT count(*) FROM public.orders o, LATERAL jsonb_array_elements(o.items) it
                    WHERE o.kind = 'class' AND it->>'slug' LIKE 'pastry-%')
      ),
      'published', (SELECT count(*) FROM public.classes WHERE published IS NOT FALSE)
    ),
    'customers', jsonb_build_object(
      'total',  (SELECT count(*) FROM public.customer_profiles),
      'repeat', (SELECT count(*) FROM (
                   SELECT phone FROM public.orders GROUP BY phone HAVING count(*) > 1
                 ) r),
      'top', coalesce((
        SELECT jsonb_agg(jsonb_build_object('name', name, 'phone', phone, 'orders', n, 'revenue', rev) ORDER BY rev DESC)
        FROM (
          SELECT max(customer_name) AS name, phone, count(*) AS n, sum(total) AS rev
          FROM public.orders GROUP BY phone ORDER BY rev DESC LIMIT 5
        ) t
      ), '[]'::jsonb)
    ),
    'channels', jsonb_build_object(
      'momo',         coalesce(v_settings.momo_verified, FALSE),
      'bank',         coalesce(v_settings.bank_verified, FALSE),
      'cashDelivery', coalesce(v_settings.cash_delivery_enabled, FALSE),
      'cashPickup',   coalesce(v_settings.cash_pickup_enabled, FALSE),
      'threshold',    coalesce(v_settings.advance_threshold, 70000)
    ),
    'catalogue', jsonb_build_object(
      'productsPublished', (SELECT count(*) FROM public.products WHERE published IS NOT FALSE),
      'productsHidden',    (SELECT count(*) FROM public.products WHERE published = FALSE),
      'quoteOnly',         (SELECT count(*) FROM public.products WHERE price IS NULL),
      'categories',        (SELECT count(*) FROM public.categories WHERE published IS NOT FALSE),
      'classesPublished',  (SELECT count(*) FROM public.classes WHERE published IS NOT FALSE)
    )
  );
END;
$$;

-- Helper for the KPI deltas (NULL when there is no previous figure to divide by)
CREATE OR REPLACE FUNCTION public.pct_change(p_now INTEGER, p_prev INTEGER)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_prev IS NULL OR p_prev = 0 THEN NULL::NUMERIC
    ELSE round(((p_now - p_prev)::NUMERIC / p_prev) * 100, 1)
  END;
$$;

-- -----------------------------------------------------------------------------
-- 5. api_admin_settings — read and update payment details & business rules
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_settings(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p       JSONB := coalesce(p_payload, '{}'::jsonb);
  v_int     INTEGER;
  v_bool    BOOLEAN;
BEGIN
  IF NOT public.has_admin_permission('settings') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator settings permission required.');
  END IF;

  IF v_p <> '{}'::jsonb THEN

    -- Mobile Money
    IF v_p ? 'momo_name'     THEN UPDATE public.settings SET momo_name     = left(btrim(coalesce(v_p->>'momo_name', '')), 120)     WHERE id = 1; END IF;
    IF v_p ? 'momo_number'   THEN UPDATE public.settings SET momo_number   = left(btrim(coalesce(v_p->>'momo_number', '')), 40)    WHERE id = 1; END IF;
    IF v_p ? 'momo_provider' THEN UPDATE public.settings SET momo_provider = left(btrim(coalesce(v_p->>'momo_provider', '')), 80)  WHERE id = 1; END IF;
    IF v_p ? 'momo_note'     THEN UPDATE public.settings SET momo_note     = left(btrim(coalesce(v_p->>'momo_note', '')), 200)     WHERE id = 1; END IF;

    -- Bank
    IF v_p ? 'bank_name'           THEN UPDATE public.settings SET bank_name           = left(btrim(coalesce(v_p->>'bank_name', '')), 120)           WHERE id = 1; END IF;
    IF v_p ? 'bank_account_name'   THEN UPDATE public.settings SET bank_account_name   = left(btrim(coalesce(v_p->>'bank_account_name', '')), 120)   WHERE id = 1; END IF;
    IF v_p ? 'bank_account_number' THEN UPDATE public.settings SET bank_account_number = left(btrim(coalesce(v_p->>'bank_account_number', '')), 60) WHERE id = 1; END IF;

    -- Verified flags arrive as '1'/'0' strings from checkboxes
    IF v_p ? 'momo_verified' THEN
      v_bool := public.as_bool(v_p->>'momo_verified');
      UPDATE public.settings SET momo_verified = v_bool WHERE id = 1;
    END IF;
    IF v_p ? 'bank_verified' THEN
      v_bool := public.as_bool(v_p->>'bank_verified');
      UPDATE public.settings SET bank_verified = v_bool WHERE id = 1;
    END IF;

    -- Cash channels
    IF v_p ? 'cash_delivery_enabled' THEN
      v_bool := public.as_bool(v_p->>'cash_delivery_enabled');
      UPDATE public.settings SET cash_delivery_enabled = v_bool WHERE id = 1;
    END IF;
    IF v_p ? 'cash_pickup_enabled' THEN
      v_bool := public.as_bool(v_p->>'cash_pickup_enabled');
      UPDATE public.settings SET cash_pickup_enabled = v_bool WHERE id = 1;
    END IF;

    IF v_p ? 'auto_confirm_on_verified_payment' THEN
      v_bool := public.as_bool(v_p->>'auto_confirm_on_verified_payment');
      UPDATE public.settings SET auto_confirm = v_bool WHERE id = 1;
    END IF;

    -- Advance threshold. The admin form sends cedis; anything under 1000 is
    -- treated as cedis and converted, so both units are accepted safely.
    IF v_p ? 'advance_threshold' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'advance_threshold'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 100000000 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_threshold',
          'error', 'The advance threshold must be a positive amount.');
      END IF;
      IF v_int > 0 AND v_int < 1000 THEN
        v_int := v_int * 100;
      END IF;
      UPDATE public.settings SET advance_threshold = v_int WHERE id = 1;
    END IF;

    -- Bundle percentages (class discounts)
    IF v_p ? 'bundle_two_pct' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'bundle_two_pct'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 90 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_pct',
          'error', 'The two-class discount must be between 0% and 90%.');
      END IF;
      UPDATE public.settings SET bundle_two_pct = v_int WHERE id = 1;
    END IF;
    IF v_p ? 'bundle_three_pct' THEN
      v_int := round(coalesce(nullif(btrim(v_p->>'bundle_three_pct'), ''), '0')::NUMERIC);
      IF v_int IS NULL OR v_int < 0 OR v_int > 90 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_pct',
          'error', 'The three-class discount must be between 0% and 90%.');
      END IF;
      UPDATE public.settings SET bundle_three_pct = v_int WHERE id = 1;
    END IF;

    -- WhatsApp number for baker alerts
    IF v_p ? 'whatsapp_number' THEN
      UPDATE public.settings
      SET whatsapp_number = regexp_replace(coalesce(v_p->>'whatsapp_number', ''), '\D', '', 'g')
      WHERE id = 1;
    END IF;

    UPDATE public.settings SET updated_at = NOW() WHERE id = 1;
  END IF;

  RETURN jsonb_build_object(
    'ok',       TRUE,
    'settings', (SELECT to_jsonb(s) FROM public.settings s WHERE s.id = 1),
    'config',   (public.api_config())->'config'
  );
END;
$$;

-- '1' / '0' / 'true' / 'false' / booleans all arrive as text from the form
CREATE OR REPLACE FUNCTION public.as_bool(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(btrim(coalesce(p_value, ''))) IN ('1', 'true', 't', 'yes', 'on');
$$;

-- -----------------------------------------------------------------------------
-- 6. api_admin_catalogue — everything the admin panels render
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_catalogue()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prods JSONB;
  v_cats  JSONB;
BEGIN
  -- The dashboard uses this for several panels, two of which need only 'view'.
  IF NOT (public.has_admin_permission('catalogue') OR public.has_admin_permission('view')) THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator permission required.');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'sku',         p.sku,
           'name',        p.name,
           'category',    p.category,
           'price',       p.price,
           'discountPct', p.discount_pct,
           'prepDays',    p.prep_days,
           'meta',        p.meta,
           'description', p.description,
           'image',       p.image,
           'published',   p.published
         ) ORDER BY p.category, p.sku), '[]'::jsonb)
  INTO v_prods
  FROM public.products p;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'slug',      c.slug,
           'name',      c.name,
           'intro',     c.intro,
           'published', c.published,
           'sortOrder', c.sort_order,
           'products',  coalesce((
             SELECT jsonb_agg(jsonb_build_object('sku', p.sku, 'name', p.name, 'price', p.price, 'published', p.published)
                              ORDER BY p.sku)
             FROM public.products p WHERE p.category = c.slug
           ), '[]'::jsonb)
         ) ORDER BY c.sort_order, c.slug), '[]'::jsonb)
  INTO v_cats
  FROM public.categories c;

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'categories', v_cats,
    'products',   v_prods,
    'classes',    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'slug', k.slug, 'track', k.track, 'level', k.level,
               'levelLabel', k.level_label, 'name', k.name, 'summary', k.summary,
               'fee', k.fee, 'hours', k.hours, 'schedule', k.schedule,
               'published', k.published
             ) ORDER BY k.track, k.level)
      FROM public.classes k
    ), '[]'::jsonb),
    'options', coalesce((
      SELECT jsonb_object_agg(o.kind, o.items)
      FROM (
        SELECT co.kind,
               jsonb_agg(jsonb_build_object('key', co.key, 'label', co.label) || coalesce(co.payload, '{}'::jsonb)
                         ORDER BY co.key) AS items
        FROM public.cake_options co GROUP BY co.kind
      ) o
    ), '{}'::jsonb),
    'settings', (SELECT to_jsonb(s) FROM public.settings s WHERE s.id = 1),
    'config',   (public.api_config())->'config'
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. api_admin_discounts — product and class discounts
--    Class discounts only ever apply when 2 or more classes are selected; that
--    rule is enforced where the order is priced, not here.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_discounts(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_pct  INTEGER;
  v_row  RECORD;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_p ? 'bundle_two_pct' THEN
    v_pct := round(coalesce(v_p->>'bundle_two_pct', '0')::NUMERIC);
    IF v_pct < 0 OR v_pct > 90 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error',
        'Two-class discount percentage must be between 0% and 90%.');
    END IF;
    UPDATE public.settings SET bundle_two_pct = v_pct, updated_at = NOW() WHERE id = 1;
  END IF;

  IF v_p ? 'bundle_three_pct' THEN
    v_pct := round(coalesce(v_p->>'bundle_three_pct', '0')::NUMERIC);
    IF v_pct < 0 OR v_pct > 90 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error',
        'Three-or-more class discount percentage must be between 0% and 90%.');
    END IF;
    UPDATE public.settings SET bundle_three_pct = v_pct, updated_at = NOW() WHERE id = 1;
  END IF;

  IF coalesce((v_p->>'clearAll')::BOOLEAN, FALSE) THEN
    UPDATE public.products SET discount_pct = 0;
  END IF;

  IF v_p ? 'category' AND v_p ? 'discountPct' THEN
    v_pct := greatest(0, least(90, round(coalesce(v_p->>'discountPct', '0')::NUMERIC)::INTEGER));
    IF v_p->>'category' = 'all' THEN
      UPDATE public.products SET discount_pct = v_pct;
    ELSE
      UPDATE public.products SET discount_pct = v_pct WHERE category = v_p->>'category';
    END IF;
  END IF;

  IF v_p ? 'sku' AND v_p ? 'discountPct' THEN
    v_pct := greatest(0, least(90, round(coalesce(v_p->>'discountPct', '0')::NUMERIC)::INTEGER));
    UPDATE public.products SET discount_pct = v_pct WHERE sku = v_p->>'sku';
  END IF;

  -- Bulk forms: {"products": {"milky-6": 10, ...}} or [{"sku":..,"discountPct":..}]
  IF v_p ? 'products' OR v_p ? 'product_discounts' THEN
    IF jsonb_typeof(coalesce(v_p->'products', v_p->'product_discounts')) = 'array' THEN
      FOR v_row IN
        SELECT * FROM jsonb_array_elements(coalesce(v_p->'products', v_p->'product_discounts'))
      LOOP
        IF v_row.value ? 'sku' THEN
          UPDATE public.products
          SET discount_pct = greatest(0, least(90, round(coalesce(v_row.value->>'discountPct', '0')::NUMERIC)::INTEGER))
          WHERE sku = v_row.value->>'sku';
        END IF;
      END LOOP;
    ELSE
      FOR v_row IN
        SELECT key, value FROM jsonb_each_text(coalesce(v_p->'products', v_p->'product_discounts'))
      LOOP
        UPDATE public.products
        SET discount_pct = greatest(0, least(90, round(coalesce(v_row.value, '0')::NUMERIC)::INTEGER))
        WHERE sku = v_row.key;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'config',     (public.api_config())->'config',
    'settings',   (SELECT to_jsonb(s) FROM public.settings s WHERE s.id = 1),
    'bundle',     jsonb_build_object(
                    'bundle_two_pct',   (SELECT bundle_two_pct   FROM public.settings WHERE id = 1),
                    'bundle_three_pct', (SELECT bundle_three_pct FROM public.settings WHERE id = 1)
                  ),
    'products',   (public.api_admin_catalogue())->'products',
    'classes',    (public.api_admin_catalogue())->'classes',
    'categories', (public.api_admin_catalogue())->'categories'
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. api_admin_notifications — the baker's alert outbox
--    There is no notifications table; the outbox is derived from orders and
--    orders.notified_at, which the notify-order function sets on success.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_notifications(p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows JSONB;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator permission required.');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'order_ref',  o.ref,
           'channel',    'whatsapp_baker',
           'status',     CASE WHEN o.notified_at IS NOT NULL THEN 'sent' ELSE 'queued_no_credentials' END,
           'detail',     o.customer_name || ' · '
                         || coalesce((SELECT string_agg(
                                       coalesce(it->>'qty', '1') || '×' || coalesce(it->>'name', it->>'sku', 'item'),
                                       ', ')
                                     FROM jsonb_array_elements(o.items) it), 'no items'),
           'payload',    'New Order ' || o.ref || ' — ' || o.customer_name
                         || ' · ' || to_char(o.created_at, 'DD Mon HH24:MI'),
           'created_at', o.created_at,
           'notified_at', o.notified_at
         ) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM public.orders ORDER BY created_at DESC LIMIT 100
  ) o;

  RETURN jsonb_build_object('ok', TRUE, 'notifications', v_rows);
END;
$$;

-- -----------------------------------------------------------------------------
-- 9-12. Catalogue write RPCs — product / class / category / cake option
--        All take (p_method, p_payload) exactly as the admin panels send them.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_product(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_sku  TEXT := btrim(coalesce(v_p->>'sku', ''));
  v_price INTEGER;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'POST' THEN
    IF coalesce(btrim(v_p->>'name'), '') = '' OR coalesce(btrim(v_p->>'category'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A product needs a name and a category.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.categories WHERE slug = v_p->>'category') THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'That category does not exist.');
    END IF;

    -- Derive a stable sku from the name when one was not supplied
    v_sku := coalesce(nullif(v_sku, ''), regexp_replace(lower(v_p->>'name'), '[^a-z0-9]+', '-', 'g'));
    v_sku := btrim(regexp_replace(v_sku, '(^-+|-+$)', '', 'g'), '-');
    IF v_sku = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'Could not derive a SKU from that name.');
    END IF;
    IF EXISTS (SELECT 1 FROM public.products WHERE sku = v_sku) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_sku',
        'error', 'A product with that name already exists. Choose a different name.');
    END IF;

    INSERT INTO public.products (sku, name, category, price, meta, description, prep_days, published)
    VALUES (
      v_sku,
      left(btrim(v_p->>'name'), 160),
      v_p->>'category',
      CASE WHEN v_p ? 'price' AND v_p->>'price' IS NOT NULL AND btrim(v_p->>'price') <> ''
           THEN (v_p->>'price')::INTEGER ELSE NULL END,
      left(coalesce(v_p->>'meta', ''), 120),
      left(coalesce(v_p->>'description', ''), 400),
      greatest(0, least(30, coalesce((v_p->>'prepDays')::INTEGER, 0))),
      TRUE
    );
    RETURN jsonb_build_object('ok', TRUE, 'sku', v_sku);
  END IF;

  IF v_sku = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A SKU is required.');
  END IF;

  IF v_m = 'DELETE' THEN
    DELETE FROM public.products WHERE sku = v_sku;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Product not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  -- PATCH: update only the fields actually supplied
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE sku = v_sku) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Product not found.');
  END IF;

  IF v_p ? 'name'        THEN UPDATE public.products SET name        = left(btrim(v_p->>'name'), 160)        WHERE sku = v_sku; END IF;
  IF v_p ? 'meta'        THEN UPDATE public.products SET meta        = left(coalesce(v_p->>'meta', ''), 120) WHERE sku = v_sku; END IF;
  IF v_p ? 'description' THEN UPDATE public.products SET description = left(coalesce(v_p->>'description', ''), 400) WHERE sku = v_sku; END IF;
  IF v_p ? 'image'       THEN UPDATE public.products SET image       = left(coalesce(v_p->>'image', ''), 200) WHERE sku = v_sku; END IF;
  IF v_p ? 'published'   THEN UPDATE public.products SET published   = public.as_bool(v_p->>'published')    WHERE sku = v_sku; END IF;
  IF v_p ? 'discountPct' THEN
    UPDATE public.products
    SET discount_pct = greatest(0, least(90, coalesce((v_p->>'discountPct')::NUMERIC, 0)::INTEGER))
    WHERE sku = v_sku;
  END IF;
  IF v_p ? 'prepDays' THEN
    UPDATE public.products
    SET prep_days = greatest(0, least(30, coalesce((v_p->>'prepDays')::INTEGER, 0)))
    WHERE sku = v_sku;
  END IF;
  IF v_p ? 'category' AND coalesce(btrim(v_p->>'category'), '') <> '' THEN
    IF NOT EXISTS (SELECT 1 FROM public.categories WHERE slug = v_p->>'category') THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'That category does not exist.');
    END IF;
    UPDATE public.products SET category = v_p->>'category' WHERE sku = v_sku;
  END IF;
  IF v_p ? 'price' THEN
    v_price := CASE WHEN v_p->>'price' IS NULL OR btrim(v_p->>'price') = ''
                    THEN NULL ELSE (v_p->>'price')::INTEGER END;
    IF v_price IS NOT NULL AND v_price < 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A price cannot be negative.');
    END IF;
    UPDATE public.products SET price = v_price WHERE sku = v_sku;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'sku', v_sku);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_class(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_slug TEXT := btrim(coalesce(v_p->>'slug', ''));
  v_fee  INTEGER;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'POST' THEN
    IF coalesce(btrim(v_p->>'name'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A course needs a name.');
    END IF;
    v_fee := coalesce((v_p->>'fee')::INTEGER, 0);
    IF v_fee < 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A course fee cannot be negative.');
    END IF;

    v_slug := coalesce(nullif(v_slug, ''), regexp_replace(lower(v_p->>'name'), '[^a-z0-9]+', '-', 'g'));
    v_slug := btrim(regexp_replace(v_slug, '(^-+|-+$)', '', 'g'), '-');
    IF EXISTS (SELECT 1 FROM public.classes WHERE slug = v_slug) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_slug',
        'error', 'A course with that name already exists.');
    END IF;

    INSERT INTO public.classes (slug, track, level, level_label, name, summary, fee, hours, published)
    VALUES (
      v_slug,
      CASE WHEN v_p->>'track' = 'pastry' THEN 'pastry' ELSE 'bread' END,
      greatest(1, least(3, coalesce((v_p->>'level')::INTEGER, 1))),
      CASE coalesce((v_p->>'level')::INTEGER, 1)
        WHEN 2 THEN 'Intermediate'
        WHEN 3 THEN 'Advanced'
        ELSE 'Beginner' END,
      left(btrim(v_p->>'name'), 160),
      left(coalesce(v_p->>'summary', ''), 400),
      v_fee,
      left(coalesce(nullif(btrim(v_p->>'hours'), ''), '1 week'), 80),
      TRUE
    );
    RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
  END IF;

  IF v_slug = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A course slug is required.');
  END IF;

  IF v_m = 'DELETE' THEN
    DELETE FROM public.classes WHERE slug = v_slug;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Course not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE slug = v_slug) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Course not found.');
  END IF;

  IF v_p ? 'fee' THEN
    v_fee := coalesce((v_p->>'fee')::INTEGER, 0);
    IF v_fee < 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A course fee cannot be negative.');
    END IF;
    UPDATE public.classes SET fee = v_fee WHERE slug = v_slug;
  END IF;
  IF v_p ? 'hours'     THEN UPDATE public.classes SET hours     = left(coalesce(v_p->>'hours', ''), 80)     WHERE slug = v_slug; END IF;
  IF v_p ? 'summary'   THEN UPDATE public.classes SET summary   = left(coalesce(v_p->>'summary', ''), 400)  WHERE slug = v_slug; END IF;
  IF v_p ? 'name'      THEN UPDATE public.classes SET name      = left(btrim(v_p->>'name'), 160)            WHERE slug = v_slug; END IF;
  IF v_p ? 'published' THEN UPDATE public.classes SET published = public.as_bool(v_p->>'published')        WHERE slug = v_slug; END IF;

  RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_category(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_slug TEXT := btrim(coalesce(v_p->>'slug', ''));
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'POST' THEN
    IF coalesce(btrim(v_p->>'name'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A category needs a name.');
    END IF;
    v_slug := coalesce(nullif(v_slug, ''), regexp_replace(lower(v_p->>'name'), '[^a-z0-9]+', '-', 'g'));
    v_slug := btrim(regexp_replace(v_slug, '(^-+|-+$)', '', 'g'), '-');
    IF EXISTS (SELECT 1 FROM public.categories WHERE slug = v_slug) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_slug',
        'error', 'A category with that name already exists.');
    END IF;

    INSERT INTO public.categories (slug, name, intro, published, sort_order)
    VALUES (
      v_slug,
      left(btrim(v_p->>'name'), 120),
      left(coalesce(v_p->>'intro', ''), 400),
      TRUE,
      coalesce((SELECT max(sort_order) + 1 FROM public.categories), 0)
    );
    RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
  END IF;

  IF v_slug = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A category slug is required.');
  END IF;

  IF v_m = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.products WHERE category = v_slug) THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'category_in_use',
        'error', 'Move or delete the products in this category first.');
    END IF;
    DELETE FROM public.categories WHERE slug = v_slug;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Category not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  IF v_p ? 'name'      THEN UPDATE public.categories SET name      = left(btrim(v_p->>'name'), 120) WHERE slug = v_slug; END IF;
  IF v_p ? 'intro'     THEN UPDATE public.categories SET intro     = left(coalesce(v_p->>'intro', ''), 400) WHERE slug = v_slug; END IF;
  IF v_p ? 'published' THEN UPDATE public.categories SET published = public.as_bool(v_p->>'published') WHERE slug = v_slug; END IF;

  RETURN jsonb_build_object('ok', TRUE, 'slug', v_slug);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

CREATE OR REPLACE FUNCTION public.api_admin_option(
  p_method  TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_m    TEXT := upper(coalesce(p_method, 'PATCH'));
  v_p    JSONB := coalesce(p_payload, '{}'::jsonb);
  v_kind TEXT := btrim(coalesce(v_p->>'kind', ''));
  v_key  TEXT := btrim(coalesce(v_p->>'key', ''));
  v_patch JSONB := '{}'::jsonb;
  v_label TEXT;
BEGIN
  IF NOT public.has_admin_permission('catalogue') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised',
      'error', 'Administrator catalogue permission required.');
  END IF;

  IF v_m = 'DELETE' THEN
    IF v_kind = '' OR v_key = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A kind and key are required.');
    END IF;
    DELETE FROM public.cake_options WHERE kind = v_kind AND key = v_key;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Option not found.');
    END IF;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  IF v_m = 'POST' THEN
    IF v_kind = '' OR v_key = '' OR coalesce(btrim(v_p->>'label'), '') = '' THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', 'A kind, key and label are required.');
    END IF;
    v_patch := v_p - 'kind' - 'key' - 'label';
    INSERT INTO public.cake_options (kind, key, label, payload)
    VALUES (v_kind, v_key, left(btrim(v_p->>'label'), 200), v_patch)
    ON CONFLICT (kind, key) DO UPDATE
      SET label = EXCLUDED.label, payload = EXCLUDED.payload;
    RETURN jsonb_build_object('ok', TRUE);
  END IF;

  -- PATCH: merge the supplied pricing fields into the existing payload
  IF v_kind = '' OR v_key = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'A kind and key are required.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cake_options WHERE kind = v_kind AND key = v_key) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Option not found.');
  END IF;

  v_patch := v_p - 'kind' - 'key';
  v_label := nullif(btrim(coalesce(v_p->>'label', '')), '');

  UPDATE public.cake_options
  SET label   = coalesce(v_label, label),
      payload = coalesce(payload, '{}'::jsonb) || (v_patch - 'label')
  WHERE kind = v_kind AND key = v_key;

  RETURN jsonb_build_object('ok', TRUE);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_value',
      'error', 'One of the values sent was not a valid number.');
END;
$$;

-- -----------------------------------------------------------------------------
-- 13. Grants — every function checks its own authorisation internally, so
--     EXECUTE is granted broadly and the gate is has_admin_permission().
-- -----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.order_admin_json(public.orders)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pct_change(INTEGER, INTEGER)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.as_bool(TEXT)                            FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.api_lookup_order(TEXT, TEXT)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_orders(TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_order(TEXT)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_dashboard(INTEGER)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_settings(JSONB)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_catalogue()                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_discounts(JSONB)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_notifications(JSONB)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_product(TEXT, JSONB)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_class(TEXT, JSONB)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_category(TEXT, JSONB)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_option(TEXT, JSONB)         TO authenticated;

COMMIT;
