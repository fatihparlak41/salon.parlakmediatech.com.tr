import { getTranslations } from "next-intl/server";
import { getMyAppointments } from "@/lib/modules/customer-account/queries";
import { formatTenantLocalDateTime } from "@/lib/modules/appointments/timezone";
import { STATUS_LABELS_TR, type AppointmentStatus } from "@/lib/modules/appointments/status";
import { Badge } from "@/components/ui/badge";

export default async function AccountAppointmentsPage() {
  const t = await getTranslations("Account.appointments");
  const appointments = await getMyAppointments();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      {appointments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("emptyDescription")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {appointments.map((a) => (
            <li key={a.appointmentId} className="flex flex-col gap-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{a.tenantName}</span>
                <Badge variant="secondary">{STATUS_LABELS_TR[a.status as AppointmentStatus] ?? a.status}</Badge>
              </div>
              <p className="text-muted-foreground text-sm">{a.branchName}</p>
              <p className="text-sm">{formatTenantLocalDateTime(a.scheduledStartAt, a.tenantTimezone)}</p>
              <ul className="text-muted-foreground flex flex-col gap-0.5 text-sm">
                {a.services.map((s, i) => (
                  <li key={i}>
                    {s.serviceName} — {s.staffName} ({s.durationMinutes} {t("minutesShort")}, {s.price} ₺)
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
