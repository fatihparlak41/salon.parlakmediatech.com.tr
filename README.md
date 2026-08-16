# SalonOS

Çok kiracılı (multi-tenant) SaaS platformu — kadın kuaförleri ve güzellik
salonları için abonelik modeliyle satılacak operasyon paneli. Parlak
Mediatech bünyesinde geliştiriliyor, `salon.parlakmediatech.com.tr` altında
yayınlanacak.

Bu repo diğer Parlak Mediatech projelerinden tamamen bağımsızdır — ayrı
Vercel projesi, ayrı Supabase projesi.

## Durum: Faz 1 tamam — Multi-Tenant + Auth + RLS + RBAC + Super Admin

Tenant foundation, kimlik doğrulama, temel salon oluşturma akışı, RBAC,
RLS, süper admin paneli ve zorunlu cross-tenant izolasyon testleri
tamamlandı ve canlı DEV veritabanına karşı doğrulandı. **Randevu, müşteri
CRM, finans, stok, boya formülleri, pazarlama gibi iş modülleri henüz yok**
— bunlar Faz 2+'a bırakıldı. Ayrıntılı mimari kararlar için onaylanmış
mimari rapora bakın (proje kanalında paylaşıldı).

## Teknoloji

- **Next.js 16** (App Router, Turbopack varsayılan) + **React 19**
- **TypeScript** (strict + `noUncheckedIndexedAccess` vb. sıkılaştırmalar)
- **Tailwind CSS v4** (CSS-first config, `tailwind.config.ts` yok)
- **shadcn/ui** ("base-nova" preset — **Base UI** primitifleri, Radix değil;
  bileşenleri `asChild` değil `render` prop ile kompoze edin)
- **next-intl** (i18n, bkz. aşağıda)
- **Supabase** (Auth, Postgres + RLS, Storage) — `@supabase/ssr`
- **Vitest** (cross-tenant izolasyon test suite, canlı DEV projesine karşı)
- **pnpm**

> Next.js 16 önceki sürümlerden farklı: Middleware artık **Proxy**
> (`proxy.ts`, `middleware.ts` değil), `params`/`searchParams` her yerde
> async. Kod yazmadan önce `node_modules/next/dist/docs/` içindeki
> (sürüme özel, bundled) dokümantasyona bakın — bkz. `AGENTS.md`.

## Başlarken

Gereksinimler: Node.js 20.9+ (bu makinede test edildi: Node 22, pnpm 9),
Git. Supabase CLI ve Docker **opsiyonel** — yoksa `npx supabase@latest ...`
üzerinden çalışılır, local Supabase stack'i olmadan da geliştirme
sürdürülebilir (bkz. "Supabase" bölümü).

```bash
pnpm install
cp .env.example .env.local   # değerleri doldurun, bkz. aşağıda
pnpm dev
```

`http://localhost:3000` — oturum açık değilse giriş/kayıt bağlantıları,
açıksa salonlarınız + (platform admin iseniz) süper admin bağlantısı
gösterilir.

### Diğer komutlar

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint .
pnpm format           # prettier --write .
pnpm build            # next build
pnpm test             # vitest run — cross-tenant izolasyon testleri (canlı DEV DB)

pnpm db:start         # local Supabase (Docker gerekir)
pnpm db:login         # npx supabase login (bir kere, tarayıcı açar)
pnpm db:link          # bu repoyu DEV projesine bağla (DB şifresi ister)
pnpm db:push          # migration'ları DEV projesine uygula
pnpm db:reset         # local: migration'ları + seed.sql'i yeniden uygula
pnpm db:migration:new <isim>
pnpm db:types         # lib/supabase/database.types.ts üret (--linked)
```

## Environment değişkenleri

`.env.example` → `.env.local`. Ayrıntılı açıklamalar dosyanın içinde;
özetle:

| Değişken                               | Nereden                                     | Not                                                                                                                     |
| -------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | `npx supabase status` ya da dashboard → API | Client'a açık, güvenlik RLS'ye dayanır                                                                                  |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | aynı                                        | Client'a açık (Supabase'in yeni `sb_publishable_...` key formatı)                                                       |
| `SUPABASE_SERVICE_ROLE_KEY`            | dashboard → API (server ortamı)             | **Asla commit etmeyin / client'a sızdırmayın** — sadece `lib/supabase/admin.ts` ve test suite fixture kurulumu kullanır |
| `NEXT_PUBLIC_SITE_URL`                 | —                                           | Local: `http://localhost:3000`                                                                                          |

