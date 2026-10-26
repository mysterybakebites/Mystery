-- =============================================================================
-- RUN FIRST — Super Administrator email correction
--   mysterybakebite@gmail.com  ->  mysterybakebites@gmail.com  (owner-confirmed)
--
-- WHY THIS FILE EXISTS
--   Migration 20261022 has ALREADY been applied to this project. It created
--   public.admin_users with a CHECK constraint (chk_super_admin_email)
--   hard-wired to the OLD spelling. Re-running APPLY_ALL_MIGRATIONS.sql
--   cannot change that constraint, because CREATE TABLE IF NOT EXISTS
--   skips a table that already exists — and the protect trigger would
--   also refuse to rename an existing super-admin row.
--
-- RUN ORDER
--   1. Paste THIS file into Supabase SQL Editor -> Run.
--   2. Then paste the corrected APPLY_ALL_MIGRATIONS.sql -> Run.
--   3. Then run the verification queries at the bottom of this file.
--   4. Only then create the Auth user mysterybakebites@gmail.com
--      (Dashboard -> Authentication -> Users -> Add user).
--
-- Safe to run twice. Everything runs in one transaction: on any error
-- nothing is changed — copy the full error message and ask for help.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.admin_users') IS NOT NULL THEN

    -- 1. Drop EVERY check constraint on admin_users that mentions the OLD
    --    spelling (covers the named chk_super_admin_email and any
    --    auto-named constraint from an earlier migration variant).
    FOR r IN
      SELECT conname
        FROM pg_constraint
       WHERE conrelid = 'public.admin_users'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%mysterybakebite@gmail.com%'
    LOOP
      EXECUTE format('ALTER TABLE public.admin_users DROP CONSTRAINT %I', r.conname);
    END LOOP;

    -- 2. Pause the table's triggers (the protection trigger would
    --    otherwise reject the rename), rename the row if it exists,
    --    then switch the triggers back on.
    EXECUTE 'ALTER TABLE public.admin_users DISABLE TRIGGER USER';
    EXECUTE $q$UPDATE public.admin_users
                   SET email = 'mysterybakebites@gmail.com'
                 WHERE lower(email) = 'mysterybakebite@gmail.com'$q$;
    EXECUTE 'ALTER TABLE public.admin_users ENABLE TRIGGER USER';

    -- 3. Re-add the constraint with the corrected address.
    EXECUTE $q$ALTER TABLE public.admin_users
                 ADD CONSTRAINT chk_super_admin_email CHECK (
                   (role = 'super_admin' AND lower(email) = 'mysterybakebites@gmail.com' AND is_primary_super_admin = TRUE)
                   OR (role <> 'super_admin' AND lower(email) <> 'mysterybakebites@gmail.com' AND is_primary_super_admin = FALSE)
                 )$q$;
  END IF;
END $$;

-- 4. Published contact email. The business_email column arrives with
--    migration 20261026, so this is guarded to work before it exists;
--    the corrected APPLY_ALL also sets the plural address.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'settings'
                AND column_name = 'business_email') THEN
    EXECUTE $q$UPDATE public.settings
                   SET business_email = 'mysterybakebites@gmail.com'
                 WHERE lower(coalesce(business_email, '')) = 'mysterybakebite@gmail.com'$q$;
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- VERIFICATION (run these AFTER step 2, the corrected APPLY_ALL)
--
-- (a) Expect the constraint text with the PLURAL address:
--     SELECT pg_get_constraintdef(oid) FROM pg_constraint
--      WHERE conname = 'chk_super_admin_email';
--
-- (b) Expect 0 rows — no database function may still mention the old
--     spelling. If rows appear, copy the names and ask for a cleanup
--     patch (they are leftovers of an older migration variant):
--     SELECT proname FROM pg_proc WHERE prosrc ILIKE '%mysterybakebite@gmail.com%';
--
-- (c) Check whether an Auth user was ever created with the OLD spelling.
--     If one exists, DELETE it in Dashboard -> Authentication -> Users
--     and recreate it as mysterybakebites@gmail.com AFTER APPLY_ALL:
--     SELECT email, created_at FROM auth.users ORDER BY created_at;
--
-- (d) Catalogue + admin roster sanity:
--     SELECT (SELECT count(*) FROM products) AS products,       -- expect 53
--            (SELECT count(*) FROM classes) AS classes,         -- expect 6
--            (SELECT count(*) FROM cake_options) AS cake_options; -- expect 45
--     SELECT email, role, is_primary_super_admin FROM public.admin_users;
-- =============================================================================
