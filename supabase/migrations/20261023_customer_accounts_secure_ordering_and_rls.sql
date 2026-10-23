-- =============================================================================
-- Mystery Bakebite — Customer Accounts, Normalized Order/Payment Tables,
-- Strict Row-Level Security (RLS), Server-Side Price Validation, and
-- GH₵ 700.00 Threshold Enforcement
-- Migration: 20261023_customer_accounts_secure_ordering_and_rls.sql
-- Target: Supabase PostgreSQL 15+
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Customer Profiles Table & Safe Auth Sync Trigger
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.customer_profiles (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL DEFAULT '' CHECK (char_length(btrim(full_name)) <= 120),
  phone           TEXT NOT NULL DEFAULT '' CHECK (
                    phone = '' OR char_length(regexp_replace(phone, '\D', '', 'g')) BETWEEN 7 AND 15
                  ),
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_email
  ON public.customer_profiles (lower(email));

-- Automatically and idempotently create/update customer_profiles when an auth.users
-- row is inserted or updated. Never trusts user metadata for roles or privileges.
CREATE OR REPLACE FUNCTION public.trg_sync_customer_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name  TEXT;
  v_phone TEXT;
BEGIN
  -- Do not create a customer profile for the primary super admin if not needed,
  -- or allow both safely without granting any admin role from metadata.
  v_name := left(btrim(coalesce(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', '')), 120);
  v_phone := left(btrim(coalesce(NEW.raw_user_meta_data->>'phone', '')), 24);
  IF char_length(regexp_replace(v_phone, '\D', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    v_phone := '';
  END IF;

  INSERT INTO public.customer_profiles (
    user_id,
    email,
    full_name,
    phone,
    email_verified,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    lower(btrim(NEW.email)),
    v_name,
    v_phone,
    (NEW.email_confirmed_at IS NOT NULL),
    NOW(),
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET email          = lower(btrim(EXCLUDED.email)),
        full_name      = CASE WHEN char_length(btrim(public.customer_profiles.full_name)) >= 2
                              THEN public.customer_profiles.full_name
                              ELSE EXCLUDED.full_name END,
        phone          = CASE WHEN char_length(btrim(public.customer_profiles.phone)) >= 7
                              THEN public.customer_profiles.phone
                              ELSE EXCLUDED.phone END,
        email_verified = (NEW.email_confirmed_at IS NOT NULL),
        updated_at     = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_sync_customer_profile ON auth.users;
CREATE TRIGGER on_auth_user_sync_customer_profile
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_customer_profile();

-- Prevent customers from modifying immutable/privileged columns on customer_profiles
CREATE OR REPLACE FUNCTION public.trg_protect_customer_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := NOW();

  IF NOT public.is_verified_admin() THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR lower(NEW.email) IS DISTINCT FROM lower(OLD.email)
       OR NEW.email_verified IS DISTINCT FROM OLD.email_verified
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Customers may only update their own full_name and phone.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF char_length(btrim(coalesce(NEW.full_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Full name must be at least 2 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.phone <> '' AND char_length(regexp_replace(NEW.phone, '\D', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    RAISE EXCEPTION 'Phone number must contain 7 to 15 digits.'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_customer_profile ON public.customer_profiles;
CREATE TRIGGER protect_customer_profile
  BEFORE UPDATE ON public.customer_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_protect_customer_profile();

-- -----------------------------------------------------------------------------
-- 2. Settings Threshold Alignment (GH₵ 700.00 = 70000 pesewas) & Orders Columns
-- -----------------------------------------------------------------------------

ALTER TABLE public.settings
  ALTER COLUMN advance_threshold SET DEFAULT 70000;

UPDATE public.settings
SET advance_threshold = 70000
WHERE id = 1 AND advance_threshold = 15000;

-- Link orders to the authenticated customer account (retaining orders on user deletion)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id_created_at
  ON public.orders (customer_id, created_at DESC);

-- Ensure order_status constraint supports 'ready' alongside existing statuses
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_order_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_order_status_check
  CHECK (order_status IN ('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled'));

-- Ensure ref constraint allows both MB-XXXXXX and MB-YYMMDD-XXXX formats
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_ref_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_ref_check
  CHECK (ref ~ '^M[BC]-[A-Z0-9-]{4,20}$');

-- -----------------------------------------------------------------------------
-- 3. Normalized Order Items, Payments, and Class Bookings Tables
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref     TEXT NOT NULL REFERENCES public.orders(ref) ON DELETE CASCADE,
  customer_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  line_index    INTEGER NOT NULL CHECK (line_index >= 0),
  item_kind     TEXT NOT NULL CHECK (item_kind IN ('product', 'custom_cake', 'class')),
  product_sku   TEXT REFERENCES public.products(sku) ON UPDATE CASCADE ON DELETE SET NULL,
  class_slug    TEXT REFERENCES public.classes(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  item_name     TEXT NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 200),
  item_meta     TEXT NOT NULL DEFAULT '',
  qty           INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 100),
  unit_price    INTEGER CHECK (unit_price IS NULL OR unit_price >= 0),
  discount_pct  INTEGER NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 90),
  line_discount INTEGER NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  line_total    INTEGER CHECK (line_total IS NULL OR line_total >= 0),
  prep_days     INTEGER NOT NULL DEFAULT 0 CHECK (prep_days BETWEEN 0 AND 30),
  custom_spec   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_ref, line_index)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_ref
  ON public.order_items (order_ref);

CREATE INDEX IF NOT EXISTS idx_order_items_customer_id
  ON public.order_items (customer_id);

CREATE TABLE IF NOT EXISTS public.payments (
  id                                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref                               TEXT NOT NULL UNIQUE REFERENCES public.orders(ref) ON DELETE CASCADE,
  customer_id                             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payment_method                          TEXT NOT NULL CHECK (payment_method IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery')),
  expected_amount                         INTEGER NOT NULL CHECK (expected_amount >= 0),
  transaction_reference                   TEXT NOT NULL DEFAULT '',
  proof_image_path                        TEXT NOT NULL DEFAULT '',
  customer_note                           TEXT NOT NULL DEFAULT '',
  verification_status                     TEXT NOT NULL DEFAULT 'awaiting_payment'
                                          CHECK (verification_status IN ('awaiting_payment', 'payment_submitted', 'payment_verified', 'payment_rejected', 'pay_on_collection', 'not_required')),
  requires_pre_confirmation_verification  BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at                            TIMESTAMPTZ,
  verified_at                             TIMESTAMPTZ,
  verified_by                             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reject_reason                           TEXT NOT NULL DEFAULT '',
  created_at                              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_customer_id
  ON public.payments (customer_id);

CREATE TABLE IF NOT EXISTS public.class_bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref     TEXT NOT NULL UNIQUE REFERENCES public.orders(ref) ON DELETE CASCADE,
  customer_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  courses         JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundles         JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal        INTEGER NOT NULL CHECK (subtotal >= 0),
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total           INTEGER NOT NULL CHECK (total >= 0),
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery')),
  payment_status  TEXT NOT NULL DEFAULT 'awaiting_payment'
                  CHECK (payment_status IN ('awaiting_payment', 'payment_submitted', 'payment_verified', 'payment_rejected', 'pay_on_collection', 'not_required')),
  booking_status  TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (booking_status IN ('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled')),
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_class_bookings_customer_id
  ON public.class_bookings (customer_id);

-- -----------------------------------------------------------------------------
-- 4. Order & Payment Integrity Trigger (Enforces GH₵ 700.00 Threshold & Status Rules)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_order_payment_state_machine()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_threshold INTEGER := 70000;
BEGIN
  SELECT coalesce(s.advance_threshold, 70000) INTO v_threshold
  FROM public.settings s
  WHERE s.id = 1;

  NEW.updated_at := NOW();

  -- 1. Verified payments are permanently locked and cannot be reverted
  IF OLD.payment_status = 'payment_verified' AND NEW.payment_status <> 'payment_verified' THEN
    RAISE EXCEPTION 'Verified payments are permanently locked and cannot be reverted.'
      USING ERRCODE = 'P0001', HINT = 'already_verified';
  END IF;

  -- 2. Only an authorized administrator with 'verify' permission can mark payment_verified
  IF NEW.payment_status = 'payment_verified' AND OLD.payment_status <> 'payment_verified' THEN
    IF NOT public.has_admin_permission('verify') AND current_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'Unauthorised: only a verified administrator can confirm payment.'
        USING ERRCODE = '42501', HINT = 'unauthorised';
    END IF;
    NEW.proof_locked := TRUE;
    NEW.verified_at := COALESCE(NEW.verified_at, NOW());
    -- Record which administrator confirmed the payment. auth.uid() is a UUID,
    -- matching the reconciled column type (TEXT/'' was the old, broken shape).
    NEW.verified_by := COALESCE(NEW.verified_by, auth.uid());
  END IF;

  -- 2b. Keep the normalised mirrors in step with the canonical orders row, so
  --     payments.verification_status / verified_by and class_bookings.payment_status
  --     cannot drift from orders.payment_status once a payment is confirmed or rejected.
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status IN ('payment_verified', 'payment_rejected') THEN

    UPDATE public.payments
       SET verification_status = NEW.payment_status,
           verified_at  = CASE WHEN NEW.payment_status = 'payment_verified'
                               THEN NEW.verified_at ELSE payments.verified_at END,
           verified_by  = CASE WHEN NEW.payment_status = 'payment_verified'
                               THEN NEW.verified_by ELSE payments.verified_by END,
           reject_reason = CASE WHEN NEW.payment_status = 'payment_rejected'
                                THEN COALESCE(NEW.reject_reason, '')
                                ELSE payments.reject_reason END,
           updated_at   = NOW()
     WHERE order_ref = NEW.ref;

    UPDATE public.class_bookings
       SET payment_status = NEW.payment_status,
           updated_at     = NOW()
     WHERE booking_ref = NEW.ref;
  END IF;

  -- 3. Block duplicate customer payment submissions when proof is already submitted or locked
  IF NEW.payment_status = 'payment_submitted' THEN
    IF OLD.payment_status = 'payment_verified' THEN
      RAISE EXCEPTION 'Payment for this order has already been verified.'
        USING ERRCODE = 'P0001', HINT = 'already_verified';
    END IF;

    IF (OLD.payment_status = 'payment_submitted' OR OLD.proof_locked = TRUE)
       AND OLD.payment_status <> 'payment_rejected'
       AND (
         NEW.submission_count <> OLD.submission_count
         OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
         OR NEW.proof_path IS DISTINCT FROM OLD.proof_path
       )
       AND NOT public.has_admin_permission('verify')
    THEN
      RAISE EXCEPTION 'Duplicate payment submission blocked: payment details are already on file and awaiting verification.'
        USING ERRCODE = 'P0001', HINT = 'duplicate_submission';
    END IF;
  END IF;

  -- 4. Prevent immutable financial & ownership columns from being altered after creation
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.discount IS DISTINCT FROM OLD.discount
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'Order ownership and agreed monetary totals are immutable.'
      USING ERRCODE = '42501', HINT = 'immutable_order_fields';
  END IF;

  -- 5. Special Order Threshold (Strictly Greater Than GH₵ 700.00 / 70000 pesewas):
  --    Orders with total > v_threshold (or advance_required = TRUE) MUST NOT transition
  --    to 'confirmed', 'in_preparation', 'ready', or 'completed' until payment_status = 'payment_verified'.
  IF NEW.order_status IN ('confirmed', 'in_preparation', 'ready', 'completed')
     AND (NEW.total > v_threshold OR NEW.advance_required = TRUE)
     AND NEW.payment_status <> 'payment_verified' THEN
    RAISE EXCEPTION 'Orders strictly above GH₵ 700.00 require verified payment before they can be confirmed or prepared.'
      USING ERRCODE = 'P0001', HINT = 'payment_verification_required';
  END IF;

  -- 6. Prevent completed or cancelled orders from transitioning backwards
  IF OLD.order_status = 'cancelled' AND NEW.order_status <> 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled orders cannot be reopened.'
      USING ERRCODE = 'P0001', HINT = 'invalid_status_transition';
  END IF;

  IF OLD.order_status = 'completed' AND NEW.order_status <> 'completed' THEN
    RAISE EXCEPTION 'Completed orders are finalized and cannot change status.'
      USING ERRCODE = 'P0001', HINT = 'invalid_status_transition';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_payment_state_machine ON public.orders;
DROP TRIGGER IF EXISTS trg_enforce_order_payment_state_machine ON public.orders;
CREATE TRIGGER trg_orders_payment_state_machine
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_order_payment_state_machine();

-- -----------------------------------------------------------------------------
-- 5. Row-Level Security (RLS) Policies & Strict Table Grants
-- -----------------------------------------------------------------------------

ALTER TABLE public.categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cake_options        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_bookings      ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_profiles   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orders              FORCE ROW LEVEL SECURITY;
ALTER TABLE public.order_items         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payments            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.class_bookings      FORCE ROW LEVEL SECURITY;

-- Customer Profiles: customers may read and update ONLY their own row; admins may read all
DROP POLICY IF EXISTS "customer_read_own_profile" ON public.customer_profiles;
CREATE POLICY "customer_read_own_profile" ON public.customer_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_verified_admin());

DROP POLICY IF EXISTS "customer_update_own_profile" ON public.customer_profiles;
CREATE POLICY "customer_update_own_profile" ON public.customer_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Orders: authenticated customers may read ONLY their own orders (customer_id = auth.uid());
-- verified admins may read all and update orders if permitted.
DROP POLICY IF EXISTS "customer_read_own_orders" ON public.orders;
CREATE POLICY "customer_read_own_orders" ON public.orders
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

-- Order Items: authenticated customers may read ONLY their own order items
DROP POLICY IF EXISTS "customer_read_own_order_items" ON public.order_items;
CREATE POLICY "customer_read_own_order_items" ON public.order_items
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

-- Payments: authenticated customers may read ONLY their own payment records
DROP POLICY IF EXISTS "customer_read_own_payments" ON public.payments;
CREATE POLICY "customer_read_own_payments" ON public.payments
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

DROP POLICY IF EXISTS "admin_write_payments" ON public.payments;
CREATE POLICY "admin_write_payments" ON public.payments
  FOR ALL TO authenticated
  USING (public.has_admin_permission('verify'))
  WITH CHECK (public.has_admin_permission('verify'));

-- Payment Submissions: authenticated customers may read ONLY submissions for their own orders
DROP POLICY IF EXISTS "customer_read_own_payment_submissions" ON public.payment_submissions;
CREATE POLICY "customer_read_own_payment_submissions" ON public.payment_submissions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.ref = payment_submissions.order_ref
        AND o.customer_id = auth.uid()
    )
    OR public.is_verified_admin()
  );

-- Class Bookings: authenticated customers may read ONLY their own class bookings
DROP POLICY IF EXISTS "customer_read_own_class_bookings" ON public.class_bookings;
CREATE POLICY "customer_read_own_class_bookings" ON public.class_bookings
  FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.is_verified_admin());

-- Restrict direct table privileges: anonymous users can only SELECT public catalogue tables;
-- authenticated users can SELECT their own records (filtered by RLS) and UPDATE permitted
-- profile columns, but cannot directly INSERT/UPDATE/DELETE orders, order_items, payments,
-- payment_submissions, or class_bookings (all mutations go through trusted SECURITY DEFINER RPCs).
REVOKE ALL ON public.customer_profiles   FROM anon, authenticated;
REVOKE ALL ON public.orders              FROM anon, authenticated;
REVOKE ALL ON public.order_items         FROM anon, authenticated;
REVOKE ALL ON public.payments            FROM anon, authenticated;
REVOKE ALL ON public.payment_submissions FROM anon, authenticated;
REVOKE ALL ON public.class_bookings      FROM anon, authenticated;
REVOKE ALL ON public.admin_users         FROM anon, authenticated;
REVOKE ALL ON public.admin_audit_log     FROM anon, authenticated;
REVOKE ALL ON public.settings            FROM anon, authenticated;

GRANT SELECT ON public.categories, public.products, public.classes, public.cake_options TO anon, authenticated;
GRANT SELECT, UPDATE (full_name, phone, updated_at) ON public.customer_profiles TO authenticated;
GRANT SELECT ON public.orders, public.order_items, public.payments, public.payment_submissions, public.class_bookings TO authenticated;
GRANT SELECT ON public.admin_users, public.admin_audit_log, public.settings TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Customer Profile & Account History RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_customer_whoami()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_email         TEXT;
  v_confirmed_at  TIMESTAMPTZ;
  v_profile       public.customer_profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'signedIn', FALSE,
      'emailVerified', FALSE,
      'profile', NULL
    );
  END IF;

  SELECT lower(btrim(u.email)), u.email_confirmed_at
  INTO v_email, v_confirmed_at
  FROM auth.users u
  WHERE u.id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', TRUE, 'signedIn', FALSE, 'emailVerified', FALSE, 'profile', NULL);
  END IF;

  INSERT INTO public.customer_profiles (user_id, email, email_verified)
  VALUES (v_uid, v_email, (v_confirmed_at IS NOT NULL))
  ON CONFLICT (user_id) DO UPDATE
    SET email_verified = (v_confirmed_at IS NOT NULL)
  RETURNING * INTO v_profile;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'signedIn', TRUE,
    'emailVerified', v_profile.email_verified,
    'profile', jsonb_build_object(
      'userId', v_profile.user_id,
      'email', v_profile.email,
      'fullName', v_profile.full_name,
      'phone', v_profile.phone,
      'emailVerified', v_profile.email_verified,
      'createdAt', v_profile.created_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_customer_update_profile(
  p_full_name TEXT,
  p_phone     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_name    TEXT := btrim(coalesce(p_full_name, ''));
  v_phone   TEXT := btrim(coalesce(p_phone, ''));
  v_digits  TEXT := regexp_replace(v_phone, '\D', '', 'g');
  v_profile public.customer_profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'auth_required', 'error', 'Please sign in to update your profile.');
  END IF;

  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_name', 'error', 'Please enter your full name (2 to 120 characters).');
  END IF;

  IF char_length(v_digits) < 7 OR char_length(v_digits) > 15 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_phone', 'error', 'Please enter a valid phone number (7 to 15 digits).');
  END IF;

  UPDATE public.customer_profiles
  SET full_name  = v_name,
      phone      = v_phone,
      updated_at = NOW()
  WHERE user_id = v_uid
  RETURNING * INTO v_profile;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Customer profile not found.');
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'profile', jsonb_build_object(
      'userId', v_profile.user_id,
      'email', v_profile.email,
      'fullName', v_profile.full_name,
      'phone', v_profile.phone,
      'emailVerified', v_profile.email_verified,
      'createdAt', v_profile.created_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_customer_orders()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_orders   JSONB;
  v_bookings JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'auth_required', 'error', 'Please sign in to view your order history.');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'ref', o.ref,
    'kind', o.kind,
    'customerId', o.customer_id,
    'customer', jsonb_build_object('name', o.customer_name, 'phone', o.phone, 'email', o.email),
    'fulfilment', o.fulfilment,
    'address', o.address,
    'eventDate', o.event_date,
    'paymentMethod', o.payment_method,
    'paymentStatus', o.payment_status,
    'orderStatus', o.order_status,
    'subtotal', o.subtotal,
    'discount', o.discount,
    'total', o.total,
    'advanceRequired', o.advance_required,
    'items', o.items,
    'notes', o.notes,
    'paymentRef', o.payment_ref,
    'hasProof', o.has_proof,
    'proofLocked', o.proof_locked,
    'rejectReason', o.reject_reason,
    'verifiedAt', o.verified_at,
    'createdAt', o.created_at
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_orders
  FROM public.orders o
  WHERE o.customer_id = v_uid
    AND o.kind = 'product';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'ref', o.ref,
    'kind', o.kind,
    'customerId', o.customer_id,
    'customer', jsonb_build_object('name', o.customer_name, 'phone', o.phone, 'email', o.email),
    'paymentMethod', o.payment_method,
    'paymentStatus', o.payment_status,
    'orderStatus', o.order_status,
    'subtotal', o.subtotal,
    'discount', o.discount,
    'total', o.total,
    'items', o.items,
    'notes', o.notes,
    'paymentRef', o.payment_ref,
    'hasProof', o.has_proof,
    'proofLocked', o.proof_locked,
    'rejectReason', o.reject_reason,
    'verifiedAt', o.verified_at,
    'createdAt', o.created_at
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_bookings
  FROM public.orders o
  WHERE o.customer_id = v_uid
    AND o.kind = 'class';

  RETURN jsonb_build_object(
    'ok', TRUE,
    'orders', v_orders,
    'bookings', v_bookings
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Trusted Server-Side Order Creation & Price Calculation RPC (api_place_order)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_place_order(
  p_kind    TEXT,
  p_payload JSONB,
  p_idem    TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_auth_email    TEXT;
  v_confirmed_at  TIMESTAMPTZ;
  v_kind          TEXT := CASE WHEN lower(coalesce(p_kind, 'product')) = 'class' THEN 'class' ELSE 'product' END;
  v_idem          TEXT := nullif(btrim(coalesce(p_idem, p_payload->>'idemKey', '')), '');
  v_existing      public.orders%ROWTYPE;
  v_settings      public.settings%ROWTYPE;
  v_threshold     INTEGER := 70000;
  v_name          TEXT;
  v_phone         TEXT;
  v_email         TEXT;
  v_fulfil        TEXT;
  v_address       TEXT;
  v_event_date    TEXT;
  v_pay_method    TEXT;
  v_notes         TEXT;
  v_raw_items     JSONB;
  v_item          JSONB;
  v_idx           INTEGER := 0;
  v_qty           INTEGER;
  v_sku           TEXT;
  v_prod          public.products%ROWTYPE;
  v_cls           public.classes%ROWTYPE;
  v_unit_price    INTEGER;
  v_disc_pct      INTEGER;
  v_line_disc     INTEGER;
  v_line_total    INTEGER;
  v_prep_days     INTEGER;
  v_max_prep      INTEGER := 0;
  v_earliest_ymd  TEXT;
  v_subtotal      INTEGER := 0;
  v_discount      INTEGER := 0;
  v_total         INTEGER := 0;
  v_has_quote     BOOLEAN := FALSE;
  v_order_items   JSONB := '[]'::jsonb;
  v_class_count   INTEGER := 0;
  v_ref           TEXT;
  v_token         TEXT;
  v_pay_status    TEXT;
  v_adv_req       BOOLEAN := FALSE;
BEGIN
  -- 1. Require authenticated session
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'auth', TRUE,
      'code', 'auth_required',
      'error', 'Please sign in or create a customer account before placing an order.'
    );
  END IF;

  -- 2. Verify email confirmation status in auth.users
  SELECT lower(btrim(u.email)), u.email_confirmed_at
  INTO v_auth_email, v_confirmed_at
  FROM auth.users u
  WHERE u.id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'auth_required', 'error', 'Invalid authentication session.');
  END IF;

  IF v_confirmed_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'email_not_verified',
      'error', 'Please verify your email address before placing an order.'
    );
  END IF;

  -- 3. Idempotency check (scoped to the authenticated customer)
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.orders o
    WHERE o.idempotency_key = v_idem
      AND o.customer_id = v_uid;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'deduplicated', TRUE,
        'token', v_existing.token,
        'statusUrl', 'order.html?ref=' || v_existing.ref || '&token=' || v_existing.token,
        'order', to_jsonb(v_existing) - 'token'
      );
    END IF;
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;
  v_threshold := coalesce(v_settings.advance_threshold, 70000);

  v_name       := left(btrim(coalesce(p_payload->'customer'->>'name', p_payload->>'name', '')), 120);
  v_phone      := left(btrim(coalesce(p_payload->'customer'->>'phone', p_payload->>'phone', '')), 24);
  v_email      := v_auth_email;
  v_fulfil     := CASE WHEN coalesce(p_payload->>'fulfilment', 'pickup') = 'delivery' THEN 'delivery' ELSE 'pickup' END;
  v_address    := left(btrim(coalesce(p_payload->>'address', '')), 300);
  v_event_date := btrim(coalesce(p_payload->>'eventDate', p_payload->>'preferredDate', ''));
  v_pay_method := btrim(coalesce(p_payload->>'paymentMethod', ''));
  v_notes      := left(btrim(coalesce(p_payload->>'notes', '')), 500);

  IF char_length(v_name) < 2 OR char_length(regexp_replace(v_phone, '\D', '', 'g')) NOT BETWEEN 7 AND 15 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_customer', 'error', 'Please enter a valid full name and reachable phone number.');
  END IF;

  IF v_kind = 'product' AND v_fulfil = 'delivery' AND char_length(v_address) < 6 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_address', 'error', 'Please enter a delivery address of at least 6 characters.');
  END IF;

  IF v_pay_method NOT IN ('momo', 'bank_transfer', 'cash_on_pickup', 'cash_on_delivery') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_payment_method', 'error', 'Please choose a valid payment method.');
  END IF;

  v_raw_items := coalesce(p_payload->'items', p_payload->'classes', '[]'::jsonb);
  IF jsonb_typeof(v_raw_items) <> 'array' OR jsonb_array_length(v_raw_items) = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'empty_cart', 'error', 'Your cart is empty. Please add at least one item.');
  END IF;

  IF jsonb_array_length(v_raw_items) > 50 THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'too_many_items', 'error', 'Too many line items in a single order.');
  END IF;

  -- 4. Validate every item and compute prices strictly from the database
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_raw_items)
  LOOP
    IF v_item ? 'qty' THEN
      IF jsonb_typeof(v_item->'qty') <> 'number'
         OR (v_item->>'qty') !~ '^[0-9]+$'
         OR (v_item->>'qty')::INTEGER < 1
         OR (v_item->>'qty')::INTEGER > 100 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_quantity', 'error', 'Item quantity must be a whole number between 1 and 100.');
      END IF;
      v_qty := (v_item->>'qty')::INTEGER;
    ELSE
      v_qty := 1;
    END IF;

    IF v_kind = 'class' THEN
      v_sku := regexp_replace(coalesce(v_item->>'slug', v_item->>'id', ''), '^class-', '');
      SELECT * INTO v_cls FROM public.classes c WHERE lower(c.slug) = lower(v_sku);
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_class', 'error', 'Unknown or invalid class selected: ' || coalesce(v_sku, ''));
      END IF;
      IF v_cls.published = FALSE THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'class_unavailable', 'error', v_cls.name || ' is currently unavailable.');
      END IF;
      v_unit_price := v_cls.fee;
      v_subtotal := v_subtotal + v_unit_price;
      v_class_count := v_class_count + 1;
      v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
        'id', 'class-' || v_cls.slug,
        'kind', 'class',
        'slug', v_cls.slug,
        'name', v_cls.name,
        'meta', v_cls.level_label || ' level · ' || initcap(v_cls.track) || ' track',
        'qty', 1,
        'unitPrice', v_unit_price,
        'discountPct', 0,
        'discount', 0,
        'lineTotal', v_unit_price,
        'prepDays', 0
      ));
    ELSE
      v_sku := btrim(coalesce(v_item->>'sku', v_item->>'id', ''));
      SELECT * INTO v_prod FROM public.products p WHERE lower(p.sku) = lower(v_sku);
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_product', 'error', 'Unknown or invalid product SKU: ' || coalesce(v_sku, ''));
      END IF;
      IF v_prod.published = FALSE THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'product_unavailable', 'error', v_prod.name || ' is currently unavailable.');
      END IF;

      v_unit_price := v_prod.price;
      v_disc_pct   := coalesce(v_prod.discount_pct, 0);
      v_prep_days  := coalesce(v_prod.prep_days, 0);
      IF v_prep_days > v_max_prep THEN
        v_max_prep := v_prep_days;
      END IF;

      IF v_unit_price IS NULL THEN
        v_has_quote := TRUE;
        v_line_disc := 0;
        v_line_total := NULL;
      ELSE
        v_line_disc  := round(v_unit_price * v_disc_pct / 100.0)::INTEGER * v_qty;
        v_line_total := greatest(0, (v_unit_price * v_qty) - v_line_disc);
        v_subtotal   := v_subtotal + (v_unit_price * v_qty);
        v_discount   := v_discount + v_line_disc;
      END IF;

      v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
        'id', v_prod.sku,
        'kind', 'product',
        'sku', v_prod.sku,
        'name', v_prod.name,
        'meta', v_prod.meta,
        'qty', v_qty,
        'unitPrice', v_unit_price,
        'discountPct', v_disc_pct,
        'discount', v_line_disc,
        'lineTotal', v_line_total,
        'prepDays', v_prep_days
      ));
    END IF;
  END LOOP;

  -- Apply 2+ class bundle discount when booking 2 or more classes
  IF v_kind = 'class' AND v_class_count >= 2 THEN
    v_disc_pct := CASE WHEN v_class_count >= 3 THEN coalesce(v_settings.bundle_three_pct, 25)
                       ELSE coalesce(v_settings.bundle_two_pct, 15) END;
    v_discount := round(v_subtotal * v_disc_pct / 100.0)::INTEGER;
  END IF;

  v_total := greatest(0, v_subtotal - v_discount);

  -- 5. Validate preferred order date and advance preparation lead time for product orders
  IF v_kind = 'product' THEN
    v_earliest_ymd := to_char(current_date + v_max_prep, 'YYYY-MM-DD');
    IF v_event_date = '' THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'date_required',
        'earliestDate', v_earliest_ymd,
        'maxPrepDays', v_max_prep,
        'error', 'Please select a preferred order date before placing your order.'
      );
    END IF;
    IF v_event_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'date_invalid', 'error', 'Please choose a valid calendar date (YYYY-MM-DD).');
    END IF;
    IF v_event_date < to_char(current_date, 'YYYY-MM-DD') THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'date_in_past', 'earliestDate', v_earliest_ymd, 'error', 'Preferred order date cannot be in the past.');
    END IF;
    IF v_event_date < v_earliest_ymd THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'date_too_early', 'earliestDate', v_earliest_ymd, 'maxPrepDays', v_max_prep, 'error', 'Selected date does not meet the required advance preparation time.');
    END IF;
  END IF;

  -- 6. Enforce the Special Order Threshold (strictly greater than GH₵ 700.00 / v_total > v_threshold)
  v_adv_req := (v_has_quote OR v_total > v_threshold);
  IF v_pay_method IN ('cash_on_delivery', 'cash_on_pickup') AND v_adv_req THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'advance_required',
      'error', 'Orders strictly above GH₵ ' || to_char(v_threshold / 100.0, 'FM999,990.00') || ' require advance payment via Mobile Money or Bank Transfer.'
    );
  END IF;

  v_ref := (CASE WHEN v_kind = 'class' THEN 'MC-' ELSE 'MB-' END) || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
  v_token := encode(gen_random_bytes(16), 'hex');
  v_pay_status := CASE WHEN v_pay_method IN ('cash_on_delivery', 'cash_on_pickup') THEN 'pay_on_collection' ELSE 'awaiting_payment' END;

  -- 7. Atomically store order, normalized order_items, payment record, and class_booking
  INSERT INTO public.orders (
    ref, token, idempotency_key, kind, customer_id,
    customer_name, phone, email, fulfilment, address, event_date,
    payment_method, payment_status, order_status,
    subtotal, discount, total, has_unpriced, advance_required,
    items, notes, events
  ) VALUES (
    v_ref, v_token, v_idem, v_kind, v_uid,
    v_name, v_phone, v_email, v_fulfil, v_address, v_event_date,
    v_pay_method, v_pay_status, 'submitted',
    v_subtotal, v_discount, v_total, v_has_quote, v_adv_req,
    v_order_items, v_notes,
    jsonb_build_array(jsonb_build_object(
      'kind', 'order',
      'message', CASE WHEN v_kind = 'class' THEN 'Class booking submitted' ELSE 'Product order submitted' END,
      'at', NOW(),
      'actor', v_email
    ))
  ) RETURNING * INTO v_existing;

  v_idx := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_order_items)
  LOOP
    INSERT INTO public.order_items (
      order_ref, customer_id, line_index, item_kind,
      product_sku, class_slug, item_name, item_meta,
      qty, unit_price, discount_pct, line_discount, line_total, prep_days
    ) VALUES (
      v_ref,
      v_uid,
      v_idx,
      CASE WHEN v_kind = 'class' THEN 'class' ELSE 'product' END,
      CASE WHEN v_kind = 'product' THEN v_item->>'sku' ELSE NULL END,
      CASE WHEN v_kind = 'class' THEN v_item->>'slug' ELSE NULL END,
      v_item->>'name',
      coalesce(v_item->>'meta', ''),
      (v_item->>'qty')::INTEGER,
      CASE WHEN v_item->>'unitPrice' IS NULL THEN NULL ELSE (v_item->>'unitPrice')::INTEGER END,
      coalesce((v_item->>'discountPct')::INTEGER, 0),
      coalesce((v_item->>'discount')::INTEGER, 0),
      CASE WHEN v_item->>'lineTotal' IS NULL THEN NULL ELSE (v_item->>'lineTotal')::INTEGER END,
      coalesce((v_item->>'prepDays')::INTEGER, 0)
    );
    v_idx := v_idx + 1;
  END LOOP;

  INSERT INTO public.payments (
    order_ref, customer_id, payment_method, expected_amount,
    verification_status, requires_pre_confirmation_verification
  ) VALUES (
    v_ref, v_uid, v_pay_method, v_total,
    v_pay_status, v_adv_req
  );

  IF v_kind = 'class' THEN
    INSERT INTO public.class_bookings (
      booking_ref, customer_id, courses, subtotal, discount, total,
      payment_method, payment_status, booking_status, notes
    ) VALUES (
      v_ref, v_uid, v_order_items, v_subtotal, v_discount, v_total,
      v_pay_method, v_pay_status, 'submitted', v_notes
    );
  END IF;

  -- Update customer profile phone/name if blank
  UPDATE public.customer_profiles
  SET full_name  = CASE WHEN char_length(btrim(full_name)) < 2 THEN v_name ELSE full_name END,
      phone      = CASE WHEN char_length(btrim(phone)) < 7 THEN v_phone ELSE phone END,
      updated_at = NOW()
  WHERE user_id = v_uid;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'token', v_token,
    'statusUrl', 'order.html?ref=' || v_ref || '&token=' || v_token,
    'order', to_jsonb(v_existing) - 'token'
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Admin Order Status Update RPC (Enforces Above-GH₵ 700 Verification Rule)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_update_order(
  p_ref   TEXT,
  p_patch JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref        TEXT := upper(btrim(coalesce(p_ref, '')));
  v_new_status TEXT := lower(btrim(coalesce(p_patch->>'orderStatus', p_patch->>'order_status', '')));
  v_threshold  INTEGER := 70000;
  v_order      public.orders%ROWTYPE;
BEGIN
  IF NOT public.has_admin_permission('orders') THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised', 'error', 'Administrator order-management permission required.');
  END IF;

  SELECT coalesce(s.advance_threshold, 70000) INTO v_threshold
  FROM public.settings s WHERE s.id = 1;

  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF v_new_status NOT IN ('submitted', 'confirmed', 'in_preparation', 'ready', 'completed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_status', 'error', 'Invalid order status value.');
  END IF;

  -- Enforce the > GH₵ 700.00 rule before allowing confirmation or preparation
  IF v_new_status IN ('confirmed', 'in_preparation', 'ready', 'completed')
     AND (v_order.total > v_threshold OR v_order.advance_required = TRUE OR v_order.payment_method IN ('momo', 'bank_transfer'))
     AND v_order.payment_status <> 'payment_verified' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'payment_verification_required',
      'error', CASE WHEN v_order.total > v_threshold
                    THEN 'Orders strictly above GH₵ 700.00 cannot be confirmed until payment is verified.'
                    ELSE 'Advance payment must be verified before this order can be confirmed.' END
    );
  END IF;

  UPDATE public.orders
  SET order_status = v_new_status,
      updated_at   = NOW(),
      events       = coalesce(events, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'kind', 'status',
        'message', 'Order status updated to ' || v_new_status,
        'at', NOW(),
        'actor', coalesce(auth.jwt()->>'email', 'Baker')
      ))
  WHERE ref = v_ref
  RETURNING * INTO v_order;

  IF v_order.kind = 'class' THEN
    UPDATE public.class_bookings
    SET booking_status = v_new_status, updated_at = NOW()
    WHERE booking_ref = v_ref;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'order', to_jsonb(v_order) - 'token');
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'status_transition_blocked', 'error', SQLERRM);
END;
$$;


