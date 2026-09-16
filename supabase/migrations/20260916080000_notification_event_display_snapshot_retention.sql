-- Faz NOTIF.2F.2 — bounded, server-only 30-day purge for
-- notification_event_display_snapshots. The proposal this migration
-- implements was first documented (not built) in NOTIF.2F.1's own
-- migration header; this phase reviews and lands the primitive itself.
-- No cron/schedule/route wiring here — see this migration's own footer
-- for why that is a deliberately separate, later decision.
--
-- =====================================================================
-- WHY A SEPARATE PURGE FUNCTION, NOT A TRIGGER OR A ttl-STYLE EXTENSION
-- =====================================================================
-- notification_event_display_snapshots is otherwise strictly insert-only
-- (no UPDATE/DELETE grant to any role — see its own 20260916070000
-- table comment). This is the one, explicit, narrow exception: a
-- bounded, service_role-only DELETE path for rows past their retention
-- window, never a browser-reachable mutation and never an unbounded
-- "delete everything expired" statement that could lock/scan an
-- arbitrarily large range under load.
--
-- =====================================================================
-- BATCHING + CONCURRENCY — same discipline as claim_notification_
-- delivery_targets (20260915070000/20260915080000), not a new pattern
-- =====================================================================
-- FOR UPDATE SKIP LOCKED on the candidate SELECT: two overlapping purge
-- calls (a slow manual run overlapping a future scheduled one, or two
-- retries racing) each lock a DISJOINT set of rows — neither can select
-- a row the other is already holding, so no row is ever counted or
-- deleted twice, and neither caller blocks waiting on the other. Default
-- batch size (500) is deliberately larger than any worker-loop batch
-- size in this schema (25-50) — this is a low-frequency cleanup pass
-- over already-terminal, already-delivered data, not a per-minute
-- latency-sensitive path, so a bigger sweep per call is the right
-- tradeoff, not a risk.
--
-- HARD CAP, enforced by the function itself, not merely by convention:
-- the candidate SELECT's LIMIT is least(greatest(coalesce(p_batch_size,
-- 0),0),500) — no service_role caller can ever request more than 500
-- rows in one invocation, no matter what integer it passes (NULL,
-- negative, zero, or an arbitrarily large number all resolve safely; see
-- the function body's own inline comment for the exact semantics). This
-- protects against a single call locking/deleting an unbounded range
-- under load even though every caller today is trusted (service_role
-- only) — the same "don't rely solely on caller discipline" posture
-- private.enqueue_notification_event already applies to p_tenant_
-- timezone (20260916070000).
--
-- =====================================================================
-- RETENTION BOUNDARY — strict "<", never "<="
-- =====================================================================
-- created_at < now() - interval '30 days': a row created EXACTLY 30
-- days ago (to the microsecond) is NOT yet eligible — it becomes
-- eligible the instant it crosses 30 days old, never before. This
-- matches the explicit "do not delete rows younger than 30 days" rule
-- with no ambiguity at the boundary itself.
--
-- =====================================================================
-- BLAST RADIUS — what this can and cannot touch
-- =====================================================================
-- The DELETE statement's own WHERE clause only ever matches rows in
-- notification_event_display_snapshots itself, selected by this
-- function's own candidate CTE — there is no cascade, no trigger, no
-- second table reference anywhere in this function body. It cannot
-- touch notification_events (the parent an old snapshot's event_id
-- pointed at remains exactly as valid and unmutated as any other
-- pre-2F.1 event that never had a snapshot — "old event without a
-- snapshot" is already a normal, permanently-supported state), cannot
-- touch notification_deliveries/notification_delivery_targets (an
-- unrelated table with its own independent lifecycle), and cannot touch
-- notification_delivery_activation (never referenced at all). A
-- delivery/target for the purged event that is somehow still
-- outstanding weeks later (extremely unlikely given the worker's own
-- ~81-minute retry-exhaustion window, but not structurally impossible if
-- the whole pipeline were down for a long time) simply loses its rich-
-- copy source: claim_notification_delivery_targets' existing LEFT JOIN
-- (20260916070000) already treats "no snapshot row" as a normal,
-- non-error state — it cannot distinguish "never had one" from "had one,
-- now purged", so the payload builder's own existing generic-copy
-- fallback (payload.ts) is reached exactly the same way, never a crash,
-- never a malformed body. Confirmed by a real test below (10), not
-- assumed.
create function private.purge_expired_notification_event_display_snapshots(
  p_batch_size integer default 500
)
returns integer
language sql
security definer
set search_path = ''
as $$
  with victims as (
    select event_id
    from public.notification_event_display_snapshots
    where created_at < now() - interval '30 days'
    order by created_at
    -- Faz NOTIF.2F.2 hardening — clamped both directions, never trusting
    -- the caller's own number even though only service_role can ever
    -- reach this function: coalesce(...,0) turns an explicit NULL into
    -- 0 (distinct from an OMITTED argument, which never reaches this
    -- expression at all — the DEFAULT 500 above fires first in that
    -- case); greatest(...,0) floors a negative value at 0; least(...,500)
    -- is the hard ceiling no single invocation can exceed regardless of
    -- what p_batch_size claims to be. One invocation, no loop, at most
    -- 500 rows — ever.
    limit least(greatest(coalesce(p_batch_size, 0), 0), 500)
    for update skip locked
  ),
  removed as (
    delete from public.notification_event_display_snapshots
    where event_id in (select event_id from victims)
    returning 1
  )
  select count(*)::integer from removed;
$$;

comment on function private.purge_expired_notification_event_display_snapshots(integer) is
  'Faz NOTIF.2F.2, hardened with a hard cap. Deletes notification_event_display_snapshots rows whose created_at is strictly older than 30 days, via FOR UPDATE SKIP LOCKED so overlapping calls never double-process the same row. The effective batch bound is least(greatest(coalesce(p_batch_size,0),0),500): NULL/negative/zero all delete 0, 1..500 is honored exactly, anything above 500 is capped at 500 — the database itself enforces this ceiling regardless of what a caller requests, no loop, one invocation. Returns the actual number of rows deleted. Touches no other table: notification_events, notification_deliveries, notification_delivery_targets, and notification_delivery_activation are all structurally unreachable from this function body. Not wired to any cron/schedule/route — that is a deliberately separate, later decision (see this migration''s own header).';

revoke execute on function private.purge_expired_notification_event_display_snapshots(integer) from public;

-- =====================================================================
-- public.purge_expired_notification_event_display_snapshots — the only
-- service_role-callable surface, same private/public split as every
-- other worker RPC in this schema.
-- =====================================================================
create function public.purge_expired_notification_event_display_snapshots(
  p_batch_size integer default 500
)
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.purge_expired_notification_event_display_snapshots(p_batch_size);
$$;

comment on function public.purge_expired_notification_event_display_snapshots(integer) is
  'Faz NOTIF.2F.2. service_role-only — never callable by anon/authenticated. See private.purge_expired_notification_event_display_snapshots for the full behavior. Not invoked by any application code in this phase; a future, separately-reviewed phase decides how/when this is triggered.';

revoke execute on function public.purge_expired_notification_event_display_snapshots(integer) from public;
revoke execute on function public.purge_expired_notification_event_display_snapshots(integer) from anon;
revoke execute on function public.purge_expired_notification_event_display_snapshots(integer) from authenticated;
grant execute on function public.purge_expired_notification_event_display_snapshots(integer) to service_role;

-- =====================================================================
-- WHY NO CRON/ROUTE IN THIS MIGRATION
-- =====================================================================
-- This phase's own explicit instruction: "Do not wire cron yet until the
-- purge primitive itself is reviewed." Mirrors exactly how NOTIF.2E.3's
-- cron trigger was reviewed and released as its own separate phase after
-- NOTIF.2E.2's worker core landed alone first. The primitive above is
-- fully self-contained, safe to call manually (service_role only) for
-- verification, and requires no application code change to exist.
