-- =============================================================================
-- Mystery Bakebite — Business Contact Profile (single source of truth)
-- Target: Supabase PostgreSQL 15+
-- Depends on: 20261022 (settings table), 20261024 (api_config), 20261025 (api_admin_settings)
--
-- WHY THIS EXISTS
--   Every contact detail the bakery publishes was hardcoded in the HTML: the
--   WhatsApp number in 34 links across 10 pages, the email in 60 places, the
--   Instagram URL in 11, the address and opening hours in dozens more. Updating
--   any of them meant editing every page and hoping none were missed.
--
--   This migration moves them into public.settings — one row, one place — and
--   exposes them through api_config(), which every page already calls on load.
--   The storefront then renders from that object instead of from markup.
--
-- WHAT IT DOES
--   1. Adds the contact columns to public.settings (idempotent).
--   2. Backfills them with the values the site was already publishing, so the
--      visible result is unchanged on the day it is applied.
--   3. Extends api_config() to return a `contact` object (public read; it is
--      SECURITY DEFINER so anon can read it without a grant on settings).
--   4. Extends api_admin_settings() to validate and write those fields, so only
--      an administrator with the `settings` permission can change them.
--
-- SECURITY
--   public.settings still has NO select grant for anon. The contact block is
--   exposed only through api_config(), which returns a fixed allow-list of
--   fields. No order, customer, token or administrator record is reachable
--   through it. Writes require has_admin_permission('settings').
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_name          TEXT NOT NULL DEFAULT 'Mystery Bakebite';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_tagline       TEXT NOT NULL DEFAULT 'Home bakery & baking school';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_phone         TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_phone_display TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS business_email         TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS whatsapp_contact       TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS whatsapp_message       TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_line1          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_line2          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_city           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_region         TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS address_country        TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS map_url                TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_days           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_open           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_close          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS opening_note           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_instagram       TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_facebook        TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_tiktok          TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_x               TEXT NOT NULL DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS social_youtube         TEXT NOT NULL DEFAULT '';

-- -----------------------------------------------------------------------------
-- 2. Backfill with the values the site is already publishing.
--    Guarded so a second run cannot overwrite anything an admin has since set.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  UPDATE public.settings SET
    business_name          = 'Mystery Bakebite',
    business_phone         = '233554520532',
    business_phone_display = '+233 55 452 0532',
    business_email         = 'mysterybakebite@gmail.com',
    whatsapp_contact       = '233554520532',
    whatsapp_message       = 'Hello Mystery Bakebite, I''d like to place an order.',
    address_city           = 'Tamale',
    address_region         = 'Northern Region',
    address_country        = 'Ghana',
    opening_days           = 'Monday to Sunday',
    opening_open           = '08:00',
    opening_close          = '19:00',
    opening_note           = 'Messages are answered during opening hours.',
    social_instagram       = 'https://www.instagram.com/mysterybakebites/'
  WHERE id = 1
    AND coalesce(btrim(business_phone), '') = ''
    AND coalesce(btrim(business_email), '') = ''
    AND coalesce(btrim(whatsapp_contact), '') = '';
END $$;

