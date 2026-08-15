# SalonOS

Çok kiracılı (multi-tenant) SaaS platformu — kadın kuaförleri ve güzellik
salonları için abonelik modeliyle satılacak operasyon paneli. Parlak
Mediatech bünyesinde geliştiriliyor, `salon.parlakmediatech.com.tr` altında
yayınlanacak.

Bu repo diğer Parlak Mediatech projelerinden tamamen bağımsızdır — ayrı
Vercel projesi, ayrı Supabase projesi.

## Durum: Faz 0 — Foundation

Şu an sadece temel altyapı var: proje iskeleti, tasarım sistemi, i18n,
Supabase bağlantı katmanı, route iskeleti. **Randevu, müşteri, finans, stok,
boya formülü gibi iş modülleri henüz yok** — bunlar sonraki fazlarda,
onaylandıkça eklenecek. Ayrıntılı mimari kararlar ve tam yol haritası için
onaylanmış mimari rapora bakın (proje kanalında paylaşıldı).

## Teknoloji

- **Next.js 16** (App Router, Turbopack varsayılan) + **React 19**
- **TypeScript** (strict + `noUncheckedIndexedAccess` vb. sıkılaştırmalar)
- **Tailwind CSS v4** (CSS-first config, `tailwind.config.ts` yok)
- **shadcn/ui** ("base-nova" preset — **Base UI** primitifleri, Radix değil;
  bileşenleri `asChild` değil `render` prop ile kompoze edin)
- **next-intl** (i18n, bkz. aşağıda)
- **Supabase** (Auth, Postgres + RLS, Storage) — `@supabase/ssr`
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

`http://localhost:3000` — ana sayfa kurulu route iskeletini gösterir
(`/app/[tenantSlug]`, `/book/[tenantSlug]`, `/super-admin` placeholder'ları).

### Diğer komutlar

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint .
pnpm format           # prettier --write .
pnpm build            # next build

pnpm db:start         # local Supabase (Docker gerekir)
pnpm db:reset         # migration'ları + seed.sql'i yeniden uygula
pnpm db:migration:new <isim>
pnpm db:types         # lib/supabase/database.types.ts üret
```

## Environment değişkenleri

`.env.example` → `.env.local`. Ayrıntılı açıklamalar dosyanın içinde;
özetle:

| Değişken                        | Nereden                                     | Not                                                                                      |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | `npx supabase status` ya da dashboard → API | Client'a açık, güvenlik RLS'ye dayanır                                                   |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | aynı                                        | Client'a açık                                                                            |
| `SUPABASE_SERVICE_ROLE_KEY`     | dashboard → API (server ortamı)             | **Asla commit etmeyin / client'a sızdırmayın** — sadece `lib/supabase/admin.ts` kullanır |
| `NEXT_PUBLIC_SITE_URL`          | —                                           | Local: `http://localhost:3000`                                                           |

Production secret'ları repository'ye değil, Vercel proje ayarlarına girilir.

## Supabase

Migration tabanlı geliştirme: şema değişiklikleri `supabase/migrations/*.sql`
içinde, git'te versiyonlanır — dashboard'dan elle şema değişikliği yapılmaz.
Faz 0'da `supabase/` sadece yapı olarak var, henüz gerçek migration yok (bkz.
`supabase/migrations/README.md`).

Bu makinede Docker kurulu değildi; Supabase CLI `npx supabase@latest` ile
çalıştırıldı. Docker mevcutsa `pnpm db:start` ile tam local stack (Postgres +
Auth + Storage + Studio) ayağa kalkar. Docker yoksa/kullanılamıyorsa proje
buna bağlı kalmadan, migration'lar doğrudan ayrı bir **DEV** Supabase
projesine uygulanacak şekilde tasarlandı — local stack zorunlu değil.

## i18n

`next-intl`, tek aktif dil `tr`. `localePrefix: "never"` sayesinde URL'lerde
`/tr/` görünmüyor (`/app/bella-hair`, `/tr/app/bella-hair` değil) ama routing
zaten `[locale]` segmentiyle çalışıyor — `en`/`ru` eklemek `lib/i18n/routing.ts`
içindeki `locales` dizisine eklemek + `messages/en.json` yazmaktan ibaret,
route/klasör yeniden yapılandırması gerekmez.

- Metinler: `messages/tr.json` (namespace'lere bölünmüş)
- Routing config: `lib/i18n/routing.ts`
- Locale-aware `Link`/`redirect`/router: `lib/i18n/navigation.ts` — ham
  `next/link` yerine bunu kullanın

## Tenant routing

Onaylanan karar (subdomain değil, path tabanlı):

- `/app/[tenantSlug]/...` — kimliği doğrulanmış salon paneli
- `/book/[tenantSlug]` — herkese açık rezervasyon
- `/super-admin` — platform yönetimi (Parlak Mediatech)

`tenantSlug` her zaman sunucu tarafında `tenants` tablosuna karşı doğrulanır
(Faz 1) — client'tan gelen slug hiçbir zaman doğrudan yetkilendirme için
güvenilmez. Rezerve slug listesi (`app`, `book`, `super-admin`, `api`,
locale kodları vb.) `lib/tenancy/reserved-slugs.ts` içinde — onboarding
akışı (Faz 2) bu listeye karşı kontrol etmeli.

## Klasör yapısı

```
app/
  [locale]/           next-intl kök segmenti (URL'de görünmez)
    layout.tsx          root layout: font, tema, i18n, toaster
    page.tsx             foundation durum sayfası
    app/[tenantSlug]/    salon paneli (Faz 1'de auth guard eklenecek)
    book/[tenantSlug]/   herkese açık rezervasyon (Faz 2)
    super-admin/          platform paneli (Faz 1'de auth guard eklenecek)
  global-error.tsx    kök layout hataları için fallback
  not-found.tsx        kök seviye 404 fallback
proxy.ts              next-intl middleware (Next 16: middleware.ts değil)
lib/
  supabase/            client / server / admin Supabase client'ları
  i18n/                 next-intl routing/request/navigation config
  tenancy/              reserved-slugs.ts
  errors.ts             AppError, ActionResult<T>
  utils.ts               shadcn cn() helper
components/ui/          shadcn/ui primitifleri
supabase/
  migrations/           boş (Faz 1'de dolacak)
  config.toml
messages/tr.json        çeviri kataloğu
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

- ✅ **Faz 0 — Foundation** (bu commit)
- ⏭️ **Faz 1 — Multi-Tenant + Auth + RLS + RBAC + Super Admin Foundation**
  (onay bekliyor)
- Faz 2+ (randevu, finans, stok, boya formülleri, pazarlama...) — henüz
  planlama aşamasında, kapsamda değil
