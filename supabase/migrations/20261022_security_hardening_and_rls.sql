-- =============================================================================
-- Mystery Bakebite · Comprehensive Supabase Security Hardening & RLS Migration
-- File: supabase/migrations/20261022_security_hardening_and_rls.sql
--
-- Purpose:
--   1. Prevent duplicate payment submissions at the database level via:
--      - Row-level locks (SELECT ... FOR UPDATE) inside RPCs
--      - Partial UNIQUE indexes on active payment submissions & payment references
--      - BEFORE UPDATE trigger enforcing the payment status state machine
--      - Strict proof_locked state control (only reset by authorized admin reject)
--   2. Enforce strict Row Level Security (RLS) across all public tables and
--      the private 'proofs' Supabase Storage bucket.
--   3. Prevent automatic "paid" marking on customer proof upload: submissions
--      always enter 'payment_submitted' (Pending Verification) until an
--      authenticated administrator confirms the funds via api_admin_verify.
--   4. Harden order lookup, token verification, and admin RBAC.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Core Tables & Security Columns
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'administrator' CHECK (role IN ('owner', 'administrator', 'admin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.orders (
  ref TEXT PRIMARY KEY CHECK (ref ~ '^M[BC]-[A-Z0-9]{4,12}$'),
  token_hash TEXT NOT NULL,
  idem_key TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'class')),
  customer_name TEXT NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 2 AND 120),
  phone TEXT NOT NULL CHECK (char_length(regexp_replace(phone, '\D', '', 'g')) BETWEEN 7 AND 15),
  email TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  bundles JSONB NOT NULL DEFAULT '[]'::jsonb,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('momo', 'bank_transfer', 'cash_on_delivery', 'cash_on_pickup')),
  payment_status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (payment_status IN ('awaiting_payment', 'payment_submitted', 'payment_verified', 'payment_rejected', 'pay_on_collection', 'not_required')),
  order_status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (order_status IN ('submitted', 'confirmed', 'in_preparation', 'completed', 'cancelled')),
  fulfilment TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfilment IN ('pickup', 'delivery')),
  address TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  payment_ref TEXT NOT NULL DEFAULT '',
  has_proof BOOLEAN NOT NULL DEFAULT FALSE,
  proof_path TEXT NOT NULL DEFAULT '',
  proof_note TEXT NOT NULL DEFAULT '',
  proof_locked BOOLEAN NOT NULL DEFAULT FALSE,
  proof_submitted_at TIMESTAMPTZ,
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  reject_reason TEXT NOT NULL DEFAULT '',
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES auth.users(id),
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payment_submissions (
  id BIGSERIAL PRIMARY KEY,
  order_ref TEXT NOT NULL REFERENCES public.orders(ref) ON DELETE CASCADE,
  reference TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'verified', 'rejected')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id),
  reject_reason TEXT NOT NULL DEFAULT ''
);

-- -----------------------------------------------------------------------------
-- 2. Database-Level Uniqueness Constraints Preventing Duplicate Submissions
-- -----------------------------------------------------------------------------

-- Prevent more than one active (pending_verification or verified) submission per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_submissions_one_active_per_order
  ON public.payment_submissions (order_ref)
  WHERE status IN ('pending_verification', 'verified');

-- Prevent reuse of the same transaction reference ID across any submission
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_submissions_unique_ref
  ON public.payment_submissions (UPPER(BTRIM(reference)))
  WHERE reference IS NOT NULL AND BTRIM(reference) <> '';

-- Prevent reuse of the same transaction reference ID across active orders
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_payment_ref
  ON public.orders (UPPER(BTRIM(payment_ref)))
  WHERE payment_ref IS NOT NULL
    AND BTRIM(payment_ref) <> ''
    AND payment_status IN ('payment_submitted', 'payment_verified');