-- -----------------------------------------------------------------------------
-- 7b. Legacy column compatibility (the two 20261022 migrations disagree)
--     The production migration names the order secret `token` and the idempotency
--     column `idempotency_key`; the hardening migration names them `token_hash`
--     and `idem_key`. Whichever ran first wins, so make the columns this
--     application uses exist either way. No data is dropped.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'token'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN token TEXT;
    UPDATE public.orders
       SET token = encode(gen_random_bytes(16), 'hex')
     WHERE token IS NULL OR char_length(token) < 16;
    ALTER TABLE public.orders ALTER COLUMN token SET NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
      ON public.orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN customer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7b-2. `verified_by` / `reviewed_by` type reconciliation
--
--   The two 20261022 migrations disagreed on these columns:
--     * production_schema_and_rls  -> verified_by TEXT DEFAULT '',
--                                     payment_submissions.reviewed_by TEXT DEFAULT ''
--     * security_hardening_and_rls -> both UUID REFERENCES auth.users(id)
--
--   Because both files use CREATE TABLE IF NOT EXISTS, whichever ran first won
--   the column type. api_admin_verify() then assigns auth.uid() -- a UUID -- so
--   on a database built from the production file, confirming a payment failed
--   with:
--       column "verified_by" is of type text but expression is of type uuid
--   which is the one step of the money path nobody can work around.
--
--   Canonical type is UUID:
--     * auth.uid() is the only thing ever written to these columns;
--     * the foreign key keeps the audit trail pointing at a real administrator;
--     * ON DELETE SET NULL lets an admin account be removed without orphaning
--       historical order rows.
--
--   A TEXT column that already holds data is converted in place. Values that are
--   not valid UUIDs (the '' default, or an e-mail address written by an older
--   build) become NULL rather than being guessed at -- an unresolvable string was
--   never a usable audit reference anyway. No other column is touched.
--
--   This block is idempotent: on a correct database every branch is skipped.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_uuid_re CONSTANT TEXT :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pair   RECORD;
  v_type   TEXT;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('public.orders',              'verified_by'),
      ('public.payment_submissions', 'reviewed_by'),
      ('public.payments',            'verified_by')
    ) AS t(tbl, col)
  LOOP
    -- Skip tables/columns that do not exist on a partially migrated database.
    SELECT data_type INTO v_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = split_part(v_pair.tbl, '.', 2)
      AND column_name  = v_pair.col;

    IF v_type IS NULL OR v_type = 'uuid' THEN
      CONTINUE;
    END IF;

    -- DEFAULT '' cannot cast to UUID, so the default has to go first.
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP DEFAULT',
                   v_pair.tbl, v_pair.col);

    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN %I TYPE UUID '
      'USING (CASE WHEN %I::TEXT ~* %L THEN %I::TEXT::UUID ELSE NULL END)',
      v_pair.tbl, v_pair.col, v_pair.col, v_uuid_re, v_pair.col
    );

    RAISE NOTICE 'Reconciled %.% from % to UUID', v_pair.tbl, v_pair.col, v_type;
  END LOOP;
