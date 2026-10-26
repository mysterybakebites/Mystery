# Classes Loading Failure — Root Cause Report

**Date:** 25 October 2026
**Scope:** `classes.html` ("the courses are not loading") and the business contact
information now available to the admin.
**Status:** Cause identified and fixed in code. **One deployment step remains
yours to run** — see §5.

---

## 1. Summary of the fault

The courses did not fail to load because of a styling problem, a JavaScript
error, or a permissions rule. They failed for **three independent reasons**, and
fixing only one would still have left the page empty:

| # | Fault | Evidence | Effect |
|---|---|---|---|
| 1 | `api_catalogue()` does not exist in the live project | `POST /rest/v1/rpc/api_catalogue` → `PGRST202 Could not find the function` | The page took its error branch immediately |
| 2 | Every catalogue table is empty | `classes`, `products`, `categories`, `cake_options` all returned HTTP 200 with `[]` | Even with the RPC, the page would render an empty grid |
| 3 | `bringNote` was dropped between database and page | `public.classes` had no `bring_note`; `api_catalogue()` never emitted the key | The "what to bring" paragraph would be blank |

Fault 1 is what a visitor sees. Fault 2 is why fixing fault 1 alone would not
have been enough. Fault 3 is a data-loss bug found while investigating.

---

## 2. How each was confirmed

### 2.1 The RPC is genuinely missing

```
POST https://yquzgevklfkmkrrldeti.supabase.co/rest/v1/rpc/api_catalogue
{"code":"PGRST202",
 "message":"Could not find the function public.api_catalogue without parameters in the schema cache"}
```

`api_config` and `api_price` return the same code. All three are defined in
`supabase/migrations/20261024_public_read_layer.sql`, which has never been
applied to the live project.

`PGRST202` — rather than a plain 404 — is the reliable "function missing" signal
from PostgREST, and it is what `classes.js` now recognises explicitly.

### 2.2 The tables are empty, and it is **not** RLS

This is the part worth being careful about, because an empty array is also what
Row Level Security looks like from outside.

The distinguishing evidence is `cake_options`:

- its policy is `CREATE POLICY "public_read_cake_options" ... FOR SELECT USING (TRUE)`
- there is **no** `published` filter and **no** admin check
- it still returned `[]`

A policy cannot hide a row when its condition is `TRUE`, so the table itself
holds no rows. `classes`, `products` and `categories` behave identically, and a
search of the repository found no seed file and no `INSERT INTO public.classes`
anywhere. The tables have simply never been populated.

### 2.3 `bringNote`

`assets/js/classes.js` renders `c.bringNote`. The column did not exist on
`public.classes`, and the `jsonb_build_object` in `api_catalogue()` had no
`bringNote` key. The paragraph would have rendered empty with real data present.

---

## 3. What was changed

### 3.1 Migration `20261027_catalogue_repair_and_seed.sql` (new)

1. `ALTER TABLE public.classes ADD COLUMN IF NOT EXISTS bring_note TEXT` — idempotent.
2. `CREATE OR REPLACE FUNCTION public.api_catalogue()` redefined to emit `bringNote`.
3. Seeds `categories` (9), `products` (53), `classes` (6) and `cake_options` (45).

**The seed data is not invented.** Every row is read from the `LOCAL_SEED` block
in `assets/js/supabase.js`, which is the catalogue the site was already
publishing. Same SKUs, same prices in pesewas, same class fees, same recipe
lists. Nothing was renamed, repriced or added.

The seed uses `ON CONFLICT DO NOTHING` throughout, which means:

- running it twice changes nothing;
- it will **never** overwrite a price or course you have since edited in the
  dashboard;
- if you had already entered the catalogue by hand, your values win.

### 3.2 Row Level Security — verified, not changed

Visitors can already read published classes without an account:

```sql
CREATE POLICY "public_read_classes" ON public.classes
  FOR SELECT USING (published = TRUE OR public.is_verified_admin());
```

This is correct for the requirement "visitors can retrieve published class
information without requiring a customer account", and it was left alone. No
customer sign-in is involved anywhere in the classes path.

### 3.3 Environment / key configuration — verified

`assets/js/config.js` holds the correct live project URL and the publishable
key. Anonymous reads against `products`, `categories`, `classes` and
`cake_options` all return HTTP 200, so the key and URL are working; the
`settings` table correctly refuses anon with `42501`, which is why contact
details are published through `api_config()` instead.

