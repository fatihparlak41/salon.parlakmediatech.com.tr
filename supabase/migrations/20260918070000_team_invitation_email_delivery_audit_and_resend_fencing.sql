-- Faz SAAS.1C.2C — email delivery audit + resend concurrency fencing.
--
-- =====================================================================
-- PART 1 — RESEND OPTIMISTIC CONCURRENCY FENCING
-- =====================================================================
--
-- Real risk closed here: two concurrent resend requests both call
-- resend_team_invitation, serialize on the invitation row's FOR UPDATE
-- lock, and rotate the token one after the other — the first caller's
-- just-sent email then contains a token the second rotation already
-- invalidated. A UI button-disable is not a security boundary; this
-- closes it at the RPC contract level instead.
--
-- The public/private (uuid) signature from 20260917080000 is DROPPED,
-- not left coexisting — Faz SAAS.1C.1 is the only phase where this RPC
-- has ever been live in PROD, and no Team UI exists yet to depend on
-- the old shape (confirmed fresh: zero references anywhere in app/ or
-- lib/ to the unfenced signature before this migration). Replaced by
-- (uuid, timestamptz): the caller must supply the invitation's
-- expires_at exactly as they last observed it.
--
-- Concurrency argument: both callers may read the same original
-- expires_at before either mutates anything. Both then call resend;
-- both block on the SAME row's FOR UPDATE lock. Whichever acquires it
-- first checks p_expected_expires_at against the CURRENT (matching, at
-- this point) value, passes, rotates, and commits. The second, once it
-- acquires the lock (after the first has already committed, since FOR
-- UPDATE releases only at transaction end), re-reads the row under
-- READ COMMITTED semantics — the SAME per-statement-fresh-snapshot
-- guarantee already relied on by the last-unrestricted-holder invariant
-- (20260917080000, PART 1) — and now sees the FIRST caller's
-- already-rotated expires_at, which no longer matches what it itself
-- observed before either call started. It raises invitation_changed and
-- rotates nothing. Unlike the deferred constraint triggers in PART 1 of
-- 20260917080000, this needs no deferred/constraint-trigger machinery:
-- it's a single mutating statement inside one RPC call already holding
-- the row lock, not a check that must reconcile multiple rows across a
-- whole transaction.
--
-- Ordering matches the locked design exactly: auth/permission-ceiling
-- and the existing status/expiry checks all still run BEFORE the
-- fencing compare, unchanged from the current body. A caller who
-- observed stale state that ALSO happens to be genuinely expired still
-- gets the more fundamental "expired" result (a clean, non-error
-- transition, exactly as today), not invitation_changed — expiry is a
-- real terminal fact about the row regardless of what the caller
-- expected to see.

drop function if exists public.resend_team_invitation(uuid);
drop function if exists private.resend_team_invitation(uuid);

create function private.resend_team_invitation(p_invitation_id uuid, p_expected_expires_at timestamptz)
returns table (
  id uuid,
  status text,
  expires_at timestamptz,
  token text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_role_id uuid;
  v_status text;
  v_expires_at timestamptz;
  v_target_permission_keys text[];
  v_raw_token text;
  v_token_hash text;
  v_new_expires_at timestamptz;
begin
  select team_invitations.tenant_id, team_invitations.role_id, team_invitations.status, team_invitations.expires_at
    into v_tenant_id, v_role_id, v_status, v_expires_at
  from public.team_invitations
  where team_invitations.id = p_invitation_id
  for update;

  if v_tenant_id is null then
    raise exception 'invitation_not_found';
  end if;

  if not private.has_permission(v_tenant_id, 'staff.manage') then
    raise exception 'staff.manage required';
  end if;

  select array_agg(p.key) into v_target_permission_keys
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = v_role_id;

  if not private.caller_can_grant_permissions(v_tenant_id, coalesce(v_target_permission_keys, array[]::text[])) then
    raise exception 'cannot resend an invitation into a role with permissions you do not hold';
  end if;

  if v_status <> 'pending' then
    raise exception 'invitation_not_pending';
  end if;

  if v_expires_at <= now() then
    update public.team_invitations
    set status = 'expired', updated_at = now()
    where team_invitations.id = p_invitation_id;

    return query select p_invitation_id, 'expired'::text, v_expires_at, null::text;
    return;
  end if;

  -- Optimistic fencing — see this migration's own header for the full
  -- concurrency argument.
  if v_expires_at <> p_expected_expires_at then
    raise exception 'invitation_changed';
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_new_expires_at := now() + interval '7 days';

  update public.team_invitations
  set token_hash = v_token_hash, expires_at = v_new_expires_at, updated_at = now()
  where team_invitations.id = p_invitation_id;

  perform private.log_audit_event(
    v_tenant_id, 'team_invitation.resent', 'team_invitation', p_invitation_id, null, null
  );

  return query select p_invitation_id, 'pending'::text, v_new_expires_at, v_raw_token;
end;
$$;

create function public.resend_team_invitation(p_invitation_id uuid, p_expected_expires_at timestamptz)
returns table (
  id uuid,
  status text,
  expires_at timestamptz,
  token text
)
language sql
security definer
set search_path = ''
as $$
  select * from private.resend_team_invitation(p_invitation_id, p_expected_expires_at);
$$;

revoke execute on function private.resend_team_invitation(uuid, timestamptz) from public;
revoke execute on function public.resend_team_invitation(uuid, timestamptz) from public;
grant execute on function public.resend_team_invitation(uuid, timestamptz) to authenticated;

-- =====================================================================
-- PART 2 — EMAIL DELIVERY AUDIT (service_role only)
-- =====================================================================
--
-- Narrow, server-side-only observability write: did an invitation email
-- attempt succeed or fail, for which invitation, via which provider.
-- Not browser-callable under any role — authenticated, anon, and PUBLIC
-- are all explicitly denied; only service_role may call it, matching
-- this project's one existing service_role-grantable precedent
-- (get_push_subscriptions_for_test_send, 20260914121000) for "a
-- function only trusted server-side code may invoke."
--
-- Deliberately does NOT call private.log_audit_event(...): that
-- function always attributes actor_user_id to auth.uid() internally,
-- which is NULL under a service_role-authenticated call — every event
-- this RPC ever wrote would be attributed to no one, defeating the
-- actor-validation this phase explicitly requires. Adding an actor-
-- override parameter to log_audit_event itself would touch a function
-- every mutation RPC in this schema depends on for a capability only
-- this one narrow caller needs — the smaller-blast-radius choice is a
-- direct, explicit insert into audit_logs here, mirroring
-- log_audit_event's own column shape exactly (actor_type='user', same
-- table, same action-naming convention) with the validated
-- p_actor_user_id in place of auth.uid().
--
-- tenant_id is derived from team_invitations by p_invitation_id, never
-- trusted from the caller. p_actor_user_id is validated against a real,
-- currently-active, non-deleted membership in that SAME tenant before
-- anything is written — this RPC cannot be used to log an event
-- attributed to an unrelated user or a different tenant. This
-- authorization is for the AUDIT WRITE only; the invitation mutation
-- itself was already authorized by create_team_invitation/
-- resend_team_invitation before this is ever called.

