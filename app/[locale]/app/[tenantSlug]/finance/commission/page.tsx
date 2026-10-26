import { redirect } from "next/navigation";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getCommissionRules, getStaffCommission, getStaffCommissionDetail } from "@/lib/modules/commission/queries";
import { isoDate } from "@/lib/modules/commission/model";
import { CommissionDetailView, CommissionSummaryView } from "@/components/commission/commission-view";
import { CommissionRulesPanel } from "@/components/commission/commission-rules";
import { Link } from "@/lib/i18n/navigation";

/**
 * Faz COMM.1A — Personel Primleri. Owner screen (finance.view; configuration needs finance.manage). Without finance.view it
 * redirects: nothing is rendered and hidden. Every number comes from the one commission read model.
 */
export default async function CommissionPage({ params, searchParams }: PageProps<"/[locale]/app/[tenantSlug]/finance/commission">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;
  const tenantId = access.tenant.id;
  const [canView, canManage] = await Promise.all([hasPermission(tenantId, "finance.view"), hasPermission(tenantId, "finance.manage")]);
  if (!canView) redirect(`/app/${tenantSlug}`);

  const sp = (await searchParams) as Record<string, string | string[] | undefined>;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const from = isoDate(one("from"));
  const to = isoDate(one("to"));
  const staffParam = one("staff");
  const staffId = staffParam && /^[0-9a-f-]{36}$/i.test(staffParam) ? staffParam : null;

  const [summary, rules] = await Promise.all([getStaffCommission(tenantId, from, to), getCommissionRules(tenantId)]);
  if (!summary || !rules) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8">
        <p className="text-destructive text-sm" role="alert">Komisyon bilgisi şu an okunamadı. Sayfayı yenileyip tekrar deneyin.</p>
      </div>
    );
  }
  const detail = staffId ? await getStaffCommissionDetail(tenantId, staffId, summary.from, summary.to) : null;
  const monthStart = `${rules.today.slice(0, 8)}01`;
  const base = `/app/${tenantSlug}/finance/commission`;
  const query = new URLSearchParams({ from: summary.from, to: summary.to }).toString();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Personel primleri</h1>
        <p className="text-muted-foreground mt-1 text-sm">Personelin tamamladığı hizmetlerden doğan komisyon. Bordro ya da ödeme değildir.</p>
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Tarih aralığı">
        <label className="flex flex-col gap-1 text-xs">
          Başlangıç
          <input type="date" name="from" defaultValue={summary.from} className="border-input bg-background h-8 rounded-lg border px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Bitiş
          <input type="date" name="to" defaultValue={summary.to} className="border-input bg-background h-8 rounded-lg border px-2 text-sm" />
        </label>
        <button type="submit" className="bg-primary text-primary-foreground h-8 rounded-lg px-3 text-sm font-medium">Göster</button>
        <Link href={base} className="text-sm underline underline-offset-4">Bugün</Link>
        <Link href={`${base}?from=${monthStart}&to=${rules.today}`} className="text-sm underline underline-offset-4">Bu ay</Link>
      </form>
      <CommissionSummaryView summary={summary} basePath={base} selectedStaffId={staffId} query={query} />
      {detail ? <CommissionDetailView detail={detail} /> : null}
      <CommissionRulesPanel tenantId={tenantId} tenantSlug={tenantSlug} rules={rules} currency={summary.currency} canManage={canManage} />
    </div>
  );
}
