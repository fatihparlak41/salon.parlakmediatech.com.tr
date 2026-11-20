-- Faz SAAS.1C.2c-A2 (2/3) - enforcement hooks in the registered tenant business writers.
--
-- For every registry row that is `hooked` (kind = function) ONE marked line is injected at the very start of the LIVE definition of the public API
-- function (read with pg_get_functiondef, so the body that is live is the body that is patched):
--   LANGUAGE sql      ->  select private.billing_guard('fn:<name>', '<scope>', <id argument>);            -- a2-billing-hook
--   LANGUAGE plpgsql  ->  perform private.billing_guard('fn:<name>', '<scope>', <id argument>);           -- a2-billing-hook   (after the first `begin`)
-- The action key is a literal written by this migration (never taken from the client), the tenant is resolved inside the guard from the id / key
-- argument, and nothing else in any function body changes: the migration proves that removing the marked line gives back the exact previous
-- definition (replace(new, line, '') = old), that the function keeps its signature and that exactly one overload exists.
-- At stage 0 the guard returns after one singleton read, so the hooked functions behave exactly as before.
--
-- It also adds ONE marked condition to private.resolve_bookable_tenant (used by the public availability and eligible-staff reads) so the public
-- booking pages answer "not bookable" when the public-booking policy refuses (stage >= 2); at stages 0 and 1 the added condition is always true.
-- create_guest_booking itself (the authoritative write point) is hooked like every other registered writer.
--
-- ROLLBACK: rollback-saas-1c-2c-a2.sql removes every `-- a2-billing-hook` line the same way (restoring the exact A1 definitions).

do $a2$
declare
  r record;
  v_oid oid;
  v_lang text;
  v_args text;
  v_def text;
  v_new text;
  v_back text;
  v_call text;
  v_stmt text;
  v_anchor text;
  v_pos integer;
  v_hooked integer := 0;
  c_marker constant text := '-- a2-billing-hook';
begin
  for r in select g.action_key, substr(g.action_key, 4) as fname, g.scope, g.scope_arg
             from private.billing_action_registry g where g.kind = 'function' and g.hooked order by g.action_key loop
    if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fname) <> 1 then
      raise exception 'A2 hook: % is missing or overloaded', r.fname;
    end if;
    select p.oid, l.lanname, pg_get_function_identity_arguments(p.oid) into v_oid, v_lang, v_args
      from pg_proc p join pg_language l on l.oid = p.prolang where p.pronamespace = 'public'::regnamespace and p.proname = r.fname;
    if position(', ' || r.scope_arg || ' ' in ', ' || v_args) = 0 then
      raise exception 'A2 hook: % has no argument %', r.fname, r.scope_arg;
    end if;
    v_def := pg_get_functiondef(v_oid);
    if position(c_marker in v_def) > 0 then
      raise exception 'A2 hook: % is already hooked', r.fname;
    end if;

    if r.scope in ('slug', 'invitation_token') then
      v_call := format('private.billing_guard(%L, %L, null, %s)', r.action_key, r.scope, r.scope_arg);
    else
      v_call := format('private.billing_guard(%L, %L, %s)', r.action_key, r.scope, r.scope_arg);
    end if;
    if v_lang = 'sql' then
      -- the body starts on the next line (most functions) or right after the opening quote (a few one-line bodies): either way the injected text is the
      -- same single line `  select ...; -- a2-billing-hook` + newline inserted after the opening quote (and its newline / space), so removing exactly that line restores the original
      v_anchor := case when position('AS $function$' || chr(10) in v_def) > 0 then 'AS $function$' || chr(10) else 'AS $function$ ' end;
      v_stmt := '  select ' || v_call || '; ' || c_marker || chr(10);
    elsif v_lang = 'plpgsql' then
      v_anchor := chr(10) || 'begin' || chr(10);
      v_stmt := '  perform ' || v_call || '; ' || c_marker || chr(10);
    else
      raise exception 'A2 hook: % has unsupported language %', r.fname, v_lang;
    end if;
    v_pos := position(v_anchor in v_def);
    if v_pos = 0 or v_pos < position('AS $function$' in v_def) then
      raise exception 'A2 hook: no insertion point in %', r.fname;
    end if;
    v_new := substr(v_def, 1, v_pos - 1 + length(v_anchor)) || v_stmt || substr(v_def, v_pos + length(v_anchor));
    execute v_new;

    -- proof: same single overload, same arguments, and removing the injected line gives back the previous definition byte for byte
    if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fname) <> 1 then
      raise exception 'A2 hook: % changed its overload set', r.fname;
    end if;
    select pg_get_functiondef(p.oid) into v_back from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fname;
    if v_back is distinct from v_new or replace(v_back, v_stmt, '') is distinct from v_def then
      raise exception 'A2 hook: % is not the previous definition plus exactly one hook line', r.fname;
    end if;
    v_hooked := v_hooked + 1;
  end loop;
  if v_hooked <> (select count(*) from private.billing_action_registry g where g.kind = 'function' and g.hooked) or v_hooked <> 32 then
    raise exception 'A2 hook: expected 32 hooked functions, hooked %', v_hooked;
  end if;

  -- read-side public booking gate: one marked condition in the shared resolver (the line BEFORE the feature check keeps the statement terminator on code)
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = 'resolve_bookable_tenant';
  v_anchor := '    and private.has_feature(t.id, ''online_booking'')';
  if v_def is null or (length(v_def) - length(replace(v_def, v_anchor, ''))) <> length(v_anchor) or position(c_marker in v_def) > 0 then
    raise exception 'A2 hook: private.resolve_bookable_tenant does not have the expected single feature condition';
  end if;
  v_stmt := '    and private.billing_public_booking_open(t.id) ' || c_marker || chr(10);
  v_new := replace(v_def, v_anchor, v_stmt || v_anchor);
  execute v_new;
  select pg_get_functiondef(p.oid) into v_back from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = 'resolve_bookable_tenant';
  if v_back is distinct from v_new or replace(v_back, v_stmt, '') is distinct from v_def then
    raise exception 'A2 hook: resolve_bookable_tenant is not the previous definition plus exactly one condition';
  end if;

  if exists (select 1 from private.billing_hook_coverage() c where c.action_key like 'fn:%' or c.action_key like 'read:%') then
    raise exception 'A2 hook: function hook coverage is not complete';
  end if;
end
$a2$;
