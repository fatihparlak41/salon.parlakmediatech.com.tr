create table public.plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  price_monthly numeric(10, 2),
  price_yearly numeric(10, 2),
  currency text not null default 'TRY',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.plans is
  'Prices intentionally NULL — pricing has not been decided yet. Rows exist so plan_features / has_feature() are testable.';

create table public.features (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  category text,
  created_at timestamptz not null default now()
);

create table public.plan_features (
  plan_id uuid not null references public.plans (id) on delete cascade,
  feature_id uuid not null references public.features (id) on delete cascade,
  limit_value integer,
  config jsonb,
  primary key (plan_id, feature_id)
);

create trigger set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

alter table public.plans enable row level security;
alter table public.features enable row level security;
alter table public.plan_features enable row level security;
-- Read policies added in 20260815120015_rls_policies_catalog.sql, write
-- (platform_admin-only) policies in 20260815120017_rls_policies_platform.sql.

grant select on public.plans to authenticated;
grant select on public.features to authenticated;
grant select on public.plan_features to authenticated;
grant insert, update on public.plans to authenticated;
grant insert, update on public.features to authenticated;
grant insert, delete on public.plan_features to authenticated;

insert into public.plans (key, name, sort_order) values
  ('starter', 'Starter', 1),
  ('professional', 'Professional', 2),
  ('business', 'Business', 3)
on conflict (key) do update set name = excluded.name, sort_order = excluded.sort_order;

insert into public.features (key, name, category) values
  ('online_booking', 'Online Rezervasyon', 'booking'),
  ('inventory', 'Stok Yönetimi', 'operations'),
  ('color_formulas', 'Boya Formülleri', 'operations'),
  ('finance', 'Finans', 'finance'),
  ('commission', 'Personel Primleri', 'finance'),
  ('whatsapp', 'WhatsApp Otomasyonu', 'marketing'),
  ('loyalty', 'Sadakat Programı', 'marketing'),
  ('packages', 'Paketler', 'marketing'),
  ('memberships', 'Üyelikler', 'marketing'),
  ('multi_branch', 'Çoklu Şube', 'operations'),
  ('advanced_reports', 'Gelişmiş Raporlar', 'reports')
on conflict (key) do update set name = excluded.name, category = excluded.category;

-- Starting tiering — adjustable later via tenant_features overrides or by
-- editing plan_features directly, without any code change.
insert into public.plan_features (plan_id, feature_id)
select p.id, f.id
from public.plans p
cross join public.features f
where (p.key = 'professional' and f.key in ('online_booking', 'inventory', 'finance', 'commission'))
   or (p.key = 'business')
on conflict do nothing;