END $$;

-- Attach the auth.users foreign key wherever one is still missing.
DO $$
DECLARE
  v_pair RECORD;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('public.orders',              'verified_by'),
      ('public.payment_submissions', 'reviewed_by'),
      ('public.payments',            'verified_by')
    ) AS t(tbl, col)
  LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = split_part(v_pair.tbl, '.', 2)
        AND column_name  = v_pair.col
        AND data_type    = 'uuid'
    );

    CONTINUE WHEN EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum   = ANY (c.conkey)
      WHERE c.contype  = 'f'
        AND c.conrelid = v_pair.tbl::regclass
        AND a.attname  = v_pair.col
    );

    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) '
      'REFERENCES auth.users(id) ON DELETE SET NULL',
      v_pair.tbl,
      'fk_' || split_part(v_pair.tbl, '.', 2) || '_' || v_pair.col,
      v_pair.col
    );

    RAISE NOTICE 'Added auth.users foreign key on %.%', v_pair.tbl, v_pair.col;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 7c. Ownership-aware order read RPC
--     A customer may open their own order by reference alone; anybody else must
--     present the order token. Administrators with order permission may read any.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_order(
  p_ref   TEXT,
  p_token TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref    TEXT := upper(btrim(coalesce(p_ref, '')));
  v_tok    TEXT := btrim(coalesce(p_token, ''));
  v_uid    UUID := auth.uid();
  v_order  public.orders%ROWTYPE;
  v_settings public.settings%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF NOT (
       (v_uid IS NOT NULL AND v_order.customer_id = v_uid)
       OR (v_tok <> '' AND v_tok = v_order.token)
       OR (public.has_admin_permission('orders'))
     ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'token',
      'error', 'That order link is missing or has an invalid security token.');
  END IF;

  SELECT * INTO v_settings FROM public.settings WHERE id = 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order', to_jsonb(v_order) - 'token' - 'token_hash',
    'kind', v_order.kind,
    'momo', CASE WHEN coalesce(v_settings.momo_verified, FALSE)
                 THEN jsonb_build_object(
                        'name', v_settings.momo_name,
                        'number', v_settings.momo_number,
                        'provider', v_settings.momo_provider,
                        'note', v_settings.momo_note)
                 ELSE NULL END,
    'bank', CASE WHEN coalesce(v_settings.bank_verified, FALSE)
                 THEN jsonb_build_object(
                        'name', v_settings.bank_name,
                        'accountName', v_settings.bank_account_name,
                        'accountNumber', v_settings.bank_account_number)
                 ELSE NULL END,
    'config', public.api_config()
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7d. Payment-proof submission, authorising the *owner* or the order token
--     Customers can never mark a payment verified here; the submission always
--     lands in 'payment_submitted' and waits for an administrator.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_submit_proof(
  p_ref        TEXT,
  p_token      TEXT DEFAULT '',
  p_reference  TEXT DEFAULT '',
  p_image_path TEXT DEFAULT '',
  p_note       TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref   TEXT := upper(btrim(coalesce(p_ref, '')));
  v_tok   TEXT := btrim(coalesce(p_token, ''));
  v_pay   TEXT := btrim(coalesce(p_reference, ''));
  v_img   TEXT := btrim(coalesce(p_image_path, ''));
  v_note  TEXT := left(btrim(coalesce(p_note, '')), 200);
  v_uid   UUID := auth.uid();
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF NOT (
       (v_uid IS NOT NULL AND v_order.customer_id = v_uid)
       OR (v_tok <> '' AND v_tok = v_order.token)
     ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'token',
      'error', 'Unauthorised payment submission: invalid order token or account.');
  END IF;

  IF v_order.order_status IN ('cancelled', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'order_closed',
      'error', 'Payment details cannot be submitted for a closed order.');
  END IF;

  IF v_order.payment_method IN ('cash_on_delivery', 'cash_on_pickup') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_applicable',
      'error', 'Cash orders do not accept advance payment proof submissions.');
  END IF;

  IF v_order.payment_status = 'payment_verified' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'already_verified',
      'error', 'Payment for this order has already been verified and confirmed.');
  END IF;

  IF v_order.payment_status = 'payment_submitted'
     OR (v_order.proof_locked = TRUE AND v_order.payment_status <> 'payment_rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_submission',
      'error', 'Payment details have already been submitted and are awaiting verification.');
  END IF;

  IF v_pay = '' AND v_img = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'missing_proof',
      'error', 'Please provide your payment transaction reference, a screenshot, or both.');
  END IF;

  IF v_pay <> '' AND (char_length(v_pay) < 4 OR char_length(v_pay) > 80
                      OR v_pay !~ '^[A-Za-z0-9\-_./#: ]{4,80}$') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_reference',
      'error', 'Transaction reference must be 4 to 80 alphanumeric characters.');
  END IF;

  IF v_pay <> '' AND (
       EXISTS (SELECT 1 FROM public.payment_submissions s
                WHERE upper(btrim(s.reference)) = upper(v_pay))
    OR EXISTS (SELECT 1 FROM public.orders o
                WHERE o.ref <> v_order.ref
                  AND o.payment_status IN ('payment_submitted', 'payment_verified')
                  AND upper(btrim(o.payment_ref)) = upper(v_pay))
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_reference',
      'error', 'That payment transaction reference has already been submitted.');
  END IF;

  INSERT INTO public.payment_submissions (order_ref, reference, image_path, note, status)
  VALUES (v_order.ref, v_pay, v_img, v_note, 'pending_verification');

  UPDATE public.orders
     SET payment_ref = CASE WHEN v_pay <> '' THEN v_pay ELSE payment_ref END,
         has_proof = CASE WHEN v_img <> '' THEN TRUE ELSE has_proof END,
         proof_path = CASE WHEN v_img <> '' THEN v_img ELSE proof_path END,
         proof_note = v_note,
         payment_status = 'payment_submitted',
         proof_locked = TRUE,
         proof_submitted_at = NOW(),
         submission_count = submission_count + 1
   WHERE ref = v_order.ref
  RETURNING * INTO v_order;

  UPDATE public.payments
     SET transaction_reference = CASE WHEN v_pay <> '' THEN v_pay ELSE transaction_reference END,
         proof_image_path = CASE WHEN v_img <> '' THEN v_img ELSE proof_image_path END,
         customer_note = v_note,
         verification_status = 'payment_submitted',
         submitted_at = NOW(),
         updated_at = NOW()
   WHERE order_ref = v_order.ref;

  UPDATE public.class_bookings
     SET payment_status = 'payment_submitted', updated_at = NOW()
   WHERE booking_ref = v_order.ref;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order', jsonb_build_object(
      'ref', v_order.ref,
      'kind', v_order.kind,
      'paymentStatus', v_order.payment_status,
      'orderStatus', v_order.order_status,
      'paymentRef', v_order.payment_ref,
      'hasProof', v_order.has_proof,
      'proofLocked', v_order.proof_locked,
      'proofSubmittedAt', v_order.proof_submitted_at
    )
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'duplicate_submission',
      'error', 'Duplicate payment submission or reference detected and blocked.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_customer_whoami() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_customer_update_profile(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_customer_orders() TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_place_order(TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_admin_update_order(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.api_order(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_submit_proof(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

COMMIT;
