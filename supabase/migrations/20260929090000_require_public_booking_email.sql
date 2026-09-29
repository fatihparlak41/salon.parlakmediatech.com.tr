-- Faz NOTIF.1B (part 1 of 1) — every PUBLIC guest booking now requires a
-- real, single, well-formed email address. Depends on
-- 20260928100100_customer_confirmation_email_wiring.sql (NOTIF.1A).
--
-- =====================================================================
-- WHY THIS LIVES IN public.create_guest_booking, NOT THE PRIVATE ONE
-- =====================================================================
--
-- private.create_guest_booking is ~300 lines, redefined a dozen times,
-- and already treats p_customer_email as optional in its own contact
-- check (only validating it when present). Rewriting that function to
-- make email mandatory would touch a lot of proven surface for no
-- functional gain, because booking_gateway's public mutation surface —
-- this one function — is the authoritative, unbypassable public booking
-- DB boundary: anon/authenticated have had NO execute on
-- create_guest_booking at all since 20260822170000, and
-- private.create_guest_booking itself has never been granted to any
-- application role, ever (only ever called internally, by this
-- wrapper). A caller that cannot reach this wrapper cannot reach the
-- private function either — there is no second door. So a guard here is
-- exactly as authoritative as one buried inside the private function
-- would be, without touching it at all.
--
-- The wrapper was LANGUAGE SQL (a single pass-through SELECT), which
-- cannot RAISE. It becomes LANGUAGE PLPGSQL here so it can reject
-- before ever calling into the private function — signature, SECURITY
-- DEFINER, search_path, ACL and the NOTIF.1A capture-hook delegation
-- are otherwise byte-for-byte what NOTIF.1A left them.
--
-- Missing/blank/malformed/list-shaped email fails with the SAME BK006
-- ("invalid contact details") the private function already uses for a
-- bad name/phone — a caller sees one generic contact-details error
-- class, never a new, more specific, information-leaking code.
--
-- public.customers.email stays nullable (unchanged, no new constraint):
-- an internal/manually-created salon customer may still legitimately
-- have none. This requirement is scoped to the public guest booking
-- mutation path alone.
--
-- =====================================================================
-- KNOWN, ACCEPTED CONSEQUENCE FOR NOTIF.1A's no_recipient SKIP REASON
-- =====================================================================
--
-- Before this migration, "no_recipient" was mostly reached by a real
-- public booking that simply omitted an email. After this migration
-- that specific path is closed (the booking itself is rejected
-- instead) — but the skip reason itself is untouched and still
-- reachable exactly as NOTIF.1A built it: the booking-time capture
-- (private.capture_booking_contact_from_confirmation) still swallows
-- its own failures via its own EXCEPTION block (a constraint, a bug, a
-- transient error), and the enqueue trigger still records
-- skipped/no_recipient whenever no snapshot exists at confirm time,
-- regardless of why. Neither of those two functions, the jobs table,
-- the trigger, the activation table, the cron schedule, or the SMTP
-- transport is touched by this migration.

begin;

