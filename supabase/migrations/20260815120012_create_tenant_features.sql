create table public.tenant_features (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  feature_id uuid not null references public.features (id),
  enabled boolean not null,
  note text,
  granted_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, feature_id)
);

comment on table public.tenant_features is
  'Per-tenant feature override, independent of plan. private.has_feature() checks this first, falls back to the tenant''s plan_features.';

create trigger set_updated_at
  before update on public.tenant_features
  for each row execute function public.set_updated_at();

alter table public.tenant_features enable row level security;
-- Policy added in 20260815120017_rls_policies_platform.sql.

grant select on public.tenant_features to authenticated;
-- No write grant: platform_admin-only (super admin toggles a feature for a
-- specific tenant), enforced via the later policy.