-- -----------------------------------------------------------------------------
-- 3. Shape constraints. These mirror the checks in api_admin_settings so a bad
--    value cannot be written by any path, including direct SQL.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_business_phone_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_business_phone_chk
      CHECK (business_phone = '' OR business_phone ~ '^[0-9]{7,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_whatsapp_contact_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_whatsapp_contact_chk
      CHECK (whatsapp_contact = '' OR whatsapp_contact ~ '^[0-9]{7,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_business_email_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_business_email_chk
      CHECK (business_email = '' OR business_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]{2,}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_opening_time_chk') THEN
    ALTER TABLE public.settings ADD CONSTRAINT settings_opening_time_chk
      CHECK (
        (opening_open  = '' OR opening_open  ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
        (opening_close = '' OR opening_close ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. api_config() — now carries the contact profile
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
      ), '{}'::jsonb),

      -- ---------------------------------------------------------------------
      -- BUSINESS CONTACT PROFILE (single source of truth for every page).
      -- The browser renders header, footer, contact page, WhatsApp buttons and
      -- click-to-call links from this object. Nothing contact-related is
      -- hardcoded in a page any more; changing it here changes it everywhere.
      -- Every field is coalesced so a half-filled row still renders.
      -- ---------------------------------------------------------------------
      'contact', jsonb_build_object(
        'businessName', coalesce(nullif(btrim(s.business_name), ''), 'Mystery Bakebite'),
        'tagline',      coalesce(s.business_tagline, ''),

        'phone',        coalesce(regexp_replace(coalesce(s.business_phone, ''), '\D', '', 'g'), ''),
        'phoneDisplay', coalesce(nullif(btrim(s.business_phone_display), ''), ''),
        'email',        coalesce(nullif(btrim(s.business_email), ''), ''),

        'whatsapp',        coalesce(regexp_replace(coalesce(s.whatsapp_contact, ''), '\D', '', 'g'), ''),
        'whatsappMessage', coalesce(s.whatsapp_message, ''),
        -- Baker alert number: the private alert number when set, otherwise the
        -- public WhatsApp line. Empty string means "no automatic alert target".
        'alerts',          coalesce(
                             nullif(regexp_replace(coalesce(s.whatsapp_number, ''), '\D', '', 'g'), ''),
                             regexp_replace(coalesce(s.whatsapp_contact, ''), '\D', '', 'g'),
                             ''
                           ),

        'address', jsonb_build_object(
          'line1',   coalesce(s.address_line1, ''),
          'line2',   coalesce(s.address_line2, ''),
          'city',    coalesce(s.address_city, ''),
          'region',  coalesce(s.address_region, ''),
          'country', coalesce(s.address_country, ''),
          'mapUrl',  coalesce(s.map_url, '')
        ),

        'hours', jsonb_build_object(
          'days',  coalesce(nullif(btrim(s.opening_days), ''), ''),
          'open',  coalesce(nullif(btrim(s.opening_open), ''), ''),
          'close', coalesce(nullif(btrim(s.opening_close), ''), ''),
          'note',  coalesce(s.opening_note, '')
        ),

        'social', jsonb_build_object(
          'instagram', coalesce(s.social_instagram, ''),
          'facebook',  coalesce(s.social_facebook, ''),
          'tiktok',    coalesce(s.social_tiktok, ''),
          'x',         coalesce(s.social_x, ''),
          'youtube',   coalesce(s.social_youtube, '')
        )
      )
    )
  )
  FROM s;
$$;

-- -----------------------------------------------------------------------------
-- 5. api_admin_settings() — validates and writes the contact profile
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
  v_txt     TEXT;
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


    -- -------------------------------------------------------------------
    -- Business contact profile. Each field is optional; only the keys that
    -- arrive are touched, so a partial save cannot blank the rest.
    -- Validation runs BEFORE any write for that field, and an invalid value
    -- is rejected with a code the dashboard shows next to the input.
    -- -------------------------------------------------------------------
    IF v_p ? 'business_name' THEN
      UPDATE public.settings SET business_name = left(btrim(coalesce(v_p->>'business_name', '')), 120) WHERE id = 1;
    END IF;
    IF v_p ? 'business_tagline' THEN
      UPDATE public.settings SET business_tagline = left(btrim(coalesce(v_p->>'business_tagline', '')), 160) WHERE id = 1;
    END IF;

    -- Phone: digits only, 7-15 of them (international form without '+').
    IF v_p ? 'business_phone' THEN
      v_txt := regexp_replace(coalesce(v_p->>'business_phone', ''), '\D', '', 'g');
      IF v_txt <> '' AND v_txt !~ '^[0-9]{7,15}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_phone',
          'error', 'The business phone number must contain 7 to 15 digits, for example 233554520532.');
      END IF;
      UPDATE public.settings SET business_phone = v_txt WHERE id = 1;
    END IF;
    IF v_p ? 'business_phone_display' THEN
      UPDATE public.settings SET business_phone_display = left(btrim(coalesce(v_p->>'business_phone_display', '')), 40) WHERE id = 1;
    END IF;

    -- Email: a deliberately loose shape check. The kitchen email is a contact
    -- detail, not an authentication credential, so an over-strict regex that
    -- rejects a valid address would be worse than a permissive one.
    IF v_p ? 'business_email' THEN
      v_txt := lower(btrim(coalesce(v_p->>'business_email', '')));
      IF v_txt <> '' AND v_txt !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_email',
          'error', 'Enter a valid email address, for example name@example.com.');
      END IF;
      UPDATE public.settings SET business_email = v_txt WHERE id = 1;
    END IF;

    -- Public WhatsApp chat line (digits only). Separate from whatsapp_number,
    -- which is the private alert target.
    IF v_p ? 'whatsapp_contact' THEN
      v_txt := regexp_replace(coalesce(v_p->>'whatsapp_contact', ''), '\D', '', 'g');
      IF v_txt <> '' AND v_txt !~ '^[0-9]{7,15}$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_whatsapp',
          'error', 'The WhatsApp number must contain 7 to 15 digits, for example 233554520532.');
      END IF;
      UPDATE public.settings SET whatsapp_contact = v_txt WHERE id = 1;
    END IF;
    IF v_p ? 'whatsapp_message' THEN
      UPDATE public.settings SET whatsapp_message = left(btrim(coalesce(v_p->>'whatsapp_message', '')), 400) WHERE id = 1;
    END IF;

    -- Address
    IF v_p ? 'address_line1' THEN UPDATE public.settings SET address_line1 = left(btrim(coalesce(v_p->>'address_line1', '')), 160) WHERE id = 1; END IF;
    IF v_p ? 'address_line2' THEN UPDATE public.settings SET address_line2 = left(btrim(coalesce(v_p->>'address_line2', '')), 160) WHERE id = 1; END IF;
    IF v_p ? 'address_city'  THEN UPDATE public.settings SET address_city  = left(btrim(coalesce(v_p->>'address_city',  '')), 80)  WHERE id = 1; END IF;
    IF v_p ? 'address_region' THEN UPDATE public.settings SET address_region = left(btrim(coalesce(v_p->>'address_region','')), 80) WHERE id = 1; END IF;
    IF v_p ? 'address_country' THEN UPDATE public.settings SET address_country = left(btrim(coalesce(v_p->>'address_country','')), 80) WHERE id = 1; END IF;
    IF v_p ? 'map_url' THEN
      v_txt := btrim(coalesce(v_p->>'map_url', ''));
      IF v_txt <> '' AND v_txt !~* '^https?://' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_map_url',
          'error', 'The map link must start with http:// or https://.');
      END IF;
      UPDATE public.settings SET map_url = left(v_txt, 500) WHERE id = 1;
    END IF;

    -- Opening hours
    IF v_p ? 'opening_days' THEN UPDATE public.settings SET opening_days = left(btrim(coalesce(v_p->>'opening_days', '')), 80) WHERE id = 1; END IF;
    IF v_p ? 'opening_note' THEN UPDATE public.settings SET opening_note = left(btrim(coalesce(v_p->>'opening_note', '')), 200) WHERE id = 1; END IF;
    IF v_p ? 'opening_open' THEN
      v_txt := btrim(coalesce(v_p->>'opening_open', ''));
      IF v_txt <> '' AND v_txt !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_hours',
          'error', 'Opening time must be in 24-hour HH:MM form, for example 08:00.');
      END IF;
      UPDATE public.settings SET opening_open = v_txt WHERE id = 1;
    END IF;
    IF v_p ? 'opening_close' THEN
      v_txt := btrim(coalesce(v_p->>'opening_close', ''));
      IF v_txt <> '' AND v_txt !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_hours',
          'error', 'Closing time must be in 24-hour HH:MM form, for example 19:00.');
      END IF;
      UPDATE public.settings SET opening_close = v_txt WHERE id = 1;
    END IF;

    -- Social links: every one must be an http(s) URL or empty.
    IF v_p ? 'social' AND jsonb_typeof(v_p->'social') = 'object' THEN
      IF v_p->'social' ? 'instagram' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'instagram', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The Instagram link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_instagram = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'facebook' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'facebook', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The Facebook link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_facebook = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'tiktok' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'tiktok', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The TikTok link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_tiktok = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'x' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'x', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The X link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_x = left(v_txt, 300) WHERE id = 1;
      END IF;
      IF v_p->'social' ? 'youtube' THEN
        v_txt := btrim(coalesce(v_p->'social'->>'youtube', ''));
        IF v_txt <> '' AND v_txt !~* '^https?://' THEN
          RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_social',
            'error', 'The YouTube link must start with http:// or https://.');
        END IF;
        UPDATE public.settings SET social_youtube = left(v_txt, 300) WHERE id = 1;
      END IF;
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

COMMIT;
