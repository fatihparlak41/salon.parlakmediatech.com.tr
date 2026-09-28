import { getTranslations } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getMyAccountProfile } from "@/lib/modules/customer-account/queries";
import { getMyNotificationPreferences } from "@/lib/modules/notifications/queries";
import { deviceOwnerTag } from "@/lib/pwa/device-owner-tag";
import {
  getMyMembershipId,
  getStaffLinkByMembership,
} from "@/lib/modules/dashboard/queries";
import { ProfileForm } from "@/components/customer-account/profile-form";
import { DeviceNotificationsCard } from "@/components/account/device-notifications-card";
import { NotificationPreferencesCard } from "@/components/account/notification-preferences-card";

/**
 * Faz ACCOUNT.1 — "Hesabım": the member's OWN profile and notification
 * controls inside a salon. Deliberately NOT behind any permission: the
 * tenant layout already proved the caller has an ACTIVE membership in this
 * tenant (getTenantAccess), and that is the whole requirement — an Owner, a
 * Yönetici, a Resepsiyon and a Personel all reach exactly this page, because
 * nothing on it touches salon configuration. Salon-level settings stay on
 * /settings behind settings.manage.
 *
 * Everything here is scoped to the caller by the database, not by this
 * file: get_my_account_profile / update_my_account_profile and the
 * *_my_notification_preferences / push-subscription RPCs derive the row
 * from auth.uid(), and none of them accepts a user or membership id.
 */
export default async function TenantAccountPage({
  params,
}: PageProps<"/[locale]/app/[tenantSlug]/account">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);

  // Layout above already guards unauthenticated/not_found.
  if (access.reason !== "ok") {
    return null;
  }

  const tenantId = access.tenant.id;
  const t = await getTranslations("TenantApp.account");
  const supabase = await createClient();

  const [profile, preferences, canViewAppointments, canCreateAppointments, membershipId] =
    await Promise.all([
      getMyAccountProfile(),
      getMyNotificationPreferences(tenantId),
      hasPermission(tenantId, "appointments.view"),
      hasPermission(tenantId, "appointments.create"),
      getMyMembershipId(supabase, tenantId, access.user.id),
    ]);
  const staffLink = membershipId
    ? await getStaffLinkByMembership(supabase, tenantId, membershipId)
    : null;

  // Mirrors the recipient rule the delivery worker applies
  // (private.materialize_notification_deliveries): salon-wide admins
  // (appointments.create) hear about every appointment event, a linked
  // staff member about the ones assigned to them, and everyone additionally
  // needs appointments.view. Telling people this up front saves the
  // "I turned it on and nothing arrives" support call for an account that
  // is not linked to a staff record.
  let recipientNote: string | null = null;
  if (canViewAppointments) {
    if (canCreateAppointments) recipientNote = t("notifications.recipientAll");
    else if (staffLink) recipientNote = t("notifications.recipientAssigned");
    else recipientNote = t("notifications.recipientNone");
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      <section
        aria-labelledby="account-profile-heading"
        className="flex flex-col gap-4 rounded-lg border p-5"
      >
        <div className="flex flex-col gap-0.5">
          <h2 id="account-profile-heading" className="text-sm font-medium">
            {t("profile.heading")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("profile.description")}</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("profile.salonLabel")}</dt>
          <dd className="font-medium">{access.tenant.name}</dd>
          <dt className="text-muted-foreground">{t("profile.roleLabel")}</dt>
          <dd className="font-medium">{access.roleName}</dd>
        </dl>
        {profile ? (
          <ProfileForm profile={profile} />
        ) : (
          <p className="text-muted-foreground text-sm">{t("profile.loadError")}</p>
        )}
      </section>

      <section id="notifications" className="flex scroll-mt-20 flex-col gap-6">
        <DeviceNotificationsCard
          tenantId={tenantId}
          vapidPublicKey={process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY}
          recipientNote={recipientNote}
          ownerTag={deviceOwnerTag(access.user.id)}
        />
        {preferences && (
          <NotificationPreferencesCard tenantId={tenantId} initialPreferences={preferences} />
        )}
      </section>
    </div>
  );
}
