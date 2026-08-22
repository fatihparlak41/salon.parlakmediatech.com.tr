-- Faz 2F.2 — the approved gateway architecture (Next.js server -> Turnstile
-- verification -> this role -> public.create_guest_booking) needs a
-- dedicated, least-privilege Postgres role distinct from service_role.
-- service_role stays at zero table DML / zero function EXECUTE, exactly as
-- it has since 20260817104813 — this migration does not touch it at all.
--
-- Security properties, explicit per role attribute (all defaults actually
-- ARE the safe value in Postgres, but every one is spelled out anyway so
-- nothing here depends on a reader already knowing Postgres's defaults):
--   NOSUPERUSER    — never bypasses any permission check
--   NOCREATEDB     — cannot create databases
--   NOCREATEROLE   — cannot create/alter other roles (including granting
--                    itself more access later)
--   NOREPLICATION  — cannot open a replication connection
--   NOBYPASSRLS    — explicit even though this role never touches a table
--                    directly (create_guest_booking does all table access
--                    as its own SECURITY DEFINER owner) — never let RLS
--                    bypass be assumed safe just because a caller doesn't
--                    currently need it
--   NOINHERIT      — this role belongs to no groups today; NOINHERIT
--                    documents that intent explicitly rather than leaving
--                    it to Postgres's default (which happens to already be
--                    INHERIT) — a future membership grant that forgets to
--                    also reconsider inheritance is exactly the kind of
--                    silent-widening this project's whole grant philosophy
--                    exists to prevent
--   LOGIN          — required for the role to authenticate at all; not
--                    itself a secret (visible in pg_roles.rolcanlogin),
--                    unlike the password below
--
-- Deliberately NOT set here: a password. "Do not place a role password in
-- a migration" — migrations are committed to git and applied to both DEV
-- and PROD from the same file; a password baked into one would either be
-- a real secret sitting in version control, or a placeholder someone
-- forgets to change before PROD. The role exists after this migration but
-- cannot yet authenticate (no valid password) until a separate, manual,
-- environment-specific step:
--
--   ALTER ROLE booking_gateway WITH PASSWORD '<random, generated per
--   environment, never committed, never pasted into chat/logs>';
--
-- run directly against each environment's database (DEV: run once here,
-- via a throwaway script that generates the password and writes only the
-- resulting connection URL to .env.local, never printing the password
-- itself — see the Phase 2F.2 report. PROD: the same ALTER ROLE statement,
-- run by whoever administers the PROD project, storing the resulting
-- connection string only as a Vercel Production-environment server-only
-- variable — never performed by this session, since PROD is out of scope
-- for this phase).
--
-- No explicit "GRANT USAGE ON SCHEMA public" below: verified first (see
-- Phase 2F.2 report) that PUBLIC already has USAGE on the public schema —
-- pg_namespace.nspacl shows "=U" for public, a pre-existing, never-revoked
-- Postgres default this project has left alone since Faz 1 (harmless on
-- its own: schema USAGE only permits *naming* objects in it, every object
-- inside is separately ACL'd). booking_gateway inherits that like every
-- other role automatically; adding a redundant explicit grant would imply
-- it was otherwise missing, which it isn't. The `private` schema has no
-- such default (`postgres=UC` only) and stays exactly that way here.
create role booking_gateway with
  login
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls
  noinherit;

comment on role booking_gateway is
  'Faz 2F.2 public-booking gateway: direct Postgres connection used only by the Next.js server-side booking gateway (never the browser). EXECUTE on public.create_guest_booking only — see 20260822170000/20260822170500. Password set manually per environment, never in a migration.';

grant execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid) to booking_gateway;

-- =====================================================================
-- Remove the direct-browser bypass: anon/authenticated could call
-- create_guest_booking straight from the browser through Phase 2F.1 —
-- that is exactly what makes a React-only CAPTCHA bypassable (Phase
-- 2F.1's own threat G). The gateway above is now the only path; PUBLIC
-- already has zero execute here (verified clean by the standing
-- security-grants-regression suite through Phase 2F.1), re-asserted
-- anyway per this project's own per-object-revoke convention.
-- =====================================================================
revoke execute on function public.create_guest_booking(text, uuid, uuid, timestamptz, text, text, uuid, text, uuid) from anon, authenticated, public;
