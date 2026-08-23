import { getTranslations } from "next-intl/server";
import { Link } from "@/lib/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getMyAccountProfile, getMyAppointments } from "@/lib/modules/customer-account/queries";
import { Button } from "@/components/ui/button";

export default async function AccountHomePage() {
  const t = await getTranslations("Account.home");
  const [user, profile, appointments] = await Promise.all([
    getCurrentUser(),
    getMyAccountProfile(),
    getMyAppointments(),
  ]);

  const displayName = profile?.fullName || user?.email || "";
  // Booking links are derived from the customer's OWN known salons
  // (each appointment already carries its tenantSlug) — there is no
  // general salon directory in this product to link to instead, and
  // inventing one would be out of scope here.
  const knownSalons = Array.from(
    new Map(appointments.map((a) => [a.tenantSlug, a.tenantName])).entries(),
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("greeting", { name: displayName })}</h1>
        <p className="text-muted-foreground text-sm">{profile?.email}</p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-5">
        <h2 className="text-sm font-medium">{t("appointmentsTitle")}</h2>
        {appointments.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("emptyDescription")}</p>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("appointmentsCount", { count: appointments.length })}
          </p>
        )}
        <Button render={<Link href="/account/appointments" />} className="w-fit">
          {t("viewAppointments")}
        </Button>
      </div>

      {knownSalons.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border p-5">
          <h2 className="text-sm font-medium">{t("bookAgainTitle")}</h2>
          <div className="flex flex-wrap gap-2">
            {knownSalons.map(([slug, name]) => (
              <Button key={slug} render={<Link href={`/book/${slug}`} />} variant="outline" size="sm">
                {name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