-- =====================================================================
-- 1. The one new object: a small, named, testable "is this good enough
--    to require" predicate. Reuses private.is_deliverable_email_shape
--    (the same shape check NOTIF.1A's capture step already applies)
--    rather than inventing a second definition of "looks like an
--    email", and adds only what that check does not already cover: a
--    recipient-list shape (comma/semicolon) and control characters.
-- =====================================================================
create or replace function private.is_public_booking_email_valid(p_email text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select
    p_email is not null
    and char_length(btrim(p_email)) > 0
    and btrim(p_email) !~ '[[:cntrl:]]'
    and position(',' in btrim(p_email)) = 0
    and position(';' in btrim(p_email)) = 0
    and private.is_deliverable_email_shape(btrim(p_email));
$$;

comment on function private.is_public_booking_email_valid(text) is
  'Faz NOTIF.1B. True iff p_email is present, a single well-formed address, safe to REQUIRE for a public guest booking: non-empty after trim, no control characters, no comma/semicolon (rejects a recipient-list-shaped value), and passes the same private.is_deliverable_email_shape() shape check the NOTIF.1A capture step already uses. Deliberately stricter than that capture step alone (which tolerates absence) because this function GATES the booking itself, not just an opportunistic snapshot.';

revoke execute on function private.is_public_booking_email_valid(text) from public;

-- =====================================================================
-- 2. DRIFT GUARD. The next statement REPLACES the public wrapper's
--    body and LANGUAGE, and this project has been bitten before by a
--    production function whose text differed from the repository's
--    (see supabase/migrations/README.md). Refuse to overwrite anything
--    but the exact NOTIF.1A-wired plain-SQL pass-through this migration
--    was written against (whitespace-insensitive), or a wrapper that is
--    already this migration's own version (a re-run). If production's
--    wrapper is anything else, this raises, the transaction rolls back,
--    and nothing changes.
-- =====================================================================
do $$
declare
  v_lang text;
  v_body text;
begin
  select l.lanname, regexp_replace(p.prosrc, '\s+', '', 'g')
  into v_lang, v_body
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  where p.oid = 'public.create_guest_booking(text,uuid,uuid,timestamptz,text,text,uuid,text,uuid,uuid,text)'::regprocedure;

  if v_body is null then
    raise exception 'public.create_guest_booking is missing';
  end if;

  -- Already this migration's own version — a re-run, fine, leave it.
  if v_lang = 'plpgsql' and v_body like '%is_public_booking_email_valid%' then
    return;
  end if;

  if v_lang <> 'sql'
     or v_body <> 'selectprivate.capture_booking_contact_from_confirmation(private.create_guest_booking(p_tenant_slug,p_branch_id,p_service_id,p_scheduled_start_at,p_customer_full_name,p_customer_phone,p_staff_member_id,p_customer_email,p_idempotency_key,p_customer_account_user_id,p_claim_secret_hash),p_customer_email,p_customer_full_name);'
  then
    raise exception 'public.create_guest_booking is not the expected NOTIF.1A-wired wrapper (production drift?) - refusing to replace it';
  end if;
end
$$;

-- =====================================================================
-- 3. The public wrapper: identical signature, SECURITY DEFINER,
--    search_path and ACL (booking_gateway only) as before; LANGUAGE
--    changes from sql to plpgsql (a plain SELECT cannot RAISE) solely
--    so it can reject before delegating.
-- =====================================================================
create or replace function public.create_guest_booking(
  p_tenant_slug text,
  p_branch_id uuid,
  p_service_id uuid,
  p_scheduled_start_at timestamptz,
  p_customer_full_name text,
  p_customer_phone text,
  p_staff_member_id uuid default null,
  p_customer_email text default null,
  p_idempotency_key uuid default null,
  p_customer_account_user_id uuid default null,
  p_claim_secret_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_public_booking_email_valid(p_customer_email) then
    raise exception 'invalid contact details' using errcode = 'BK006';
  end if;

  return private.capture_booking_contact_from_confirmation(
    private.create_guest_booking(
      p_tenant_slug, p_branch_id, p_service_id, p_scheduled_start_at,
      p_customer_full_name, p_customer_phone, p_staff_member_id, p_customer_email, p_idempotency_key,
      p_customer_account_user_id, p_claim_secret_hash
    ),
    p_customer_email,
    p_customer_full_name
  );
end;
$$;

comment on function public.create_guest_booking(text,uuid,uuid,timestamptz,text,text,uuid,text,uuid,uuid,text) is
  'Faz 2F.2/NOTIF.1A/NOTIF.1B. The sole public entry point for guest booking (booking_gateway EXECUTE only). Requires a present, single, well-formed p_customer_email (BK006 otherwise, same class as a bad name/phone) before delegating to private.create_guest_booking, then routes the result through private.capture_booking_contact_from_confirmation for the NOTIF.1A confirmation-email snapshot.';

commit;
