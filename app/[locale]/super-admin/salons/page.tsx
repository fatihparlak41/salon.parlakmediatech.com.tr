import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminSalonList, parseListParams } from "@/lib/modules/platform/admin";
import { SalonFilters } from "@/components/super-admin/salon-filters";
import { SalonTable } from "@/components/super-admin/salon-table";
import { Pager } from "@/components/super-admin/pager";

/**
 * Searchable, filterable, paged salon list. Every request value is re-validated by parseListParams and again inside the database
 * function (fixed filter and sort lists, bounded paging, search matched as plain text); the page only ever shows what
 * admin_list_tenants returns, which contains no customer data.
 */
export default async function SuperAdminSalonsPage({ searchParams }: PageProps<"/[locale]/super-admin/salons">) {
  const params = parseListParams(await searchParams);
  const supabase = await createClient();
  const result = await getAdminSalonList(supabase, params);
  if (!result.ok) {
    if (result.reason === "forbidden") redirect("/");
    throw new Error("super admin salon list unavailable");
  }
  const { rows, total, pageSize } = result.data;
  const t = await getTranslations("SuperAdmin.salons");
  const tl = await getTranslations("SuperAdmin");

  const filterLabels = {
    searchLabel: t("searchLabel"),
    searchPlaceholder: t("searchPlaceholder"),
    searchButton: t("searchButton"),
    clear: t("clear"),
    sortLabel: t("sortLabel"),
    filters: {
      all: t("filters.all"),
      active: t("filters.active"),
      setup: t("filters.setup"),
      inactive: t("filters.inactive"),
      suspended: t("filters.suspended"),
      booking_on: t("filters.booking_on"),
      booking_off: t("filters.booking_off"),
      new: t("filters.new"),
      quiet: t("filters.quiet"),
      attention: t("filters.attention"),
    },
    sorts: {
      created_desc: t("sorts.created_desc"),
      created_asc: t("sorts.created_asc"),
      name_asc: t("sorts.name_asc"),
      activity_desc: t("sorts.activity_desc"),
      attention_desc: t("sorts.attention_desc"),
    },
  };

  const tableLabels = {
    columns: {
      salon: t("columns.salon"),
      owner: t("columns.owner"),
      status: t("columns.status"),
      setup: t("columns.setup"),
      booking: t("columns.booking"),
      staff: t("columns.staff"),
      customers: t("columns.customers"),
      appointments: t("columns.appointments"),
      created: t("columns.created"),
      lastActivity: t("columns.lastActivity"),
    },
    lifecycle: {
      setup: tl("lifecycle.setup"),
      active: tl("lifecycle.active"),
      inactive: tl("lifecycle.inactive"),
      suspended: tl("lifecycle.suspended"),
      canceled: tl("lifecycle.canceled"),
    },
    levels: { critical: tl("health.levels.critical"), warning: tl("health.levels.warning"), info: tl("health.levels.info"), ok: tl("health.levels.ok") },
    setupComplete: t("setupComplete"),
    setupIncomplete: t("setupIncomplete"),
    bookingOn: t("bookingOn"),
    bookingOff: t("bookingOff"),
    noOwner: t("noOwner"),
    unknownOwner: t("unknownOwner"),
    relative: { never: t("never"), today: t("today"), yesterday: t("yesterday"), daysAgo: t("daysAgo") },
  };

  const filtered = params.search !== "" || params.filter !== "all";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("subtitle")}</p>
      </div>
      <SalonFilters params={params} labels={filterLabels} />
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-empty>
          {filtered ? t("emptyFiltered") : t("emptyAll")}
        </p>
      ) : (
        <>
          <SalonTable rows={rows} labels={tableLabels} now={new Date()} />
          <Pager params={params} total={total} pageSize={pageSize} labels={{ previous: t("previous"), next: t("next"), pageOf: t("pageOf"), results: t("results") }} />
        </>
      )}
    </div>
  );
}