create function private.log_team_invitation_email_delivery(
  p_invitation_id uuid,
  p_actor_user_id uuid,
  p_attempt_type text,
  p_outcome text,
  p_provider text,
  p_provider_message_id text default null,
  p_error_class text default null,
  p_duration_ms integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_action text;
begin
  if p_attempt_type not in ('create', 'resend') then
    raise exception 'invalid_attempt_type';
  end if;
  if p_outcome not in ('sent', 'failed') then
    raise exception 'invalid_outcome';
  end if;

  select team_invitations.tenant_id into v_tenant_id
  from public.team_invitations
  where team_invitations.id = p_invitation_id;

  if v_tenant_id is null then
    raise exception 'invitation_not_found';
  end if;

  if not exists (
    select 1 from public.tenant_memberships
    where tenant_memberships.tenant_id = v_tenant_id
      and tenant_memberships.user_id = p_actor_user_id
      and tenant_memberships.status = 'active'
      and tenant_memberships.deleted_at is null
  ) then
    raise exception 'actor_not_authorized';
  end if;

  v_action := case when p_outcome = 'sent' then 'team_invitation.email_sent' else 'team_invitation.email_send_failed' end;

  -- Never the recipient email, raw token, token hash, acceptUrl, email
  -- body/subject, or any provider secret — only opaque, already-safe
  -- identifiers and the provider's own classification.
  insert into public.audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, before, after)
  values (
    v_tenant_id,
    p_actor_user_id,
    'user',
    v_action,
    'team_invitation',
    p_invitation_id,
    null,
    jsonb_build_object(
      'attempt_type', p_attempt_type,
      'provider', p_provider,
      'provider_message_id', p_provider_message_id,
      'outcome', p_outcome,
      'duration_ms', p_duration_ms,
      'error_class', p_error_class
    )
  );
end;
$$;

create function public.log_team_invitation_email_delivery(
  p_invitation_id uuid,
  p_actor_user_id uuid,
  p_attempt_type text,
  p_outcome text,
  p_provider text,
  p_provider_message_id text default null,
  p_error_class text default null,
  p_duration_ms integer default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.log_team_invitation_email_delivery(
    p_invitation_id, p_actor_user_id, p_attempt_type, p_outcome, p_provider,
    p_provider_message_id, p_error_class, p_duration_ms
  );
$$;

revoke execute on function private.log_team_invitation_email_delivery(uuid, uuid, text, text, text, text, text, integer) from public;
revoke execute on function public.log_team_invitation_email_delivery(uuid, uuid, text, text, text, text, text, integer) from public;
revoke execute on function public.log_team_invitation_email_delivery(uuid, uuid, text, text, text, text, text, integer) from anon;
revoke execute on function public.log_team_invitation_email_delivery(uuid, uuid, text, text, text, text, text, integer) from authenticated;
grant execute on function public.log_team_invitation_email_delivery(uuid, uuid, text, text, text, text, text, integer) to service_role;
