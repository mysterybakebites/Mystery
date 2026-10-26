# Business Contact Profile — one source of truth

Every phone number, email address, WhatsApp link, social account, address and
opening time shown on the website now comes from **one row in the database**.
Nothing is hardcoded in a page any more.

---

## 1. How it works

```
settings table (one row)
        │
        ▼
api_config()  ──►  { ok, config: { …, contact: { … } } }   ← public, anonymous
        │
        ▼
assets/js/contact.js  (MB.contact)
        │
        ▼
every [data-contact] and [data-contact-link] placeholder on every page
```

- **Read path:** `api_config()` is `SECURITY DEFINER`. `public.settings` still
  has no `SELECT` grant for `anon` — the contact block is an explicit allow-list,
  so no order, customer, token or administrator record is reachable through it.
- **Write path:** `api_admin_settings()` requires `has_admin_permission('settings')`.
- **Admin UI:** *Dashboard → Payments & settings → **Business profile***.

The browser fetches the profile once per page load and caches it in
`sessionStorage`, so navigation between pages does not re-request it.

---

## 2. Editing the details

1. Sign in at `admin.html` as an administrator with the **settings** permission.
2. Open **Payments & settings**.
3. The **Business profile** panel holds every public detail, grouped:
   - identity (business name, tagline)
   - phone for click-to-call, and how the number is displayed
   - email, WhatsApp number, default WhatsApp message
   - address (two lines, city, region, country, optional map link)
   - opening hours (days, opens, closes, note)
   - social accounts (Instagram, Facebook, TikTok, X, YouTube)
4. **Save business profile**. The change is live for the next page load.

---

## 3. Validation rules

Validation happens in the database, so a malformed value cannot be stored by any
route — including direct SQL. Each rule returns a specific error code and the
dashboard shows the message next to the form.

| Field | Rule | Rejection code |
|---|---|---|
| Phone / WhatsApp | 7–15 digits after stripping non-digits | `invalid_phone`, `invalid_whatsapp` |
| Email | `name@domain.tld` shape | `invalid_email` |
| Map link, social links | must start `http://` or `https://` | `invalid_map_url`, `invalid_social` |
| Opening / closing | 24-hour `HH:MM` | `invalid_hours` |

The same rules exist as `CHECK` constraints on `settings`, so the table itself
enforces them.

---

## 4. Missing and invalid values

The page must never render a blank footer or a dead link, so:

- **Database unreachable / older database without the contact block** → the
  module falls back to `DEFAULTS` in `contact.js`. This is the **only** copy of
  the old values in the codebase, and it mirrors what was previously published
  so the site degrades to its current appearance rather than to blank space.
- **A field is invalid** (e.g. `phone: "abc"`) → that field keeps the fallback;
  the rest of the profile is still applied. A half-filled row is harmless.
- **A social link is left blank** → that control is **hidden**, not rendered as
  an empty `href`. This distinguishes "never configured" from "deliberately
  removed": if the database sends a `social` object, empty means removed.
- **A phone has no value at all** → the click-to-call link is hidden rather than
  pointing at `tel:` with no number.

Nothing is ever blanked by a failed fetch.

---

## 5. Where the values appear

| Surface | Placeholder | Count |
|---|---|---|
| Header WhatsApp button | `data-contact-link="whatsapp"` | 10 |
| Slide-out menu hours + location | `data-contact="hours"`, `addressShort` | 10 each |
| Footer phone / email / Instagram | `data-contact` + `data-contact-link` | 10 each |
| Footer opening hours and address | `hoursDays`, `hoursTime`, `address` | 10 each |
| Footer copyright | `businessName`, `tagline`, `addressShort` | 10 each |
| Contact page cards | WhatsApp, **Call** (`tel:`), Email, Instagram | 1 each |
| Contact page hours / location cards | `hoursDays`, `hoursTime`, `hoursNote`, `addressShort`, `region` | 1 each |
| Contact page hero chips | `hoursDays`, `hoursTime`, `addressRegion` | 1 each |

Totals across the site: **34 WhatsApp links, 21 email links, 11 Instagram links,
12 phone displays** — all driven from the single row.

Order alerts use `contact.alerts`, which is
`coalesce(settings.whatsapp_number, settings.whatsapp_contact)` — so the one-tap
fallback link and the automatic `notify-order` alert now have a target without
extra configuration.

---

## 6. Files

| File | Role |
|---|---|
| `assets/js/contact.js` | the module: fetch, normalise, apply |
| `supabase/migrations/20261026_business_contact_profile.sql` | columns, constraints, `api_config()`, `api_admin_settings()` |
| `assets/js/admin.js` | the **Business profile** panel |
| `assets/js/supabase.js` | `buildPublicConfig()` mirrors the same `contact` shape for offline mode |

## 7. Guard test

`tests/security-tests.mjs` fails the build if any page reintroduces a hardcoded
`wa.me` link, Instagram URL, display phone, `mailto:` or email address (the
Super-Administrator address on `admin.html` is an identity, not a contact
detail, and is exempt). It was verified by deliberately reintroducing a hardcoded
`wa.me` link and confirming the suite failed with
`index.html: hardcoded wa.me link`.
