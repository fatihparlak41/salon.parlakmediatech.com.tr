-- Faz LAUNCH.1A (2 of 3) — who may be sent a password-recovery e-mail.
--
-- WHY
-- SalonOS has two authorization domains on ONE Supabase Auth user pool (see
-- lib/auth/session.ts, requireAccountUser): salon staff sign in with an e-mail
-- and a PASSWORD; customers use a passwordless magic link and have no password.
-- A "forgot password" flow that mails a recovery link to any confirmed address
-- would let a customer-only account acquire a FIRST password through the staff
-- surface — turning the customer recovery path (a new magic link) into a staff
-- credential. Password recovery is therefore offered only to accounts that
-- already HAVE a password.
--
-- WHAT THIS ADDS
-- public.password_recovery_allowed(email) -> boolean, EXECUTE for service_role
-- ONLY. It is called by the forgot-password Server Action with the service-role
-- client, never from a browser: granting it to anon/authenticated would make it
-- an account-existence oracle. The action's response is identical whether the
-- function returns true or false.
--
-- ROLLBACK: drop both functions.

create or replace function private.password_recovery_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    where u.email = private.normalize_email(p_email)
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and coalesce(u.encrypted_password, '') <> ''
  );
$$;

comment on function private.password_recovery_allowed(text) is
  'Faz LAUNCH.1A. True only for a confirmed, non-deleted account that has a password. Passwordless (customer magic-link) accounts are never eligible.';

create or replace function public.password_recovery_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.password_recovery_allowed(p_email);
$$;

comment on function public.password_recovery_allowed(text) is
  'Faz LAUNCH.1A. service_role only — never callable by anon or authenticated (it would reveal which addresses have an account).';

revoke execute on function private.password_recovery_allowed(text) from public;
revoke execute on function public.password_recovery_allowed(text) from public, anon, authenticated;
grant execute on function public.password_recovery_allowed(text) to service_role;
