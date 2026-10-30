import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton } from "@/components/super-admin/copy-button";
import { HealthBadge, LifecycleBadge, SignalList } from "@/components/super-admin/status-badges";
import { StatCard } from "@/components/super-admin/stat-card";
import { formatDate, formatDateTime, relativeDays, relativeLabel } from "@/components/super-admin/format";
import type { AdminAuditEvent, AdminSalonDetail, HealthLevel, Lifecycle } from "@/lib/modules/platform/admin";

export type SalonDetailLabels = {
  back: string;
  sections: { overview: string; owners: string; usage: string; booking: string; system: string; audit: string };
  overview: {
    name: string; slug: string; accountStatus: string; lifecycle: string; timezone: string; currency: string; created: string; trialEnds: string;
    bookingLink: string; subscription: string; subscriptionPending: string; setupHeading: string; blockersHeading: string; noBlockers: string; profileMissingPrefix: string;
  };
  steps: Record<string, string>;
  blockers: Record<string, string>;
  profileMissing: Record<string, string>;
  owners: {
    ownersHeading: string; membersHeading: string; name: string; email: string; phone: string; role: string; access: string; staff: string; lastSignIn: string;
    active: string; suspended: string; linked: string; notLinked: string; noOwners: string; unnamed: string;
  };
  usage: {
    staff: string; members: string; services: string; customers: string; appointments: string; today: string; week: string; photos: string; commission: string; invitations: string; customersNote: string;
  };
  booking: {
    publicBooking: string; engine: string; engineReady: string; engineNotReady: string; staffWithHours: string; bookablePaths: string; direct: string; inquiry: string; firstSlot: string; noSlot: string; on: string; off: string;
  };
  system: { lastActivity: string; ownerNeverSignedIn: string; oldestInvitation: string; health: string; noSignals: string };
  actions: { openBooking: string; copyLink: string; copyId: string; copied: string };
  audit: { description: string; when: string; what: string; actor: string; empty: string; actors: Record<string, string>; actions: Record<string, string> };
  lifecycle: Record<Lifecycle, string>;
  accountStatus: Record<string, string>;
  levels: Record<HealthLevel, string>;
  healthCodes: Record<string, string>;
  relative: { never: string; today: string; yesterday: string; daysAgo: string };
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * The read-only salon detail. It renders exactly what public.admin_tenant_detail / admin_tenant_audit returned: counts and operational facts,
 * the Owner's contact, member names and roles. There is no form, no write control and nothing that signs in as the salon; the three buttons
 * are an ordinary link to the public booking page and two clipboard copies of non-secret text.
 */
export function SalonDetailView({
  detail,
  audit,
  bookingUrl,
  now,
  t,
}: {
  detail: AdminSalonDetail;
  audit: AdminAuditEvent[];
  bookingUrl: string;
  now: Date;
  t: SalonDetailLabels;
}) {
  const o = detail.overview;
  const u = detail.usage;
  const b = detail.booking;
  const s = detail.system;
  const lastActivity = relativeLabel(relativeDays(s.lastActivityAt, now), t.relative);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" render={<Link href="/super-admin/salons" />}>
          {"← " + t.back}
        </Button>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{o.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground font-mono text-sm">{o.slug}</span>
            <LifecycleBadge lifecycle={o.lifecycle} labels={t.lifecycle} />
            <HealthBadge level={s.healthLevel} labels={t.levels} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" render={<a href={bookingUrl} target="_blank" rel="noopener noreferrer" />}>
            {t.actions.openBooking}
          </Button>
          <CopyButton value={bookingUrl} label={t.actions.copyLink} doneLabel={t.actions.copied} />
          <CopyButton value={o.tenantId} label={t.actions.copyId} doneLabel={t.actions.copied} />
        </div>
      </header>

      <section aria-labelledby="sec-overview">
        <Card>
          <CardHeader>
            <CardTitle id="sec-overview">{t.sections.overview}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t.overview.accountStatus}>{t.accountStatus[o.accountStatus] ?? o.accountStatus}</Field>
              <Field label={t.overview.timezone}>{o.timezone}</Field>
              <Field label={t.overview.currency}>{o.currency}</Field>
              <Field label={t.overview.created}>{formatDate(o.createdAt)}</Field>
              {o.trialEndsAt ? <Field label={t.overview.trialEnds}>{formatDate(o.trialEndsAt)}</Field> : null}
              <Field label={t.overview.subscription}>
                {o.subscriptionStatus ? <span data-subscription={o.subscriptionStatus}>{o.subscriptionStatus}</span> : <span className="text-muted-foreground" data-subscription="none">{t.overview.subscriptionPending}</span>}
              </Field>
              <Field label={t.overview.bookingLink}>
                <span className="font-mono text-xs break-all">{bookingUrl}</span>
              </Field>
            </dl>

            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-medium">{t.overview.setupHeading}</h3>
                <ul className="flex flex-col gap-1.5" data-setup-steps>
                  {o.steps.map((step) => (
                    <li key={step.key} className="flex items-center justify-between gap-3 text-sm" data-step={step.key} data-done={step.done}>
                      <span>{t.steps[step.key] ?? step.key}</span>
                      <span className={step.done ? "text-primary font-medium" : "text-muted-foreground"}>{step.done ? "✓" : "—"}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">{t.overview.blockersHeading}</h3>
                {o.blockers.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t.overview.noBlockers}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-sm" data-blockers>
                    {o.blockers.map((code) => (
                      <li key={code} data-blocker={code}>
                        {t.blockers[code] ?? code}
                        {code === "salon_profile_missing" && o.profileMissing.length > 0 ? (
                          <span className="text-muted-foreground">{` (${t.overview.profileMissingPrefix}: ${o.profileMissing.map((m) => t.profileMissing[m] ?? m).join(", ")})`}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="sec-owners">
        <Card>
          <CardHeader>
            <CardTitle id="sec-owners">{t.sections.owners}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div>
              <h3 className="mb-2 text-sm font-medium">{t.owners.ownersHeading}</h3>
              {detail.owners.length === 0 ? (
                <p className="text-destructive text-sm" data-no-owner>{t.owners.noOwners}</p>
              ) : (
                <div className="border-border overflow-x-auto rounded-lg border">
                  <Table data-owners>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.owners.name}</TableHead>
                        <TableHead>{t.owners.email}</TableHead>
                        <TableHead>{t.owners.phone}</TableHead>
                        <TableHead>{t.owners.access}</TableHead>
                        <TableHead>{t.owners.staff}</TableHead>
                        <TableHead>{t.owners.lastSignIn}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.owners.map((owner, i) => (
                        <TableRow key={`${owner.email ?? "owner"}-${i}`}>
                          <TableCell>{owner.name ?? t.owners.unnamed}</TableCell>
                          <TableCell>{owner.email}</TableCell>
                          <TableCell className="whitespace-nowrap">{owner.phone ?? ""}</TableCell>
                          <TableCell>{owner.status === "suspended" ? t.owners.suspended : t.owners.active}</TableCell>
                          <TableCell>{owner.staffLinked ? t.owners.linked : t.owners.notLinked}</TableCell>
                          <TableCell className="text-muted-foreground whitespace-nowrap">{owner.lastSignInAt ? formatDateTime(owner.lastSignInAt) : t.relative.never}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">{t.owners.membersHeading}</h3>
              <div className="border-border overflow-x-auto rounded-lg border">
                <Table data-members>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.owners.name}</TableHead>
                      <TableHead>{t.owners.email}</TableHead>
                      <TableHead>{t.owners.role}</TableHead>
                      <TableHead>{t.owners.access}</TableHead>
                      <TableHead>{t.owners.staff}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.members.map((m) => (
                      <TableRow key={m.membershipId}>
                        <TableCell>{m.displayName ?? t.owners.unnamed}</TableCell>
                        <TableCell>{m.email}</TableCell>
                        <TableCell>{m.roleName}</TableCell>
                        <TableCell>{m.status === "suspended" ? t.owners.suspended : t.owners.active}</TableCell>
                        <TableCell>{m.linkedStaffName ?? t.owners.notLinked}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="sec-usage" className="flex flex-col gap-3">
        <h2 id="sec-usage" className="text-base font-semibold">{t.sections.usage}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label={t.usage.staff} value={u.staff} />
          <StatCard label={t.usage.members} value={u.members} />
          <StatCard label={t.usage.services} value={u.services} />
          <StatCard label={t.usage.customers} value={u.customers} />
          <StatCard label={t.usage.appointments} value={u.appointments} />
          <StatCard label={t.usage.today} value={u.appointmentsToday} />
          <StatCard label={t.usage.week} value={u.appointments7d} />
          <StatCard label={t.usage.photos} value={u.treatmentPhotos} />
          <StatCard label={t.usage.commission} value={u.commissionRules} />
          <StatCard label={t.usage.invitations} value={u.pendingInvitations} />
        </div>
        <p className="text-muted-foreground text-xs">{t.usage.customersNote}</p>
      </section>

      <section aria-labelledby="sec-booking">
        <Card>
          <CardHeader>
            <CardTitle id="sec-booking">{t.sections.booking}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t.booking.publicBooking}>{b.publicBookingEnabled ? t.booking.on : t.booking.off}</Field>
              <Field label={t.booking.engine}>{b.bookingEngineReady ? t.booking.engineReady : t.booking.engineNotReady}</Field>
              <Field label={t.booking.staffWithHours}>{`${b.staffWithHours} / ${b.activeStaff}`}</Field>
              <Field label={t.booking.bookablePaths}>{b.bookablePaths}</Field>
              <Field label={t.booking.direct}>{b.directBookableServices}</Field>
              <Field label={t.booking.inquiry}>{b.inquiryServices}</Field>
              <Field label={t.booking.firstSlot}>{b.firstAvailableSlotAt ? formatDateTime(b.firstAvailableSlotAt) : t.booking.noSlot}</Field>
            </dl>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="sec-system">
        <Card>
          <CardHeader>
            <CardTitle id="sec-system">{t.sections.system}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t.system.lastActivity}>
                {lastActivity}
                {s.lastActivityAt ? <span className="text-muted-foreground">{` · ${formatDateTime(s.lastActivityAt)}`}</span> : null}
              </Field>
              {s.ownersNeverSignedIn ? <Field label={t.system.ownerNeverSignedIn}>✓</Field> : null}
              {s.oldestPendingInvitationAt ? <Field label={t.system.oldestInvitation}>{formatDate(s.oldestPendingInvitationAt)}</Field> : null}
            </dl>
            <div>
              <h3 className="mb-2 text-sm font-medium">{t.system.health}</h3>
              {s.health.length === 0 ? <p className="text-muted-foreground text-sm">{t.system.noSignals}</p> : <SignalList signals={s.health} codes={t.healthCodes} levels={t.levels} />}
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="sec-audit">
        <Card>
          <CardHeader>
            <CardTitle id="sec-audit">{t.sections.audit}</CardTitle>
            <p className="text-muted-foreground text-xs">{t.audit.description}</p>
          </CardHeader>
          <CardContent>
            {audit.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t.audit.empty}</p>
            ) : (
              <div className="border-border overflow-x-auto rounded-lg border">
                <Table data-audit>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.audit.when}</TableHead>
                      <TableHead>{t.audit.what}</TableHead>
                      <TableHead>{t.audit.actor}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audit.map((e, i) => (
                      <TableRow key={`${e.occurredAt}-${e.action}-${i}`}>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{formatDateTime(e.occurredAt)}</TableCell>
                        <TableCell>{t.audit.actions[e.action] ?? e.action}</TableCell>
                        <TableCell>{t.audit.actors[e.actorType] ?? e.actorType}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
