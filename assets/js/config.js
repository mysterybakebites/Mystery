/* ============================================================================
   Mystery Bakebite — Production Supabase Configuration

   1. Set `url` to your Supabase Project URL (e.g. "https://xyzcompany.supabase.co").
   2. Set `anonKey` to your public `anon` / `publishable` key from:
        Supabase Dashboard -> Project Settings -> API
   3. NEVER place the `service_role` secret key in this file or any browser code.
      Privileged user-management operations use the server-side Edge Function
      (`supabase/functions/admin-users/index.ts`) and PostgreSQL `SECURITY DEFINER`
      functions (`supabase/migrations/20261022_canonical_schema_rbac_and_rls.sql`).
   4. When deployed via GitHub Actions (`.github/workflows/deploy.yml`),
      repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected
      automatically during the build step.
   ========================================================================== */
window.MB_CONFIG = window.MB_CONFIG || {
  url: 'https://yquzgevklfkmkrrldeti.supabase.co',
  anonKey: 'sb_publishable_6p7UoK0r88nHndISo7Wltg_AgJM3DO4',

  /* Baker's WhatsApp number in international digits form, e.g. '233554520532'.
     Used only for the one-tap "notify the baker" fallback link on the order
     confirmation page. Leave blank to hide that link. This is the BAKERY's own
     public number, so it is safe in client code — never a WhatsApp API token. */
  bakerWhatsApp: ''
};
