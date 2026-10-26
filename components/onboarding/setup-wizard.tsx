"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/lib/i18n/navigation";
import { CheckCircle2, Circle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateOnlineBookingSettingAction } from "@/lib/modules/settings/actions";
import {
  addServicesAction,
  addStaffAction,
  applyWeeklyHoursAction,
  saveSalonProfileAction,
  setStaffServicesAction,
  type StepResult,
} from "@/lib/modules/onboarding/actions";
import {
  WEEK_ORDER,
  copyDay,
  currentStepKey,
  defaultWeek,
  parseServiceLines,
  parseStaffLines,
  stepProgress,
  weekToRows,
  type DayHours,
  type OnboardingBlocker,
  type OnboardingStatus,
  type OnboardingStepKey,
  type ServiceRow,
} from "@/lib/modules/onboarding/model";
import { SUPPORTED_CURRENCIES } from "@/lib/modules/onboarding/schemas";
import type { OnboardingWorkspace } from "@/lib/modules/onboarding/queries";
import type { ActionResult } from "@/lib/errors";

export type SetupWizardProps = {
  tenantId: string;
  tenantSlug: string;
  bookingUrl: string;
  dashboardHref: string;
  initialStatus: OnboardingStatus;
  workspace: OnboardingWorkspace;
  firstSlotLabel: string | null;
  /** which steps this caller may perform (the database re-checks every one) */
  can: { profile: boolean; services: boolean; staff: boolean; hours: boolean; booking: boolean };
};

const BLOCKER_STEP: Record<OnboardingBlocker, OnboardingStepKey | null> = {
  tenant_inactive: null,
  salon_profile_missing: "profile",
  no_working_hours: "hours",
  no_services: "services",
  no_staff: "staff",
  no_bookable_staff: "mapping",
  public_booking_disabled: "booking",
  no_available_slot: "hours",
};

const selectClass =
  "border-input bg-background h-8 w-full rounded-lg border px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  ) : null;
}

