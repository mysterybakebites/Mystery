/**
 * Mystery Bakebite — New-order WhatsApp alert
 * ---------------------------------------------------------------------------
 * Sends the baker a WhatsApp message as soon as an order is recorded.
 *
 * Deploy (the browser sends a publishable key, which is not a JWT, so gateway
 * JWT verification must be OFF; this function performs its own authorisation):
 *
 *   supabase functions deploy notify-order --no-verify-jwt
 *
 * Required secrets (Supabase Dashboard → Edge Functions → Secrets):
 *   WHATSAPP_TOKEN             permanent WhatsApp Cloud API access token
 *   WHATSAPP_PHONE_NUMBER_ID   the business phone-number id that sends the alert
 *
 * Optional:
 *   BAKER_WHATSAPP_NUMBER      recipient override, international digits
 *                              e.g. 233554520532. When unset the function uses
 *                              settings.whatsapp_number, then the public
 *                              settings.whatsapp_contact line.
 *   WHATSAPP_TEMPLATE_NAME     name of an approved template. WhatsApp only allows
 *                              free-form text to a number that has messaged the
 *                              business within the last 24 hours; outside that
 *                              window a template is mandatory. When this is set
 *                              the function sends the template with the summary
 *                              as its single body parameter.
 *   WHATSAPP_API_VERSION       defaults to v20.0
 *   NOTIFY_WEBHOOK_SECRET      required for the Database Webhook path
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase and are
 * never exposed to the browser.
 *
 * Two ways to trigger it:
 *   1. Database Webhook on public.orders INSERT  → fully automatic, server-side.
 *      Requires NOTIFY_WEBHOOK_SECRET to be set; without it this path is
 *      rejected so the endpoint cannot be used to force notifications.
 *   2. The checkout page calls it with { ref, token } right after the order is
 *      created. The token proves the caller owns that order, so this cannot be
 *      used to spam arbitrary orders.
 *
 * Either path is idempotent: orders.notified_at is set once, and a second call
 * returns alreadyNotified instead of sending a duplicate.
 *
 * HONESTY NOTE: this function calls the WhatsApp Cloud API. It only sends a
 * message when WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are configured. If
 * they are not, it returns sent:false and the checkout page offers a one-tap
 * pre-filled wa.me link that a human must send manually. The two paths are not
 * the same thing and the UI must not pretend otherwise.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PAYMENT_LABELS: Record<string, string> = {
  awaiting_payment: 'Awaiting Payment',
  payment_submitted: 'Proof submitted — Pending Verification',
  payment_verified: 'Payment Verified',
  payment_rejected: 'Payment Rejected',
  pay_on_collection: 'Pay on Collection',
  not_required: 'Not Required',
};

const METHOD_LABELS: Record<string, string> = {
  momo: 'Mobile Money',
  bank_transfer: 'Bank transfer',
  cash_on_pickup: 'Cash on pickup',
  cash_on_delivery: 'Cash on delivery',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** "MB-261023-ABCD" -> human readable date, e.g. "Fri, 23 Oct 2026" */