Production secret'ları repository'ye değil, Vercel proje ayarlarına girilir.

## Supabase

Migration tabanlı geliştirme: şema değişiklikleri `supabase/migrations/*.sql`
içinde, git'te versiyonlanır — dashboard'dan elle şema değişikliği yapılmaz.
20 migration canlı **DEV** projesinde uygulanmış durumda (tenants, RBAC,
RLS politikaları, yardımcı fonksiyonlar, onboarding — bkz.
`supabase/migrations/README.md`).

Bu makinede Docker kurulu değil; Supabase CLI `npx supabase@latest` ile
kullanılıyor (`pnpm db:*` script'leri buna göre). Docker mevcutsa
`pnpm db:start` ile tam local stack (Postgres + Auth + Storage + Studio)
ayağa kalkar — zorunlu değil, migration'lar doğrudan DEV projesine
uygulanıyor.

`lib/supabase/database.types.ts` gerçek şemadan üretildi
(`pnpm db:types`) — `Database` generic'i `client.ts`/`server.ts`/`admin.ts`
içinde kullanılıyor.

## Kimlik doğrulama ve yetkilendirme

- **Auth**: Supabase Auth (e-posta/şifre). `/login`, `/sign-up`,
  `/auth/callback` (e-posta onayı — `app/[locale]` dışında, next-intl
  proxy matcher'ından hariç tutuldu, bkz. `proxy.ts`).
- **Tenant izolasyonu**: her sorgu RLS'den geçer. Yetkilendirme JWT claim
  cache'i değil, her istekte `tenant_memberships`'ten taze okuma — bkz.
  `private.current_tenant_ids()` (`supabase/migrations/20260815120014_*`).
- **RBAC**: `permissions` (sabit katalog) + `role_templates` (global
  önayarlar) + `roles`/`role_permissions` (tenant'a klonlanmış, tenant
  başına özelleştirilebilir). Kod asla rol adına göre dallanmaz, sadece
  `has_permission(tenantId, key)` — bkz. `lib/auth/session.ts`.
- **Süper Admin**: `platform_admins` tablosu `tenant_memberships`'ten
  tamamen bağımsız — bir tenant sahibi olmak asla platform admin yapmaz.
  `role='owner'` diğer platform admin'leri yönetebilir, `role='support'`
  yönetemez.
- **Onboarding**: `private.create_tenant_with_owner()` (SECURITY DEFINER)
  tek bir işlemde tenant'ı oluşturur, SALON_OWNER şablonunu klonlar, ilk
  üyeliği kurar. Reserved slug kontrolü üç katmanda: client (hızlı geri
  bildirim) → Server Action → veritabanı fonksiyonu (bypass edilemez son
  kapı).
- **Route guard'lar**: `lib/auth/session.ts`'teki `getTenantAccess()` ve
  `requirePlatformAdmin()` — `React.cache()` ile sarmalanmış, aynı
  request içinde layout + page aynı DB round trip'i paylaşır.

## Cross-tenant izolasyon testleri (zorunlu)

```bash
pnpm test
```

`tests/cross-tenant-isolation.test.ts` — canlı DEV projesine karşı, gerçek
kullanıcı oturumlarıyla (asla service-role ile değil) RLS'nin ağ üzerinden
gerçekten izole ettiğini doğrular: tenant okuma/yazma izolasyonu,
membership/rol izolasyonu, `has_permission()`/`is_platform_admin()`
doğruluğu, platform admin çapraz-tenant erişimi, anonim erişim reddi,
kendi rolünü yükseltememe. `SUPABASE_SERVICE_ROLE_KEY` sadece test
fixture'larını kurup temizlemek için kullanılır — asertion'lar hep
publishable key + gerçek oturumla.

## i18n

`next-intl`, tek aktif dil `tr`. `localePrefix: "never"` sayesinde URL'lerde
`/tr/` görünmüyor (`/app/bella-hair`, `/tr/app/bella-hair` değil) ama routing
zaten `[locale]` segmentiyle çalışıyor — `en`/`ru` eklemek `lib/i18n/routing.ts`
içindeki `locales` dizisine eklemek + `messages/en.json` yazmaktan ibaret,
route/klasör yeniden yapılandırması gerekmez.

- Metinler: `messages/tr.json` (namespace'lere bölünmüş)
- Routing config: `lib/i18n/routing.ts`
- Client-rendered `Link`/router: `lib/i18n/navigation.ts`
- **Server-side `redirect()`**: düz `next/navigation` kullanılır, next-intl'in
  değil — next-intl'in server-side `redirect()`'i `{ href, locale }` objesi
  istiyor, tek-locale + prefix'siz kurulumda gereksiz. Bkz.
  `lib/auth/session.ts` başındaki not.

## Tenant routing

Onaylanan karar (subdomain değil, path tabanlı):

- `/app/[tenantSlug]/...` — kimliği doğrulanmış salon paneli (gerçek guard: üye değilseniz 404, oturum yoksa `/login`)
- `/book/[tenantSlug]` — herkese açık rezervasyon (placeholder, Faz 2)
- `/super-admin` — platform yönetimi (gerçek guard: `platform_admins` değilseniz ana sayfaya döner)
- `/onboarding` — ilk salon oluşturma (oturum açık olmalı)

`tenantSlug` her zaman sunucu tarafında `tenants` tablosuna karşı doğrulanır
— client'tan gelen slug hiçbir zaman doğrudan yetkilendirme için
güvenilmez. Rezerve slug listesi `lib/tenancy/reserved-slugs.ts` içinde.

## Klasör yapısı

```
app/
  [locale]/              next-intl kök segmenti (URL'de görünmez)
    layout.tsx             tema, i18n, toaster
    page.tsx                oturum durumuna göre: landing ya da salon/admin listesi
    (auth)/login, sign-up   auth sayfaları
    onboarding/             temel tenant creation flow
    app/[tenantSlug]/       salon paneli — gerçek auth+membership guard
    book/[tenantSlug]/      herkese açık rezervasyon (placeholder, Faz 2)
    super-admin/            platform paneli — gerçek platform_admin guard
  layout.tsx, not-found.tsx, global-error.tsx   kök seviye (locale'den önce)
  auth/callback/route.ts  e-posta onay callback'i (proxy matcher'ından hariç)
proxy.ts                 next-intl routing + Supabase session refresh
lib/
  supabase/               client / server / admin client'ları + database.types.ts
  auth/session.ts          session, membership, permission, guard helper'ları
  modules/                 auth/, tenants/, platform/ — Server Action'lar + Zod şemaları
  i18n/                    next-intl routing/request/navigation config
  tenancy/reserved-slugs.ts
  errors.ts                AppError, ActionResult<T>
components/
  auth/, onboarding/       form bileşenleri
  ui/                      shadcn/ui primitifleri
supabase/
  migrations/              20 migration — tablolar, RLS, RBAC, onboarding fonksiyonu
  config.toml
tests/cross-tenant-isolation.test.ts
messages/tr.json          çeviri kataloğu
```

## Tasarım

Varsayılan shadcn zinc/gri paletini kullanmıyoruz. `app/globals.css`
(`:root` / `.dark`) sıcak nötr bir zemin (background/foreground/border) ile
tek, ölçülü bir vurgu rengi (koyu, kırık ton bir çamgöz/teal — `--primary`)
tanımlıyor; hem light hem dark tema tokenize edilmiş durumda ve `next-themes`
ile `system/light/dark` arasında geçiş çalışıyor. Yazı tipi: **Plus Jakarta
Sans** (`next/font/google`, Türkçe karakter desteği için `latin` +
`latin-ext`), tek ailede birden fazla ağırlık — editoryal bir
başlık/gövde ayrımı değil, bütün gün kullanılacak bir operasyon paneline
uygun tek, temiz bir sistem.

## Faz durumu

- ✅ **Faz 0 — Foundation**
- ✅ **Faz 1 — Multi-Tenant + Auth + RLS + RBAC + Super Admin Foundation**
- Faz 2+ (randevu, finans, stok, boya formülleri, pazarlama...) — henüz
  planlama aşamasında, kapsamda değil
