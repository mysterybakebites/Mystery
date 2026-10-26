/* ============================================================================
   Mystery Bakebite — Example Configuration Template
   Copy to `assets/js/config.js` or configure via GitHub Actions Secrets:
     - SUPABASE_URL
     - SUPABASE_ANON_KEY
     - BAKER_WHATSAPP   (optional, e.g. 233554520532)
   ========================================================================== */
window.MB_CONFIG = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'YOUR_SUPABASE_PUBLIC_ANON_KEY',

  /* Optional. The bakery's own WhatsApp number in international digits form.
     Only used for the one-tap "notify the baker" link on the order confirmation
     page when the automatic alert is unavailable. Leave blank to hide the link.
     This is a public phone number, never a WhatsApp API token. */
  bakerWhatsApp: ''
};