-- -----------------------------------------------------------------------------
-- 3. Role-Based Authorization Helper (Admin Verification)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_verified_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users a
    WHERE a.user_id = auth.uid()
      AND a.active = TRUE
      AND a.role IN ('owner', 'administrator', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.is_verified_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_verified_admin() TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Database Trigger Enforcing Payment Status State Machine
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_order_payment_state_machine()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := NOW();

  -- 1. Only a verified administrator can transition an order to 'payment_verified'
  IF NEW.payment_status = 'payment_verified' AND OLD.payment_status <> 'payment_verified' THEN
    IF NOT public.is_verified_admin() THEN
      RAISE EXCEPTION 'Unauthorised: only a verified administrator can confirm payment.'
        USING ERRCODE = '42501', HINT = 'unauthorised';
    END IF;
    NEW.proof_locked := TRUE;
    NEW.verified_at := COALESCE(NEW.verified_at, NOW());
  END IF;

  -- 2. Block duplicate customer submissions when proof is already submitted or locked
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
       AND NOT public.is_verified_admin()
    THEN
      RAISE EXCEPTION 'Duplicate payment submission blocked: payment details are already on file and awaiting verification.'
        USING ERRCODE = 'P0001', HINT = 'duplicate_submission';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_order_payment_state_machine ON public.orders;
CREATE TRIGGER trg_enforce_order_payment_state_machine
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_order_payment_state_machine();

-- -----------------------------------------------------------------------------
-- 5. Strict Row Level Security (RLS) Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users FORCE ROW LEVEL SECURITY;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions FORCE ROW LEVEL SECURITY;

-- Direct table access is locked down to verified administrators only.
-- Customers interact exclusively through token-verified SECURITY DEFINER RPCs.

DROP POLICY IF EXISTS admin_users_select_policy ON public.admin_users;
CREATE POLICY admin_users_select_policy ON public.admin_users
  FOR SELECT TO authenticated
  USING (public.is_verified_admin());

DROP POLICY IF EXISTS admin_users_write_policy ON public.admin_users;
CREATE POLICY admin_users_write_policy ON public.admin_users
  FOR ALL TO authenticated
  USING (public.is_verified_admin())
  WITH CHECK (public.is_verified_admin());

DROP POLICY IF EXISTS orders_admin_all_policy ON public.orders;
CREATE POLICY orders_admin_all_policy ON public.orders
  FOR ALL TO authenticated
  USING (public.is_verified_admin())
  WITH CHECK (public.is_verified_admin());

DROP POLICY IF EXISTS payment_submissions_admin_all_policy ON public.payment_submissions;
CREATE POLICY payment_submissions_admin_all_policy ON public.payment_submissions
  FOR ALL TO authenticated
  USING (public.is_verified_admin())
  WITH CHECK (public.is_verified_admin());

-- -----------------------------------------------------------------------------
-- 6. Hardened Payment Proof Upload & Submission RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_begin_proof_upload(
  p_ref TEXT,
  p_token TEXT,
  p_ext TEXT DEFAULT 'jpg'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref TEXT := UPPER(BTRIM(COALESCE(p_ref, '')));
  v_tok TEXT := BTRIM(COALESCE(p_token, ''));
  v_ext TEXT := LOWER(REGEXP_REPLACE(COALESCE(p_ext, 'jpg'), '[^a-z0-9]', '', 'g'));
  v_order public.orders%ROWTYPE;
BEGIN
  IF v_ext NOT IN ('jpg', 'jpeg', 'png', 'webp') THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'invalid_image',
      'error', 'Only PNG, JPEG, and WebP payment screenshots are allowed.'
    );
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE ref = v_ref
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF v_tok = '' OR encode(digest(v_tok, 'sha256'), 'hex') <> v_order.token_hash THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'token', 'error', 'Invalid or missing order security token.');
  END IF;

  IF v_order.order_status IN ('cancelled', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'order_closed', 'error', 'This order is closed and cannot accept payment uploads.');
  END IF;

  IF v_order.payment_method IN ('cash_on_delivery', 'cash_on_pickup') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_applicable', 'error', 'Cash orders do not accept advance payment proof uploads.');
  END IF;

  IF v_order.payment_status = 'payment_verified' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'already_verified', 'error', 'Payment for this order has already been verified.');
  END IF;

  IF v_order.payment_status = 'payment_submitted' OR (v_order.proof_locked = TRUE AND v_order.payment_status <> 'payment_rejected') THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'duplicate_submission',
      'error', 'Payment details have already been submitted for this order and are awaiting verification.'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'path', v_order.ref || '/' || EXTRACT(EPOCH FROM NOW())::BIGINT || '-' || encode(gen_random_bytes(6), 'hex') || '.' || v_ext
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_submit_proof(
  p_ref TEXT,
  p_token TEXT,
  p_reference TEXT DEFAULT '',
  p_image_path TEXT DEFAULT '',
  p_note TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref TEXT := UPPER(BTRIM(COALESCE(p_ref, '')));
  v_tok TEXT := BTRIM(COALESCE(p_token, ''));
  v_pay_ref TEXT := BTRIM(COALESCE(p_reference, ''));
  v_img_path TEXT := BTRIM(COALESCE(p_image_path, ''));
  v_note TEXT := LEFT(BTRIM(COALESCE(p_note, '')), 200);
  v_order public.orders%ROWTYPE;
BEGIN
  -- Acquire row-level lock on the order to prevent concurrent duplicate submissions
  SELECT * INTO v_order
  FROM public.orders
  WHERE ref = v_ref
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  -- Authenticate customer order token
  IF v_tok = '' OR encode(digest(v_tok, 'sha256'), 'hex') <> v_order.token_hash THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'token', 'error', 'Unauthorised payment submission: invalid order token.');
  END IF;

  IF v_order.order_status IN ('cancelled', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'order_closed', 'error', 'Payment details cannot be submitted for a closed order.');
  END IF;

  IF v_order.payment_method IN ('cash_on_delivery', 'cash_on_pickup') THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_applicable', 'error', 'Cash orders do not accept advance payment proof submissions.');
  END IF;

  -- Block resubmission when already verified or already submitted
  IF v_order.payment_status = 'payment_verified' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'already_verified',
      'error', 'Payment for this order has already been verified and confirmed.'
    );
  END IF;

  IF v_order.payment_status = 'payment_submitted' OR (v_order.proof_locked = TRUE AND v_order.payment_status <> 'payment_rejected') THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'duplicate_submission',
      'error', 'Payment details have already been submitted for this order and are currently awaiting verification.'
    );
  END IF;

  IF v_pay_ref = '' AND v_img_path = '' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'missing_proof',
      'error', 'Please provide your payment transaction reference, a payment screenshot, or both.'
    );
  END IF;

  IF v_pay_ref <> '' THEN
    IF char_length(v_pay_ref) < 4 OR char_length(v_pay_ref) > 80 OR v_pay_ref !~ '^[A-Za-z0-9\-_./#: ]{4,80}$' THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'invalid_reference',
        'error', 'Transaction reference must be 4 to 80 alphanumeric characters.'
      );
    END IF;

    -- Check uniqueness of transaction reference across all payment submissions and orders
    IF EXISTS (
      SELECT 1 FROM public.payment_submissions s
      WHERE UPPER(BTRIM(s.reference)) = UPPER(v_pay_ref)
    ) OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.ref <> v_order.ref
        AND o.payment_status IN ('payment_submitted', 'payment_verified')
        AND UPPER(BTRIM(o.payment_ref)) = UPPER(v_pay_ref)
    ) THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'duplicate_reference',
        'error', 'That payment transaction reference has already been submitted and cannot be reused.'
      );
    END IF;
  END IF;

  -- Record submission in payment_submissions audit table
  INSERT INTO public.payment_submissions (order_ref, reference, image_path, note, status)
  VALUES (v_order.ref, v_pay_ref, v_img_path, v_note, 'pending_verification');

  -- Update order to 'payment_submitted' (Pending Verification - NEVER auto-confirmed as paid)
  UPDATE public.orders
  SET payment_ref = CASE WHEN v_pay_ref <> '' THEN v_pay_ref ELSE payment_ref END,
      has_proof = CASE WHEN v_img_path <> '' THEN TRUE ELSE has_proof END,
      proof_path = CASE WHEN v_img_path <> '' THEN v_img_path ELSE proof_path END,
      proof_note = v_note,
      payment_status = 'payment_submitted',
      proof_locked = TRUE,
      proof_submitted_at = NOW(),
      submission_count = submission_count + 1
  WHERE ref = v_order.ref
  RETURNING * INTO v_order;

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
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'duplicate_submission',
      'error', 'Duplicate payment submission or reference detected and blocked.'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Administrator Payment Verification & Resubmission Unlock RPC
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.api_admin_verify(
  p_ref TEXT,
  p_action TEXT,
  p_note TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref TEXT := UPPER(BTRIM(COALESCE(p_ref, '')));
  v_act TEXT := LOWER(BTRIM(COALESCE(p_action, '')));
  v_note TEXT := LEFT(BTRIM(COALESCE(p_note, '')), 300);
  v_order public.orders%ROWTYPE;
BEGIN
  IF NOT public.is_verified_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'auth', TRUE, 'code', 'unauthorised', 'error', 'Administrator privileges required.');
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE ref = v_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'Order not found.');
  END IF;

  IF v_act = 'confirm' THEN
    UPDATE public.payment_submissions
    SET status = 'verified', reviewed_at = NOW(), reviewed_by = auth.uid()
    WHERE order_ref = v_ref AND status = 'pending_verification';

    UPDATE public.orders
    SET payment_status = 'payment_verified',
        proof_locked = TRUE,
        verified_at = NOW(),
        verified_by = auth.uid()
    WHERE ref = v_ref
    RETURNING * INTO v_order;
  ELSIF v_act IN ('reject', 'allow_resubmit') THEN
    IF char_length(v_note) < 3 THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'note_required', 'error', 'Please enter a rejection reason so the customer knows what to correct.');
    END IF;

    UPDATE public.payment_submissions
    SET status = 'rejected', reviewed_at = NOW(), reviewed_by = auth.uid(), reject_reason = v_note
    WHERE order_ref = v_ref AND status = 'pending_verification';

    UPDATE public.orders
    SET payment_status = 'payment_rejected',
        proof_locked = FALSE,
        reject_reason = v_note
    WHERE ref = v_ref
    RETURNING * INTO v_order;
  ELSE
    RETURN jsonb_build_object('ok', FALSE, 'error', 'Invalid verification action.');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'order', to_jsonb(v_order) - 'token_hash');
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Private Storage Bucket Configuration for Payment Screenshots ('proofs')
-- -----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'proofs',
  'proofs',
  FALSE,
  5242880, -- 5 MB hard cap
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];

-- Only verified administrators can read/sign objects from the private 'proofs' bucket
DROP POLICY IF EXISTS proofs_admin_select_policy ON storage.objects;
CREATE POLICY proofs_admin_select_policy ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'proofs' AND public.is_verified_admin());

DROP POLICY IF EXISTS proofs_admin_delete_policy ON storage.objects;
CREATE POLICY proofs_admin_delete_policy ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'proofs' AND public.is_verified_admin());

COMMIT;
