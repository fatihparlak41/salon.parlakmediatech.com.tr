"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { TurnstileWidget } from "@/components/public-booking/turnstile-widget";
import { SalonContactHeader } from "@/components/public-booking/salon-contact-header";
import {
  fetchPublicEligibleStaff,
  fetchPublicAvailabilitySlots,
  type PublicBookingBranch,
  type PublicBookingService,
  type PublicBookingStaffOption,
  type GuestBookingConfirmation,
} from "@/lib/modules/public-booking/client-queries";
import { submitGuestBookingAction } from "@/lib/modules/public-booking/actions";
import { PUBLIC_BOOKING_HORIZON_DAYS } from "@/lib/modules/public-booking/constants";
import { tenantLocalToUtcIso, formatTenantLocalDateTime, getTenantTodayRangeUtc } from "@/lib/modules/appointments/timezone";

const WEEKDAY_LABELS_TR = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"]; // Sunday-first, matches Date#getUTCDay()

type Step = "branch" | "service" | "staff" | "date" | "time" | "contact" | "confirm" | "success";

type Labels = {
  unavailableTitle: string;
  unavailableBody: string;
  backHome: string;
  stepBranch: string;
  stepService: string;
  stepStaff: string;
  stepDateTime: string;
  stepContact: string;
  chooseBranchTitle: string;
  chooseServiceTitle: string;
  chooseStaffTitle: string;
  anyStaff: string;
  chooseDateTitle: string;
  chooseTimeTitle: string;
  noSlotsForDate: string;
  loadingSlots: string;
  minutesShort: string;
  back: string;
  next: string;
  contactTitle: string;
  fullNameLabel: string;
  phoneLabel: string;
  emailLabel: string;
  claimOptInLabel: string;
  claimPendingNote: string;
  summaryTitle: string;
  summaryBranch: string;
  summaryService: string;
  summaryStaff: string;
  summaryDateTime: string;
  summaryPrice: string;
  // Faz 2I.2F (Batch A) — SalonContactHeader's action-button labels.
  contactWhatsapp: string;
  contactInstagram: string;
  contactDirections: string;
  submit: string;
  submitting: string;
  confirmedTitle: string;
  confirmedBody: string;
  confirmationReference: string;
  newBooking: string;
  requiredField: string;
  todayLabel: string;
};

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function StepHeader({ current, steps, labels }: { current: Step; steps: Step[]; labels: Labels }) {
  const STEP_LABEL: Partial<Record<Step, string>> = {
    branch: labels.stepBranch,
    service: labels.stepService,
    staff: labels.stepStaff,
    date: labels.stepDateTime,
    time: labels.stepDateTime,
    contact: labels.stepContact,
  };
  // Collapse date+time into one visual "Tarih & Saat" progress dot.
  const visualSteps: Step[] = steps.filter((s): s is Step => s !== "time" && s !== "confirm");
  const currentVisual: Step = current === "time" ? "date" : current;
  const currentIndex = visualSteps.indexOf(currentVisual);

  return (
    <div className="flex items-center gap-1.5 px-1">
      {visualSteps.map((s, i) => (
        <div key={s} className="flex flex-1 flex-col items-center gap-1">
          <div
            className={`h-1.5 w-full rounded-full ${i <= currentIndex ? "bg-primary" : "bg-muted"}`}
            aria-hidden="true"
          />
          <span className={`text-[10px] font-medium ${i === currentIndex ? "text-foreground" : "text-muted-foreground"}`}>
            {STEP_LABEL[s]}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BookingWizard({
  tenantSlug,
  tenantName,
  tenantTimezone,
  branches,
  turnstileSiteKey,
  isAuthenticated,
  labels,
}: {
  tenantSlug: string;
  tenantName: string;
  tenantTimezone: string;
  branches: PublicBookingBranch[];
  turnstileSiteKey: string;
  // Faz 2G.3.1 — a display hint only, server-derived (see page.tsx),
  // never a trust boundary: it only decides whether the claim opt-in
  // checkbox renders. Even a tampered value changes nothing server-side
  // — submitGuestBookingAction independently re-derives the real session
  // and ignores wantAccountClaim entirely for an authenticated booker
  // (see gateway.ts), exactly matching "if the customer is already
  // authenticated, do not show this flow" without needing this prop to
  // be trustworthy.
  isAuthenticated: boolean;
  labels: Labels;
}) {
  const singleBranch = branches.length === 1 ? branches[0]! : null;
  const stepOrder = useMemo<Step[]>(
    () => (branches.length > 1 ? ["branch", "service", "staff", "date", "time", "contact", "confirm"] : ["service", "staff", "date", "time", "contact", "confirm"]),
    [branches.length],
  );

  const [step, setStep] = useState<Step>(stepOrder[0]!);
  const [branchId, setBranchId] = useState<string | null>(singleBranch?.id ?? null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffChoice, setStaffChoice] = useState<string | "any" | null>(null);
  const [dateStr, setDateStr] = useState<string | null>(null);
  const [timeStr, setTimeStr] = useState<string | null>(null);
  const [customerFullName, setCustomerFullName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [wantAccountClaim, setWantAccountClaim] = useState(false);

  const [staffOptions, setStaffOptions] = useState<PublicBookingStaffOption[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<GuestBookingConfirmation | null>(null);

  // Turnstile token lifecycle is deliberately separate from the booking
  // idempotency key below: a token is single-use and must be replaced
  // after every submit attempt regardless of outcome (Cloudflare
  // invalidates it either way), while the idempotency key must survive
  // unchanged across a legitimate retry of the SAME booking attempt.
  // Bumping turnstileResetSignal forces the widget to issue a fresh
  // token; it never touches idempotencyKey.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);
  const handleTurnstileVerify = useCallback((token: string) => setTurnstileToken(token), []);
  const handleTurnstileExpire = useCallback(() => setTurnstileToken(null), []);

  const branch = branches.find((b) => b.id === branchId) ?? null;
  const service = branch?.services.find((s) => s.id === serviceId) ?? null;

  const todayStr = useMemo(() => getTenantTodayRangeUtc(tenantTimezone).today, [tenantTimezone]);
  const dateOptions = useMemo(
    () => Array.from({ length: PUBLIC_BOOKING_HORIZON_DAYS }, (_, i) => addDaysToDateStr(todayStr, i)),
    [todayStr],
  );

  // Regenerates only when the underlying selection actually changes, so a
  // failed-then-retried submit for the SAME selection reuses the same
  // key (retry-safe), while changing any earlier choice starts a fresh
  // attempt with a fresh key.
  const idempotencyKey = useMemo(
    () => (typeof crypto !== "undefined" ? crypto.randomUUID() : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps drive when to regenerate, not data the factory reads
    [branchId, serviceId, staffChoice, dateStr, timeStr],
  );

  function goTo(next: Step) {
    setStep(next);
  }
  function goNext() {
    const i = stepOrder.indexOf(step);
    if (i >= 0 && i < stepOrder.length - 1) goTo(stepOrder[i + 1]!);
  }
  function goBack() {
    const i = stepOrder.indexOf(step);
    if (i > 0) goTo(stepOrder[i - 1]!);
  }

  function selectBranch(id: string) {
    setBranchId(id);
    setServiceId(null);
    goNext();
  }

  function selectService(id: string) {
    setServiceId(id);
    setStaffChoice(null);
    goNext();
  }

  useEffect(() => {
    if (step !== "staff" || !branchId || !serviceId) return;
    // Deferred one tick so the initial setState doesn't run synchronously
    // within the effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => {
      setStaffLoading(true);
      fetchPublicEligibleStaff(tenantSlug, branchId, serviceId)
        .then(setStaffOptions)
        .finally(() => setStaffLoading(false));
    }, 0);
    return () => clearTimeout(timer);
  }, [step, tenantSlug, branchId, serviceId]);

  function selectStaff(choice: string | "any") {
    setStaffChoice(choice);
    goNext();
  }

  function selectDate(d: string) {
    setDateStr(d);
    setTimeStr(null);
    goTo("time");
  }

  useEffect(() => {
    if (step !== "time" || !branchId || !serviceId || !dateStr) return;
    // Deferred one tick — same reason as the staff-options effect above.
    const timer = setTimeout(() => {
      setSlotsLoading(true);
      fetchPublicAvailabilitySlots(
        tenantSlug,
        branchId,
        serviceId,
        dateStr,
        staffChoice === "any" ? null : staffChoice,
      )
        .then(setSlots)
        .finally(() => setSlotsLoading(false));
    }, 0);
    return () => clearTimeout(timer);
  }, [step, tenantSlug, branchId, serviceId, dateStr, staffChoice]);

  function selectTime(t: string) {
    setTimeStr(t);
    goNext();
  }

  const contactValid = customerFullName.trim().length > 0 && customerPhone.trim().length >= 7;
  const canSubmit = !!branchId && !!serviceId && !!dateStr && !!timeStr && contactValid && !!turnstileToken;

  async function submitBooking() {
    if (!branchId || !serviceId || !dateStr || !timeStr || !contactValid || !turnstileToken) return;
    setSubmitting(true);
    setSubmitError(null);

    const scheduledStartAtUtc = tenantLocalToUtcIso(dateStr, timeStr, tenantTimezone);
    const result = await submitGuestBookingAction({
      tenantSlug,
      branchId,
      serviceId,
      scheduledStartAtUtc,
      customerFullName: customerFullName.trim(),
      customerPhone: customerPhone.trim(),
      staffMemberId: staffChoice === "any" ? undefined : (staffChoice ?? undefined),
      customerEmail: customerEmail.trim() || undefined,
      wantAccountClaim,
      idempotencyKey,
      turnstileToken,
    });

    setSubmitting(false);
    // The token is single-use regardless of outcome — Cloudflare
    // invalidates it either way, so a fresh one is always needed before
    // the next attempt. This never touches idempotencyKey: a failed
    // attempt that the customer retries unchanged must still resolve to
    // the same booking, only with a new CAPTCHA proof attached to it.
    setTurnstileToken(null);
    setTurnstileResetSignal((n) => n + 1);

    if (!result.success) {
      setSubmitError(result.message);
      return;
    }
    setConfirmation(result.data);
    goTo("success");
  }

  function startOver() {
    setBranchId(singleBranch?.id ?? null);
    setServiceId(null);
    setStaffChoice(null);
    setDateStr(null);
    setTimeStr(null);
    setCustomerFullName("");
    setCustomerPhone("");
    setCustomerEmail("");
    setWantAccountClaim(false);
    setConfirmation(null);
    setSubmitError(null);
    goTo(stepOrder[0]!);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-6 sm:max-w-lg sm:py-10">
      <SalonContactHeader
        tenantName={tenantName}
        branch={branch}
        labels={{
          whatsapp: labels.contactWhatsapp,
          instagram: labels.contactInstagram,
          directions: labels.contactDirections,
        }}
      />

      {step !== "success" && <StepHeader current={step} steps={stepOrder} labels={labels} />}

      {step === "branch" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">{labels.chooseBranchTitle}</h1>
          <div className="flex flex-col gap-2">
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => selectBranch(b.id)}
                className="hover:border-primary hover:bg-primary/5 focus-visible:ring-ring rounded-xl border p-4 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="font-medium">{b.name}</div>
                {b.address && <div className="text-muted-foreground mt-0.5 text-sm">{b.address}</div>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "service" && branch && (
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">{labels.chooseServiceTitle}</h1>
          <div className="flex flex-col gap-2">
            {branch.services.map((s: PublicBookingService) => (
              <button
                key={s.id}
                type="button"
                onClick={() => selectService(s.id)}
                className="hover:border-primary hover:bg-primary/5 focus-visible:ring-ring rounded-xl border p-4 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="font-medium">{s.name}</div>
                {s.category && <div className="text-muted-foreground mt-0.5 text-sm">{s.category}</div>}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === "staff" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">{labels.chooseStaffTitle}</h1>
          {staffLoading ? (
            <p className="text-muted-foreground text-sm">…</p>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => selectStaff("any")}
                className="hover:border-primary hover:bg-primary/5 focus-visible:ring-ring rounded-xl border p-4 text-left font-medium focus-visible:ring-2 focus-visible:outline-none"
              >
                {labels.anyStaff}
              </button>
              {staffOptions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => selectStaff(s.id)}
                  className="hover:border-primary hover:bg-primary/5 focus-visible:ring-ring rounded-xl border p-4 text-left font-medium focus-visible:ring-2 focus-visible:outline-none"
                >
                  {s.fullName}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === "date" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">{labels.chooseDateTitle}</h1>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
            {dateOptions.map((d) => {
              const [, m, day] = d.split("-") as [string, string, string];
              const weekday = WEEKDAY_LABELS_TR[new Date(`${d}T00:00:00Z`).getUTCDay()];
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => selectDate(d)}
                  className="hover:border-primary hover:bg-primary/5 focus-visible:ring-ring flex flex-col items-center gap-0.5 rounded-lg border p-2 focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="text-muted-foreground text-[10px] font-medium">{d === todayStr ? labels.todayLabel : weekday}</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {day}.{m}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {step === "time" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-lg font-semibold">{labels.chooseTimeTitle}</h1>
          {slotsLoading ? (
            <p className="text-muted-foreground text-sm">{labels.loadingSlots}</p>
          ) : slots.length === 0 ? (
            <p className="text-muted-foreground text-sm">{labels.noSlotsForDate}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => selectTime(t)}
                  className="hover:border-primary hover:bg-primary/5 focus-visible:ring-ring rounded-lg border p-2 text-center text-sm font-medium tabular-nums focus-visible:ring-2 focus-visible:outline-none"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === "contact" && (
        <section className="flex flex-col gap-4">
          <h1 className="text-lg font-semibold">{labels.contactTitle}</h1>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pb-name">{labels.fullNameLabel}</Label>
            <Input id="pb-name" value={customerFullName} onChange={(e) => setCustomerFullName(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pb-phone">{labels.phoneLabel}</Label>
            <Input id="pb-phone" type="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pb-email">{labels.emailLabel}</Label>
            <Input id="pb-email" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
          </div>
          {!isAuthenticated && customerEmail.trim().length > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={wantAccountClaim} onCheckedChange={() => setWantAccountClaim((v) => !v)} className="mt-0.5" />
              {labels.claimOptInLabel}
            </label>
          )}
          <Button type="button" disabled={!contactValid} onClick={goNext}>
            {labels.next}
          </Button>
        </section>
      )}

      {step === "confirm" && branch && service && dateStr && timeStr && (
        <section className="flex flex-col gap-4">
          <h1 className="text-lg font-semibold">{labels.summaryTitle}</h1>
          <div className="flex flex-col gap-2 rounded-xl border p-4 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryBranch}</span>
              <span className="font-medium">{branch.name}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryService}</span>
              <span className="font-medium">{service.name}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryStaff}</span>
              <span className="font-medium">
                {staffChoice === "any" ? labels.anyStaff : staffOptions.find((s) => s.id === staffChoice)?.fullName}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryDateTime}</span>
              <span className="font-medium tabular-nums">
                {dateStr} {timeStr}
              </span>
            </div>
          </div>
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            onVerify={handleTurnstileVerify}
            onExpire={handleTurnstileExpire}
            resetSignal={turnstileResetSignal}
          />
          {submitError && (
            <p className="text-destructive text-sm" role="alert">
              {submitError}
            </p>
          )}
          <Button type="button" disabled={submitting || !canSubmit} onClick={submitBooking}>
            {submitting ? labels.submitting : labels.submit}
          </Button>
        </section>
      )}

      {step === "success" && confirmation && (
        <section className="flex flex-col items-center gap-3 py-8 text-center">
          <h1 className="text-xl font-semibold">{labels.confirmedTitle}</h1>
          <p className="text-muted-foreground text-sm">{labels.confirmedBody}</p>
          {confirmation.claimIssued && (
            <p className="bg-muted rounded-lg px-3 py-2 text-sm">{labels.claimPendingNote}</p>
          )}
          <div className="mt-2 flex w-full flex-col gap-2 rounded-xl border p-4 text-left text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryBranch}</span>
              <span className="font-medium">{confirmation.branchName}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryService}</span>
              <span className="font-medium">{confirmation.serviceName}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryStaff}</span>
              <span className="font-medium">{confirmation.staffName}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{labels.summaryDateTime}</span>
              <span className="font-medium tabular-nums">
                {formatTenantLocalDateTime(confirmation.scheduledStartAt, confirmation.tenantTimezone)}
              </span>
            </div>
            <div className="border-t pt-2">
              <span className="text-muted-foreground text-xs">{labels.confirmationReference}</span>
              <div className="font-mono text-xs break-all">{confirmation.appointmentReference}</div>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={startOver} className="mt-2">
            {labels.newBooking}
          </Button>
        </section>
      )}

      {step !== "success" && (
        <div className="mt-1 flex items-center justify-between">
          {stepOrder.indexOf(step) > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={goBack}>
              {labels.back}
            </Button>
          ) : (
            <Button render={<Link href="/" />} nativeButton={false} type="button" variant="ghost" size="sm">
              {labels.backHome}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
