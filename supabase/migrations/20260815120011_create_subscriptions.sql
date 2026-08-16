create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants (id),
  plan_id uuid not null references public.plans (id),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscriptions is
  'One row per tenant (current state). provider/provider_*_id reserved for a future payment gateway (Stripe/iyzico/Paytr — not decided) and stay null until then. Change history lives in audit_logs, not a separate table.';

create trigger set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;
-- Policy added in 20260815120017_rls_policies_platform.sql.

grant select on public.subscriptions to authenticated;
-- No write grant: subscription changes are platform_admin-only for now
-- (self-serve plan changes are a future, payment-integration-dependent
-- feature) — writes happen via service_role or a future dedicated RPC.