function prettyDate(ymd: string): string {
  if (!ymd) return 'Not specified';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** 250000 (pesewas) -> "GH₵2,500.00" */
function money(pesewas: unknown): string {
  const n = Number(pesewas);
  if (!Number.isFinite(n)) return '—';
  return 'GH\u20B5' + (n / 100).toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Builds the "2 × Milky donuts, 6 pcs; 1 × Birthday cake" summary. */
function summarise(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return 'No line items recorded';
  const parts = items.slice(0, 8).map((raw: any) => {
    const qty = Number(raw?.qty ?? 1) || 1;
    const name = String(raw?.name ?? raw?.itemName ?? raw?.sku ?? 'Item').trim();
    const meta = String(raw?.meta ?? raw?.itemMeta ?? '').trim();
    return `${qty} × ${name}${meta ? ` (${meta})` : ''}`;
  });
  if (items.length > 8) parts.push(`+${items.length - 8} more`);
  return parts.join('; ');
}

function fulfilmentLine(order: any): string {
  if (order.fulfilment === 'delivery') {
    const addr = String(order.address || '').trim();
    return addr ? `Delivery to ${addr}` : 'Delivery (address not recorded)';
  }
  return 'Collection from the kitchen';
}

function buildMessage(order: any): string {
  const payment = PAYMENT_LABELS[String(order.payment_status)] || 'Pending Verification';
  const method = METHOD_LABELS[String(order.payment_method)] || String(order.payment_method || '—');
  const lines = [
    '🍰 *New Order | Mystery Bakebite*',
    '',
    `*Reference:* ${order.ref || '—'}`,
    `*Customer:* ${order.customer_name || 'Not provided'}`,
    `*Phone:* ${order.phone || 'Not provided'}`,
    `*Items:* ${summarise(order.items)}`,
    `*Total:* ${money(order.total)}`,
    `*Date needed:* ${prettyDate(String(order.event_date || ''))}`,
    `*${fulfilmentLine(order)}*`,
    `*Payment method:* ${method}`,
    `*Payment status:* ${payment}`,
    '',
    'Log in to the admin dashboard to review, verify payment and approve.',
  ];
  if (order.notes) lines.push('', `*Notes:* ${String(order.notes).slice(0, 300)}`);
  return lines.join('\n');
}

function digitsOnly(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

async function sendWhatsApp(to: string, text: string, orderRef: string): Promise<{ ok: boolean; detail: string }> {
  const token = Deno.env.get('WHATSAPP_TOKEN') || '';
  const phoneId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';
  const version = Deno.env.get('WHATSAPP_API_VERSION') || 'v20.0';
  const template = Deno.env.get('WHATSAPP_TEMPLATE_NAME') || '';

  if (!token || !phoneId) {
    return { ok: false, detail: 'WhatsApp Cloud API credentials are not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).' };
  }
  if (!to) {
    return { ok: false, detail: 'No baker WhatsApp number is configured (settings.whatsapp_number, settings.whatsapp_contact or BAKER_WHATSAPP_NUMBER).' };
  }

  const body = template
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template,
          language: { code: Deno.env.get('WHATSAPP_TEMPLATE_LANG') || 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: `${orderRef}` }] }],
        },
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: text } };

  const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await res.text();
  if (!res.ok) {
    return { ok: false, detail: `WhatsApp API ${res.status}: ${payload.slice(0, 400)}` };
  }
  return { ok: true, detail: payload.slice(0, 400) };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);

  let input: any = {};
  try {
    input = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, error: 'Supabase environment is not configured for this function.' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  /* Resolve the order reference and how it was authorised. */
  const isWebhook = typeof input?.record === 'object' && input?.record !== null;
  const ref = String((isWebhook ? input.record.ref : input.ref) || '').trim().toUpperCase();
  if (!ref) return json({ ok: false, error: 'Missing order reference' }, 400);

  if (isWebhook) {
    /* Fail CLOSED. The function is deployed with --no-verify-jwt, so an
       unauthenticated caller reaching this branch could otherwise force a
       notification for any order reference they can guess. The secret must be
       present in the environment AND match. */
    const expected = Deno.env.get('NOTIFY_WEBHOOK_SECRET') || '';
    if (!expected) {
      return json({
        ok: false,
        error: 'NOTIFY_WEBHOOK_SECRET is not set on this function, so the webhook path is disabled.',
      }, 503);
    }
    const supplied = req.headers.get('x-notify-secret') || '';
    if (supplied !== expected) {
      return json({ ok: false, error: 'Invalid webhook secret' }, 401);
    }
  }

  const { data: order, error } = await admin
    .from('orders')
    .select('ref, token, customer_name, phone, items, total, fulfilment, address, event_date, payment_method, payment_status, notes, notified_at')
    .eq('ref', ref)
    .maybeSingle();

  if (error || !order) return json({ ok: false, error: 'Order not found' }, 404);

  /* Browser calls must prove ownership with the order token. Webhook calls are
     already authenticated by the shared secret above. */
  if (!isWebhook) {
    const supplied = String(input.token || '').trim();
    if (!supplied || supplied !== String(order.token || '')) {
      return json({ ok: false, error: 'Invalid order token' }, 403);
    }
  }

  if (order.notified_at) {
    return json({ ok: true, alreadyNotified: true, notifiedAt: order.notified_at });
  }

  const { data: settings } = await admin
    .from('settings')
    .select('whatsapp_number, whatsapp_contact')
    .eq('id', 1)
    .maybeSingle();

  /* Priority: explicit override secret, then the private alert number, then the
     public WhatsApp line. Mirrors api_config()->contact.alerts so the automatic
     alert and the browser fallback link always agree. */
  const to = digitsOnly(Deno.env.get('BAKER_WHATSAPP_NUMBER'))
    || digitsOnly(settings?.whatsapp_number)
    || digitsOnly(settings?.whatsapp_contact);

  const message = buildMessage(order);

  const result = await sendWhatsApp(to, message, ref);

  if (!result.ok) {
    /* The order row is already committed, so a notification failure never loses
       an order. notified_at stays NULL so a retry can still send it later. */
    return json({ ok: false, sent: false, error: result.detail, message }, 502);
  }

  await admin.from('orders').update({ notified_at: new Date().toISOString() }).eq('ref', ref);

  return json({ ok: true, sent: true, to, message });
});
