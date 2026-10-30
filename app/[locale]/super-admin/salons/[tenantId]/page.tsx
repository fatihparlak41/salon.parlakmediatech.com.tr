import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { getAdminSalonAudit, getAdminSalonDetail, UUID_RE } from "@/lib/modules/platform/admin";
import { getSiteUrl } from "@/lib/site-url";
import { SalonDetailView } from "@/components/super-admin/salon-detail-view";

/**
 * One salon, read-only: overview and setup readiness (the canonical onboarding steps), Owner(s) and members, usage counts, booking readiness,
 * system health and the salon's administrative history. Nothing here writes, impersonates or exposes customer data.
 */
export default async function SuperAdminSalonDetailPage({ params }: PageProps<"/[locale]/super-admin/salons/[tenantId]">) {
  const { tenantId } = await params;
  // A malformed id never reaches the database.
  if (!UUID_RE.test(tenantId)) notFound();

  const supabase = await createClient();
  const [detail, audit] = await Promise.all([getAdminSalonDetail(supabase, tenantId), getAdminSalonAudit(supabase, tenantId, 50)]);
  if (!detail.ok) {
    if (detail.reason === "forbidden") redirect("/");
    if (detail.reason === "not_found") notFound();
    throw new Error("super admin salon detail unavailable");
  }

  const t = await getTranslations("SuperAdmin");
  const siteUrl = getSiteUrl().replace(/\/+$/, "");

  return (
    <SalonDetailView
      detail={detail.data}
      audit={audit.ok ? audit.data : []}
      bookingUrl={`${siteUrl}${detail.data.overview.bookingPath}`}
      now={new Date()}
      t={{
        back: t("detail.back"),
        sections: {
          overview: t("detail.sections.overview"),
          owners: t("detail.sections.owners"),
          usage: t("detail.sections.usage"),
          booking: t("detail.sections.booking"),
          system: t("detail.sections.system"),
          audit: t("detail.sections.audit"),
        },
        overview: {
          name: t("detail.overview.name"),
          slug: t("detail.overview.slug"),
          accountStatus: t("detail.overview.accountStatus"),
          lifecycle: t("detail.overview.lifecycle"),
          timezone: t("detail.overview.timezone"),
          currency: t("detail.overview.currency"),
          created: t("detail.overview.created"),
          trialEnds: t("detail.overview.trialEnds"),
          bookingLink: t("detail.overview.bookingLink"),
          subscription: t("detail.overview.subscription"),
          subscriptionPending: t("detail.overview.subscriptionPending"),
          setupHeading: t("detail.overview.setupHeading"),
          blockersHeading: t("detail.overview.blockersHeading"),
          noBlockers: t("detail.overview.noBlockers"),
          profileMissingPrefix: t("detail.overview.profileMissingPrefix"),
        },
        steps: {
          profile: t("detail.steps.profile"),
          services: t("detail.steps.services"),
          staff: t("detail.steps.staff"),
          hours: t("detail.steps.hours"),
          mapping: t("detail.steps.mapping"),
          booking: t("detail.steps.booking"),
          ready: t("detail.steps.ready"),
        },
        blockers: {
          tenant_inactive: t("detail.blockers.tenant_inactive"),
          salon_profile_missing: t("detail.blockers.salon_profile_missing"),
          no_working_hours: t("detail.blockers.no_working_hours"),
          no_services: t("detail.blockers.no_services"),
          no_staff: t("detail.blockers.no_staff"),
          no_bookable_staff: t("detail.blockers.no_bookable_staff"),
          public_booking_disabled: t("detail.blockers.public_booking_disabled"),
          no_available_slot: t("detail.blockers.no_available_slot"),
        },
        profileMissing: {
          name: t("detail.profileMissing.name"),
          timezone: t("detail.profileMissing.timezone"),
          currency: t("detail.profileMissing.currency"),
          branch: t("detail.profileMissing.branch"),
          phone: t("detail.profileMissing.phone"),
        },
        owners: {
          ownersHeading: t("detail.owners.ownersHeading"),
          membersHeading: t("detail.owners.membersHeading"),
          name: t("detail.owners.name"),
          email: t("detail.owners.email"),
          phone: t("detail.owners.phone"),
          role: t("detail.owners.role"),
          access: t("detail.owners.access"),
          staff: t("detail.owners.staff"),
          lastSignIn: t("detail.owners.lastSignIn"),
          active: t("detail.owners.active"),
          suspended: t("detail.owners.suspended"),
          linked: t("detail.owners.linked"),
          notLinked: t("detail.owners.notLinked"),
          noOwners: t("detail.owners.noOwners"),
          unnamed: t("detail.owners.unnamed"),
        },
        usage: {
          staff: t("detail.usage.staff"),
          members: t("detail.usage.members"),
          services: t("detail.usage.services"),
          customers: t("detail.usage.customers"),
          appointments: t("detail.usage.appointments"),
          today: t("detail.usage.today"),
          week: t("detail.usage.week"),
          photos: t("detail.usage.photos"),
          commission: t("detail.usage.commission"),
          invitations: t("detail.usage.invitations"),
          customersNote: t("detail.usage.customersNote"),
        },
        booking: {
          publicBooking: t("detail.booking.publicBooking"),
          engine: t("detail.booking.engine"),
          engineReady: t("detail.booking.engineReady"),
          engineNotReady: t("detail.booking.engineNotReady"),
          staffWithHours: t("detail.booking.staffWithHours"),
          bookablePaths: t("detail.booking.bookablePaths"),
          direct: t("detail.booking.direct"),
          inquiry: t("detail.booking.inquiry"),
          firstSlot: t("detail.booking.firstSlot"),
          noSlot: t("detail.booking.noSlot"),
          on: t("salons.bookingOn"),
          off: t("salons.bookingOff"),
        },
        system: {
          lastActivity: t("detail.system.lastActivity"),
          ownerNeverSignedIn: t("detail.system.ownerNeverSignedIn"),
          oldestInvitation: t("detail.system.oldestInvitation"),
          health: t("detail.system.health"),
          noSignals: t("detail.system.noSignals"),
        },
        actions: {
          openBooking: t("detail.actions.openBooking"),
          copyLink: t("detail.actions.copyLink"),
          copyId: t("detail.actions.copyId"),
          copied: t("detail.actions.copied"),
        },
        audit: {
          description: t("detail.audit.description"),
          when: t("detail.audit.when"),
          what: t("detail.audit.what"),
          actor: t("detail.audit.actor"),
          empty: t("detail.audit.empty"),
          actors: { user: t("detail.audit.actors.user"), platform_admin: t("detail.audit.actors.platform_admin"), system: t("detail.audit.actors.system") },
          actions: {
            "tenant.created": t("detail.audit.actions.tenant.created"),
            "onboarding.profile_updated": t("detail.audit.actions.onboarding.profile_updated"),
            "settings.online_booking_changed": t("detail.audit.actions.settings.online_booking_changed"),
            "settings.customer_notification_changed": t("detail.audit.actions.settings.customer_notification_changed"),
            "role.provisioned": t("detail.audit.actions.role.provisioned"),
            "role.template_synced": t("detail.audit.actions.role.template_synced"),
            "team_invitation.created": t("detail.audit.actions.team_invitation.created"),
            "team_invitation.email_sent": t("detail.audit.actions.team_invitation.email_sent"),
            "team_invitation.accepted": t("detail.audit.actions.team_invitation.accepted"),
            "membership.suspended": t("detail.audit.actions.membership.suspended"),
            "membership.reactivated": t("detail.audit.actions.membership.reactivated"),
            "membership.removed": t("detail.audit.actions.membership.removed"),
            "staff_member.created": t("detail.audit.actions.staff_member.created"),
            "staff_member.updated": t("detail.audit.actions.staff_member.updated"),
            "service.created": t("detail.audit.actions.service.created"),
            "service.updated": t("detail.audit.actions.service.updated"),
            "customer.created": t("detail.audit.actions.customer.created"),
            "appointment.created": t("detail.audit.actions.appointment.created"),
            "appointment.cancelled": t("detail.audit.actions.appointment.cancelled"),
            "appointment.rescheduled": t("detail.audit.actions.appointment.rescheduled"),
            "appointment.status_changed": t("detail.audit.actions.appointment.status_changed"),
          },
        },
        lifecycle: {
          setup: t("lifecycle.setup"),
          active: t("lifecycle.active"),
          inactive: t("lifecycle.inactive"),
          suspended: t("lifecycle.suspended"),
          canceled: t("lifecycle.canceled"),
        },
        accountStatus: { trial: t("accountStatus.trial"), active: t("accountStatus.active"), suspended: t("accountStatus.suspended"), canceled: t("accountStatus.canceled") },
        levels: { critical: t("health.levels.critical"), warning: t("health.levels.warning"), info: t("health.levels.info"), ok: t("health.levels.ok") },
        healthCodes: {
          no_owner: t("health.codes.no_owner"),
          booking_broken: t("health.codes.booking_broken"),
          setup_stalled: t("health.codes.setup_stalled"),
          owner_never_signed_in: t("health.codes.owner_never_signed_in"),
          no_recent_activity: t("health.codes.no_recent_activity"),
          invite_pending: t("health.codes.invite_pending"),
          new_salon: t("health.codes.new_salon"),
          no_appointments_yet: t("health.codes.no_appointments_yet"),
          booking_off: t("health.codes.booking_off"),
          trial_ending: t("health.codes.trial_ending"),
          suspended: t("health.codes.suspended"),
          canceled: t("health.codes.canceled"),
        },
        relative: { never: t("salons.never"), today: t("salons.today"), yesterday: t("salons.yesterday"), daysAgo: t.raw("salons.daysAgo") as string },
      }}
    />
  );
}
