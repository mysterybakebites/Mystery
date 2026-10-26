// =============================================================================
// Mystery Bakebite — Supabase Edge Function: admin-users
//
// Handles privileged user management operations (create, invite, update_role,
// set_status, reset_password, remove) using the server-side service_role key
// after strictly verifying that the caller is the active primary Super
// Administrator (mysterybakebites@gmail.com).
//
// Deploy with:
//   supabase functions deploy admin-users
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const PRIMARY_SUPER_ADMIN_EMAIL = 'mysterybakebites@gmail.com';
const ALLOWED_ROLES = ['administrator', 'manager', 'viewer'] as const;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const all = upper + lower + digits;
  const rnd = (max: number) => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
  };
  const chars = [
    upper[rnd(upper.length)],
    upper[rnd(upper.length)],
    lower[rnd(lower.length)],
    lower[rnd(lower.length)],
    digits[rnd(digits.length)],
    digits[rnd(digits.length)],
    symbols[rnd(symbols.length)],
  ];
  for (let i = 0; i < 5; i++) chars.push(all[rnd(all.length)]);
  for (let j = chars.length - 1; j > 0; j--) {
    const k = rnd(j + 1);
    [chars[j], chars[k]] = [chars[k], chars[j]];
  }
  return 'MB-' + chars.join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return Response.json(
        { ok: false, error: 'Server environment is missing Supabase credentials.' },
        { status: 500, headers: corsHeaders }
      );
    }

    // 1. Verify caller identity using the caller's JWT
    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userRes?.user) {
      return Response.json(
        { ok: false, auth: true, code: 'unauthorised', error: 'Invalid or expired session.' },
        { status: 401, headers: corsHeaders }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey);

    // 2. Verify caller is in public.admin_users, active, and has completed first-login password change
    const { data: callerRow, error: callerDbErr } = await adminClient
      .from('admin_users')
      .select('*')
      .eq('user_id', userRes.user.id)
      .single();

    if (callerDbErr || !callerRow || !callerRow.active) {
      return Response.json(
        { ok: false, auth: true, code: 'unauthorised', error: 'Administrator access required.' },
        { status: 403, headers: corsHeaders }
      );
    }

    if (callerRow.must_change_password) {
      return Response.json(
        {
          ok: false,
          code: 'password_change_required',
          mustChangePassword: true,
          error: 'You must change your temporary password before accessing user management.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'list').toLowerCase();
    const isCallerSuperAdmin =
      callerRow.role === 'super_admin' &&
      String(callerRow.email || '').toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL &&
      callerRow.is_primary_super_admin === true;

    if (action === 'list') {
      const { data: roster } = await adminClient
        .from('admin_users')
        .select('*')
        .order('is_primary_super_admin', { ascending: false })
        .order('created_at', { ascending: true });

      const { data: logs } = isCallerSuperAdmin
        ? await adminClient
            .from('admin_audit_log')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50)
        : { data: [] };

      return Response.json(
        {
          ok: true,
          canManageTeam: isCallerSuperAdmin,
          primarySuperAdminEmail: PRIMARY_SUPER_ADMIN_EMAIL,
          admins: (roster || []).map((a) => ({
            userId: a.user_id,
            email: a.email,
            name: a.name,
            role: a.role,
            isPrimarySuperAdmin: a.is_primary_super_admin,
            active: a.active,
            mustChangePassword: a.must_change_password,
            isProvisioned: true,
            createdAt: a.created_at,
            lastSignInAt: a.last_sign_in_at,
            passwordChangedAt: a.password_changed_at,
          })),
          auditLog: (logs || []).map((l) => ({
            id: l.id,
            action: l.action,
            actor: l.actor_email,
            target: l.target_email,
            details: l.details,
            at: l.created_at,
          })),
        },
        { headers: corsHeaders }
      );
    }

    // 3. Exclusive Super Administrator check for all mutations
    if (!isCallerSuperAdmin) {
      return Response.json(
        {
          ok: false,
          code: 'forbidden',
          error: `Only the primary Super Administrator (${PRIMARY_SUPER_ADMIN_EMAIL}) is authorized to manage user accounts and roles.`,
        },
        { status: 403, headers: corsHeaders }
      );
    }

    if (action === 'create' || action === 'invite') {
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim().slice(0, 80);
      const role = String(body.role || 'administrator').trim().toLowerCase();
      const tempPassword = String(body.password || '').trim() || generateTemporaryPassword();

      if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) {
        return Response.json({ ok: false, error: 'Enter a valid email address.' }, { headers: corsHeaders });
      }
      if (email === PRIMARY_SUPER_ADMIN_EMAIL || role === 'super_admin') {
        return Response.json(
          {
            ok: false,
            code: 'super_admin_exclusive',
            error: `The Super Administrator role is exclusively reserved for ${PRIMARY_SUPER_ADMIN_EMAIL}.`,
          },
          { headers: corsHeaders }
        );
      }
      if (!ALLOWED_ROLES.includes(role as typeof ALLOWED_ROLES[number])) {
        return Response.json({ ok: false, error: 'Invalid role selected.' }, { headers: corsHeaders });
      }

      const { data: createdAuth, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { name, role, must_change_password: true },
      });

      if (createErr || !createdAuth?.user) {
        return Response.json(
          { ok: false, error: createErr?.message || 'Could not create user in Supabase Auth.' },
          { headers: corsHeaders }
        );
      }

      await adminClient.from('admin_users').upsert({
        user_id: createdAuth.user.id,
        email,
        name: name || email.split('@')[0],
        role,
        is_primary_super_admin: false,
        active: true,
        must_change_password: true,
        invited_by: PRIMARY_SUPER_ADMIN_EMAIL,
      });

      await adminClient.from('admin_audit_log').insert({
        action: 'user_created',
        actor_email: PRIMARY_SUPER_ADMIN_EMAIL,
        target_email: email,
        details: `Created user ${email} with role "${role}" (mandatory first-login password change enabled)`,
      });

      return Response.json(
        {
          ok: true,
          user: { userId: createdAuth.user.id, email, name, role, active: true, mustChangePassword: true },
          temporaryPassword: tempPassword,
          mustChangePassword: true,
        },
        { headers: corsHeaders }
      );
    }

    const targetId = String(body.userId || '').trim();
    const { data: targetUser } = await adminClient
      .from('admin_users')
      .select('*')
      .eq('user_id', targetId)
      .single();

    if (!targetUser) {
      return Response.json({ ok: false, code: 'not_found', error: 'Target user not found.' }, { headers: corsHeaders });
    }

    if (String(targetUser.email).toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL || targetUser.is_primary_super_admin) {
      return Response.json(
        {
          ok: false,
          code: 'super_admin_protected',
          error: `The primary Super Administrator (${PRIMARY_SUPER_ADMIN_EMAIL}) is protected and cannot be modified or removed.`,
        },
        { status: 403, headers: corsHeaders }
      );
    }

    if (action === 'reset_password') {
      const tempPassword = String(body.password || '').trim() || generateTemporaryPassword();
      const { error: pwErr } = await adminClient.auth.admin.updateUserById(targetId, {
        password: tempPassword,
        user_metadata: { must_change_password: true },
      });
      if (pwErr) {
        return Response.json({ ok: false, error: pwErr.message }, { headers: corsHeaders });
      }
      await adminClient
        .from('admin_users')
        .update({ must_change_password: true })
        .eq('user_id', targetId);

      await adminClient.from('admin_audit_log').insert({
        action: 'password_reset_required',
        actor_email: PRIMARY_SUPER_ADMIN_EMAIL,
        target_email: targetUser.email,
        details: `Issued temporary password reset for ${targetUser.email} (mandatory change on next login)`,
      });

      return Response.json(
        { ok: true, temporaryPassword: tempPassword, mustChangePassword: true },
        { headers: corsHeaders }
      );
    }

    if (action === 'remove') {
      await adminClient.from('admin_users').delete().eq('user_id', targetId);
      await adminClient.auth.admin.deleteUser(targetId);
      await adminClient.from('admin_audit_log').insert({
        action: 'user_removed',
        actor_email: PRIMARY_SUPER_ADMIN_EMAIL,
        target_email: targetUser.email,
        details: `Removed user ${targetUser.email} from administrative roster`,
      });
      return Response.json({ ok: true, removedEmail: targetUser.email }, { headers: corsHeaders });
    }

    // Delegate role / status updates to the database RPC
    const { data: rpcRes } = await callerClient.rpc('api_admin_team', { p_payload: body });
    return Response.json(rpcRes ?? { ok: true }, { headers: corsHeaders });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unexpected server error.' },
      { status: 500, headers: corsHeaders }
    );
  }
});
