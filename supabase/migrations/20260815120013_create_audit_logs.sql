create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id),
  actor_user_id uuid references auth.users (id),
  actor_type text not null check (actor_type in ('user', 'platform_admin', 'system')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

comment on table public.audit_logs is
  'Append-only. tenant_id null = platform-level event. No updated_at/deleted_at on purpose — corrections are new rows, never edits. Insert only via private.log_audit_event() (20260815120014), never a direct client insert, so actor_user_id cannot be spoofed.';

create index audit_logs_tenant_id_idx on public.audit_logs (tenant_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

alter table public.audit_logs enable row level security;
-- Policy added in 20260815120017_rls_policies_platform.sql.

grant select on public.audit_logs to authenticated;
-- Deliberately no insert/update/delete grant for authenticated: writes only
-- happen through private.log_audit_event(), which is SECURITY DEFINER.
