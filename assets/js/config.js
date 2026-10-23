/* ============================================================================
   Mystery Bakebite — Production Supabase Configuration

   1. Set `url` to your Supabase Project URL (e.g. "https://xyzcompany.supabase.co").
   2. Set `anonKey` to your public `anon` / `publishable` key from:
        Supabase Dashboard -> Project Settings -> API
   3. NEVER place the `service_role` secret key in this file or any browser code.
      Privileged user-management operations use the server-side Edge Function
      (`supabase/functions/admin-users/index.ts`) and PostgreSQL `SECURITY DEFINER`
      functions (`supabase/migrations/20261022_production_schema_and_rls.sql`).
   4. When deployed via GitHub Actions (`.github/workflows/deploy.yml`),
      repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected
      automatically during the build step.
   ========================================================================== */
window.MB_CONFIG = window.MB_CONFIG || {
  url: "https://yquzgevklfkmkrrldeti.supabase.co",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxdXpnZXZrbGZrbWtycmxkZXRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NDk3ODEsImV4cCI6MjEwODMyNTc4MX0.4AGJ9kXEcKhsasm98UnJPHyNCdEzZpAnObNlzJTlKsU",
};