### 3.4 Application logic — `assets/js/classes.js`

The old error path had two problems: it blanked the pastry column, leaving a
half-empty page, and it offered no recovery except a manual refresh. Replaced
with a single `loadCourses()` that:

- renders a specific message per cause (`PGRST202`, `not_configured`, network,
  `42501`, anything else);
- fills **both** track columns with the failure notice;
- adds a **Try again** button that re-runs the fetch;
- handles "the call worked but returned nothing" as its own case with a plain
  explanation rather than an empty grid;
- can never hang on "Loading the bread courses…".

---

## 4. Testing

### Local

```
node tests/security-tests.mjs     -> 189 passed, 0 failed
node tests/ui-tests.mjs           ->  59 passed, 0 failed   (needs: npm install jsdom)
python3 tests/sql-parse-check.py  ->  54 parsed, 0 failed
```

`tests/ui-tests.mjs` runs the **real page HTML with the real scripts** in jsdom.
It covers all six course scenarios: missing RPC, empty catalogue, network
failure, a successful six-course render, the retry recovering, and the bundle
discounts (2 courses −15%, 3 courses −25%).

Two bugs were found and fixed by these tests while writing them:

- `normalise()` did not fall back to defaults for nested fields, so an
  unreachable database would have emptied the address and the Instagram link.
- A deliberately cleared social link would have been repopulated from the
  default rather than hidden.

### Live project

Cannot be completed from the development environment: applying a migration
needs the `service_role` key or dashboard access, neither of which exists here
(and the service key must never reach browser code). What **was** verified
against the live project is the fault itself — see §2.

---

## 5. What you must do

Run, in order:

```
20261022 → 20261023 → 20261024 → 20261025 → 20261026 → 20261027
```

`20261024` and `20261027` are the two that fix the classes page. `20261027`
depends on `20261024` (it redefines `api_catalogue()`).

Then verify:

```bash
# 1. the RPC exists and returns courses
curl -s -X POST "https://yquzgevklfkmkrrldeti.supabase.co/rest/v1/rpc/api_catalogue" \
  -H "apikey: sb_publishable_6p7UoK0r88nHndISo7Wltg_AgJM3DO4" \
  -H "Content-Type: application/json" -d '{}' | head -c 400
# expect: {"ok": true, "classes": [ ... six courses ... ]}

# 2. the seed landed
curl -s "https://yquzgevklfkmkrrldeti.supabase.co/rest/v1/classes?select=slug,name,fee" \
  -H "apikey: sb_publishable_6p7UoK0r88nHndISo7Wltg_AgJM3DO4"
# expect: six rows
```

The migration also prints a `NOTICE` with the row counts after seeding.

Then open `classes.html` on the deployed site and confirm six course cards
render across the two tracks.

---

## 6. Remaining configuration steps

1. **Apply the two migrations** (above). Nothing else will fix the page.
2. **Deploy the updated files** — `classes.html`, `assets/js/classes.js`,
   `assets/js/contact.js`, `assets/js/admin.js`, `assets/js/supabase.js`,
   `assets/js/config.js`, and all ten edited HTML pages.
3. **Set the alert number.** `settings.whatsapp_number` is separate from the
   public WhatsApp line and defaults to empty. It now falls back to the public
   WhatsApp number, so order alerts have a target without extra configuration —
   set it explicitly only if the private alert number should differ.
4. **Optional:** add `bakerWhatsApp` to `config.js` only if you want to
   override the contact profile for the one-tap fallback link.

---

## 7. Honest limitations

- The migrations have not been executed against a live PostgreSQL server. They
  are syntax-checked with `pglast` (which parses both plain SQL and PL/pgSQL
  bodies), but syntax-clean is not the same as execution-clean. The first run on
  your project is the real test; every file is wrapped in `BEGIN`/`COMMIT`, so a
  failure rolls back cleanly.
- The seed reproduces the catalogue **as it stood in the repository**. If you
  changed a price on the live site after that snapshot, the seeded value will be
  the older one — edit it once in the dashboard and it will not be touched again.
- I could not test against the deployed GitHub Pages URL: no remote or CNAME is
  present in the workspace, so the deployment address is not discoverable from
  here.
