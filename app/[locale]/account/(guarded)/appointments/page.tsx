import { getTranslations } from "next-intl/server";
import { getMyAppointments } from "@/lib/modules/customer-account/queries";
import { AppointmentsList } from "@/components/customer-account/appointments-list";

export default async function AccountAppointmentsPage() {
  const t = await getTranslations("Account.appointments");
  const appointments = await getMyAppointments();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AppointmentsList appointments={appointments} />
    </div>
  );
}