export function SetupWizard(props: SetupWizardProps) {
  const t = useTranslations("Setup");
  const router = useRouter();
  const [status, setStatus] = useState(props.initialStatus);
  const [active, setActive] = useState<OnboardingStepKey>(currentStepKey(props.initialStatus));
  const [notice, setNotice] = useState<string | null>(null);

  // A refresh (router.refresh after any save) hands in a fresh server answer; it is the truth, local state follows it.
  const [syncedFrom, setSyncedFrom] = useState(props.initialStatus);
  if (syncedFrom !== props.initialStatus) {
    setSyncedFrom(props.initialStatus);
    setStatus(props.initialStatus);
  }

  // A step form seeds its fields from the workspace once. When a save changes the workspace (the refresh arrives a
  // moment after the step switch), the form must be re-seeded, so each is keyed by the facts it was seeded from.
  const profileKey = `${status.profile.name}|${status.profile.phone}|${status.profile.timezone}|${status.profile.currency}|${props.workspace.branch.address}`;
  const hoursKey = props.workspace.staff.map((st) => `${st.id}:${st.hasHours ? 1 : 0}`).join(",");
  const mappingKey = `${props.workspace.staff.map((st) => st.id).join(",")}|${props.workspace.services.map((sv) => sv.id).join(",")}|${props.workspace.pairs.join(",")}`;

  const progress = stepProgress(status);

  function applyResult(result: StepResult) {
    setStatus(result.status);
    setActive(currentStepKey(result.status));
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        <div className="mt-2 flex items-center gap-3">
          <div
            className="bg-muted h-2 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <div className="bg-primary h-full transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <span className="text-muted-foreground text-xs tabular-nums">{t("progress", { done: progress.done, total: progress.total })}</span>
        </div>
      </header>

      <ol className="flex flex-col gap-2" aria-label={t("title")}>
        {status.steps.map((step) => {
          const isActive = active === step.key;
          return (
            <li key={step.key} className="rounded-lg border">
              <button
                type="button"
                className="flex w-full items-center gap-3 p-4 text-left"
                aria-expanded={isActive}
                onClick={() => {
                  setNotice(null);
                  setActive(step.key);
                }}
              >
                {step.done ? (
                  <CheckCircle2 className="size-5 shrink-0 text-emerald-600" aria-hidden />
                ) : (
                  <Circle className="text-muted-foreground size-5 shrink-0" aria-hidden />
                )}
                <span className="flex-1 text-sm font-medium">{t(`steps.${step.key}`)}</span>
                <span className="text-muted-foreground text-xs">{step.done ? t("done") : t("todo")}</span>
              </button>
              {isActive ? (
                <div className="border-t p-4">
                  {notice ? <p className="mb-3 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
                  {step.key === "profile" ? <ProfileStep key={profileKey} {...props} status={status} onDone={applyResult} /> : null}
                  {step.key === "services" ? <ServicesStep {...props} onDone={(r, msg) => (setNotice(msg), applyResult(r))} /> : null}
                  {step.key === "staff" ? <StaffStep {...props} onDone={(r, msg) => (setNotice(msg), applyResult(r))} /> : null}
                  {step.key === "hours" ? <HoursStep key={hoursKey} {...props} onDone={applyResult} /> : null}
                  {step.key === "mapping" ? <MappingStep key={mappingKey} {...props} onDone={applyResult} /> : null}
                  {step.key === "booking" ? <BookingStep {...props} status={status} onChanged={() => router.refresh()} /> : null}
                  {step.key === "ready" ? <ReadyStep {...props} status={status} onGo={setActive} /> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <aside className="bg-muted/40 rounded-lg border p-4">
        <p className="text-sm font-medium">{t("later.title")}</p>
        <p className="text-muted-foreground mt-1 text-sm">{t("later.body")}</p>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Shared: run one action, show the pending state and the (already user-safe) error
// ---------------------------------------------------------------------------------------------------------------

function useStep(onDone: (result: StepResult) => void) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(call: () => Promise<ActionResult<StepResult>>, after?: (result: StepResult) => void) {
    setError(null);
    startTransition(async () => {
      const result = await call();
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      after?.(result.data);
      onDone(result.data);
    });
  }
  return { pending, error, setError, run };
}

function Denied({ allowed, children }: { allowed: boolean; children: React.ReactNode }) {
  const t = useTranslations("Setup");
  if (allowed) return <>{children}</>;
  return <p className="text-muted-foreground text-sm">{t("noPermission")}</p>;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Salon information
// ---------------------------------------------------------------------------------------------------------------

function ProfileStep(props: SetupWizardProps & { status: OnboardingStatus; onDone: (r: StepResult) => void }) {
  const t = useTranslations("Setup.profile");
  const ts = useTranslations("Setup");
  const { profile } = props.status;
  const [name, setName] = useState(profile.name);
  const [phone, setPhone] = useState(profile.phone ?? props.workspace.branch.phone);
  const [address, setAddress] = useState(props.workspace.branch.address);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [currency, setCurrency] = useState(profile.currency);
  const { pending, error, run } = useStep(props.onDone);
  const knownZone = timezone === "Europe/Istanbul" || timezone === "Asia/Nicosia";

  return (
    <Denied allowed={props.can.profile}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => saveSalonProfileAction(null, { tenantId: props.tenantId, tenantSlug: props.tenantSlug, name, phone, address, timezone, currency }));
        }}
      >
        <p className="text-muted-foreground text-sm">{t("intro")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-name">{t("name")}</Label>
            <Input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-phone">{t("phone")}</Label>
            <Input id="setup-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            <span className="text-muted-foreground text-xs">{t("phoneHint")}</span>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="setup-address">{t("address")}</Label>
            <Input id="setup-address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={500} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-tz">{t("timezone")}</Label>
            <select id="setup-tz" className={selectClass} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <option value="Europe/Istanbul">{t("tzIstanbul")}</option>
              <option value="Asia/Nicosia">{t("tzNicosia")}</option>
              {knownZone ? null : <option value={timezone}>{t("tzOther", { zone: timezone })}</option>}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-currency">{t("currency")}</Label>
            <select id="setup-currency" className={selectClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ErrorLine message={error} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? ts("saving") : t("save")}
          </Button>
        </div>
      </form>
    </Denied>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Services: grid rows + paste
// ---------------------------------------------------------------------------------------------------------------

const EMPTY_SERVICE: ServiceRow = { name: "", category: "", durationMinutes: "", price: "" };

function ServicesStep(props: SetupWizardProps & { onDone: (r: StepResult, message: string) => void }) {
  const t = useTranslations("Setup.services");
  const ts = useTranslations("Setup");
  const [rows, setRows] = useState<ServiceRow[]>([{ ...EMPTY_SERVICE }, { ...EMPTY_SERVICE }, { ...EMPTY_SERVICE }]);
  const [paste, setPaste] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const { pending, error, run } = useStep(() => undefined);

  const update = (index: number, patch: Partial<ServiceRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  function submit() {
    const filled = rows.filter((r) => r.name.trim() || r.durationMinutes.trim() || r.price.trim());
    if (filled.length === 0) {
      setLocalError(t("nothing"));
      return;
    }
    setLocalError(null);
    run(
      () => addServicesAction(null, { tenantId: props.tenantId, tenantSlug: props.tenantSlug, items: filled }),
      (result) => {
        const created = result.created ?? 0;
        const skipped = result.skipped ?? 0;
        setRows([{ ...EMPTY_SERVICE }, { ...EMPTY_SERVICE }, { ...EMPTY_SERVICE }]);
        props.onDone(result, skipped > 0 ? t("savedSkipped", { created, skipped }) : t("saved", { created }));
      },
    );
  }

  return (
    <Denied allowed={props.can.services}>
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("intro")}</p>
        {props.workspace.services.length > 0 ? (
          <div>
            <p className="text-sm font-medium">{t("existing", { count: props.workspace.services.length })}</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {props.workspace.services.map((s) => (
                <li key={s.id} className="bg-muted rounded-full px-2.5 py-0.5 text-xs">
                  {s.name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="text-muted-foreground hidden grid-cols-[1fr_1.4fr_5rem_6rem_2rem] gap-2 text-xs sm:grid">
            <span>{t("category")}</span>
            <span>{t("name")}</span>
            <span>{t("duration")}</span>
            <span>{t("price")}</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.4fr_5rem_6rem_2rem]">
              <Input aria-label={t("category")} placeholder={t("category")} value={row.category} onChange={(e) => update(index, { category: e.target.value })} maxLength={100} />
              <Input aria-label={t("name")} placeholder={t("name")} value={row.name} onChange={(e) => update(index, { name: e.target.value })} maxLength={200} />
              <Input aria-label={t("duration")} placeholder={t("duration")} inputMode="numeric" value={row.durationMinutes} onChange={(e) => update(index, { durationMinutes: e.target.value })} />
              <Input aria-label={t("price")} placeholder={t("price")} inputMode="decimal" value={row.price} onChange={(e) => update(index, { price: e.target.value })} />
              <Button type="button" variant="ghost" size="icon" aria-label={t("removeRow")} onClick={() => setRows((c) => (c.length > 1 ? c.filter((_, i) => i !== index) : c))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((c) => [...c, { ...EMPTY_SERVICE }])}>
              <Plus /> {t("addRow")}
            </Button>
          </div>
        </div>

        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">{t("pasteTitle")}</summary>
          <p className="text-muted-foreground mt-2 text-xs">{t("pasteHint")}</p>
          <Textarea className="mt-2 min-h-28" value={paste} onChange={(e) => setPaste(e.target.value)} aria-label={t("pasteTitle")} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => {
              const parsed = parseServiceLines(paste);
              if (parsed.length === 0) return;
              setRows((current) => [...current.filter((r) => r.name.trim() || r.price.trim() || r.durationMinutes.trim()), ...parsed]);
              setPaste("");
            }}
          >
            {t("pasteButton")}
          </Button>
        </details>

        <ErrorLine message={localError ?? error} />
        <div>
          <Button type="button" disabled={pending} onClick={submit}>
            {pending ? ts("saving") : t("save")}
          </Button>
        </div>
      </div>
    </Denied>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Staff roster (no login, no invitation)
// ---------------------------------------------------------------------------------------------------------------

function StaffStep(props: SetupWizardProps & { onDone: (r: StepResult, message: string) => void }) {
  const t = useTranslations("Setup.staff");
  const ts = useTranslations("Setup");
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const { pending, error, run } = useStep(() => undefined);

  function submit() {
    const items = parseStaffLines(text);
    if (items.length === 0) {
      setLocalError(t("pasteHint"));
      return;
    }
    setLocalError(null);
    run(
      () => addStaffAction(null, { tenantId: props.tenantId, tenantSlug: props.tenantSlug, items }),
      (result) => {
        const created = result.created ?? 0;
        const skipped = result.skipped ?? 0;
        setText("");
        props.onDone(result, skipped > 0 ? t("savedSkipped", { created, skipped }) : t("saved", { created }));
      },
    );
  }

  return (
    <Denied allowed={props.can.staff}>
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("intro")}</p>
        {props.workspace.staff.length > 0 ? (
          <div>
            <p className="text-sm font-medium">{t("existing", { count: props.workspace.staff.length })}</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {props.workspace.staff.map((s) => (
                <li key={s.id} className="bg-muted rounded-full px-2.5 py-0.5 text-xs">
                  {s.fullName}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="setup-staff-lines">{t("pasteHint")}</Label>
          <Textarea id="setup-staff-lines" className="min-h-28" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <ErrorLine message={localError ?? error} />
        <div>
          <Button type="button" disabled={pending} onClick={submit}>
            {pending ? ts("saving") : t("save")}
          </Button>
        </div>
      </div>
    </Denied>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Weekly hours: one template, applied to chosen staff
// ---------------------------------------------------------------------------------------------------------------

function HoursStep(props: SetupWizardProps & { onDone: (r: StepResult) => void }) {
  const t = useTranslations("Setup.hours");
  const ts = useTranslations("Setup");
  const [week, setWeek] = useState<Record<number, DayHours>>(() => defaultWeek());
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(props.workspace.staff.filter((s) => !s.hasHours).map((s) => s.id)),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const { pending, error, run } = useStep(props.onDone);

  const setDay = (weekday: number, patch: Partial<DayHours>) =>
    setWeek((current) => ({ ...current, [weekday]: { ...current[weekday]!, ...patch } }));

  function submit() {
    const built = weekToRows(week);
    if ("error" in built) {
      setLocalError(built.error === "time" ? t("errTime") : built.error === "order" ? t("errOrder") : t("errBreak"));
      return;
    }
    if (built.rows.length === 0) {
      setLocalError(t("errNoDays"));
      return;
    }
    setLocalError(null);
    run(() =>
      applyWeeklyHoursAction(null, { tenantId: props.tenantId, tenantSlug: props.tenantSlug, staffIds: [...selected], days: built.rows }),
    );
  }

  if (props.workspace.staff.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("noStaff")}</p>;
  }

  return (
    <Denied allowed={props.can.hours}>
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("intro")}</p>
        <div className="flex flex-col gap-2">
          {WEEK_ORDER.map(({ weekday, key }) => {
            const day = week[weekday]!;
            return (
              <div key={weekday} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
                <label className="flex w-40 items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="size-4" checked={day.open} onChange={(e) => setDay(weekday, { open: e.target.checked })} />
                  {t(`days.${key}`)}
                </label>
                {day.open ? (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <Input type="time" aria-label={`${t(`days.${key}`)} ${t("from")}`} className="w-28" value={day.start} onChange={(e) => setDay(weekday, { start: e.target.value })} />
                    <span aria-hidden>–</span>
                    <Input type="time" aria-label={`${t(`days.${key}`)} ${t("to")}`} className="w-28" value={day.end} onChange={(e) => setDay(weekday, { end: e.target.value })} />
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" className="size-4" checked={day.breakEnabled} onChange={(e) => setDay(weekday, { breakEnabled: e.target.checked })} />
                      {t("break")}
                    </label>
                    {day.breakEnabled ? (
                      <>
                        <Input type="time" aria-label={`${t(`days.${key}`)} ${t("break")} ${t("from")}`} className="w-28" value={day.breakStart} onChange={(e) => setDay(weekday, { breakStart: e.target.value })} />
                        <span aria-hidden>–</span>
                        <Input type="time" aria-label={`${t(`days.${key}`)} ${t("break")} ${t("to")}`} className="w-28" value={day.breakEnd} onChange={(e) => setDay(weekday, { breakEnd: e.target.value })} />
                      </>
                    ) : null}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">{t("closed")}</span>
                )}
              </div>
            );
          })}
          <div className="flex flex-col gap-1">
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setWeek((w) => copyDay(w, 1, [2, 3, 4, 5, 6]))}>
                {t("copyMonday")}
              </Button>
            </div>
            <span className="text-muted-foreground text-xs">{t("copyHint")}</span>
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t("staff")}</legend>
          <p className="text-muted-foreground text-xs">{t("staffHint")}</p>
          {props.workspace.staff.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={selected.has(s.id)}
                onChange={(e) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    return next;
                  })
                }
              />
              {s.fullName}
              {s.hasHours ? <span className="text-muted-foreground text-xs">({t("hasHours")})</span> : null}
            </label>
          ))}
        </fieldset>

        <ErrorLine message={localError ?? error} />
        <div>
          <Button type="button" disabled={pending || selected.size === 0} onClick={submit}>
            {pending ? ts("saving") : t("save")}
          </Button>
        </div>
      </div>
    </Denied>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Staff x service matrix
// ---------------------------------------------------------------------------------------------------------------

function MappingStep(props: SetupWizardProps & { onDone: (r: StepResult) => void }) {
  const t = useTranslations("Setup.mapping");
  const ts = useTranslations("Setup");
  const { staff, services } = props.workspace;
  const [pairs, setPairs] = useState<Set<string>>(() => new Set(props.workspace.pairs));
  const { pending, error, run } = useStep(props.onDone);

  if (staff.length === 0 || services.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("needBoth")}</p>;
  }

  const toggle = (key: string, on: boolean) =>
    setPairs((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <Denied allowed={props.can.staff}>
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("intro")}</p>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPairs(new Set(staff.flatMap((st) => services.map((sv) => `${st.id}:${sv.id}`))))}
          >
            {t("everyone")}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left font-medium" scope="col" />
                {services.map((sv) => (
                  <th key={sv.id} scope="col" className="p-2 text-left text-xs font-medium whitespace-nowrap">
                    {sv.name}
                  </th>
                ))}
                <th scope="col" className="p-2" />
              </tr>
            </thead>
            <tbody>
              {staff.map((st) => {
                const rowKeys = services.map((sv) => `${st.id}:${sv.id}`);
                const allOn = rowKeys.every((k) => pairs.has(k));
                return (
                  <tr key={st.id} className="border-t">
                    <th scope="row" className="p-2 text-left font-medium whitespace-nowrap">
                      {st.fullName}
                    </th>
                    {services.map((sv) => {
                      const key = `${st.id}:${sv.id}`;
                      return (
                        <td key={sv.id} className="p-2">
                          <input
                            type="checkbox"
                            className="size-4"
                            aria-label={`${st.fullName} – ${sv.name}`}
                            checked={pairs.has(key)}
                            onChange={(e) => toggle(key, e.target.checked)}
                          />
                        </td>
                      );
                    })}
                    <td className="p-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setPairs((current) => {
                            const next = new Set(current);
                            for (const k of rowKeys) {
                              if (allOn) next.delete(k);
                              else next.add(k);
                            }
                            return next;
                          })
                        }
                      >
                        {t("rowAll")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ErrorLine message={error} />
        <div>
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              run(() =>
                setStaffServicesAction(null, {
                  tenantId: props.tenantId,
                  tenantSlug: props.tenantSlug,
                  assignments: staff.map((st) => ({
                    staffId: st.id,
                    serviceIds: services.filter((sv) => pairs.has(`${st.id}:${sv.id}`)).map((sv) => sv.id),
                  })),
                }),
              )
            }
          >
            {pending ? ts("saving") : t("save")}
          </Button>
        </div>
      </div>
    </Denied>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 6. Online booking switch (the existing action, nothing new)
// ---------------------------------------------------------------------------------------------------------------

function BookingStep(props: SetupWizardProps & { status: OnboardingStatus; onChanged: () => void }) {
  const t = useTranslations("Setup.booking");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Denied allowed={props.can.booking}>
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">{t("intro")}</p>
        <p className="text-sm font-medium">{props.status.onlineBookingEnabled ? t("enabled") : t("disabled")}</p>
        {props.status.onlineBookingEnabled ? null : (
          <div>
            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await updateOnlineBookingSettingAction(null, { tenantId: props.tenantId, tenantSlug: props.tenantSlug, enabled: true });
                  if (!result.success) {
                    setError(result.error.message);
                    return;
                  }
                  props.onChanged();
                });
              }}
            >
              {pending ? t("enabling") : t("enable")}
            </Button>
          </div>
        )}
        <ErrorLine message={error} />
      </div>
    </Denied>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 7. Ready (or exactly what is still missing)
// ---------------------------------------------------------------------------------------------------------------

function ReadyStep(props: SetupWizardProps & { status: OnboardingStatus; onGo: (key: OnboardingStepKey) => void }) {
  const t = useTranslations("Setup.ready");
  const tb = useTranslations("Setup.blockers");
  const [copied, setCopied] = useState(false);

  if (props.status.ready) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-base font-semibold text-emerald-700 dark:text-emerald-400">{t("title")}</p>
        <p className="text-muted-foreground text-sm">{t("body")}</p>
        <code className="bg-muted block overflow-x-auto rounded-md px-3 py-2 text-sm">{props.bookingUrl}</code>
        {props.firstSlotLabel ? <p className="text-sm">{t("firstSlot", { when: props.firstSlotLabel })}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(props.bookingUrl);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? t("copied") : t("copy")}
          </Button>
          <a
            href={props.bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="border-border bg-background hover:bg-muted inline-flex h-8 items-center rounded-lg border px-2.5 text-sm font-medium"
          >
            {t("open")}
          </a>
          <a href={props.dashboardHref} className="bg-primary text-primary-foreground hover:bg-primary/80 inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium">
            {t("dashboard")}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-semibold">{t("notReady")}</p>
      <p className="text-muted-foreground text-sm">{t("notReadyBody")}</p>
      <ul className="flex flex-col gap-2">
        {props.status.blockers.map((blocker) => {
          const step = BLOCKER_STEP[blocker];
          return (
            <li key={blocker} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span>{tb(blocker)}</span>
              {step ? (
                <Button type="button" variant="outline" size="xs" onClick={() => props.onGo(step)}>
                  {t("fix")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
