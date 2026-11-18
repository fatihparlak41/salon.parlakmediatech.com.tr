"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { prepareTenantExportAction, type PrepareExportResult } from "@/lib/modules/export/actions";

export type ExportPanelStatus = {
  remaining: number;
  limit: number;
  lastExportLabel: string | null;
  nextAvailableLabel: string | null;
  inProgress: boolean;
};

/**
 * Faz SAAS.1C.2b - the Owner's export screen body. The page already refused everyone who is not an Owner; the database refuses again on every call.
 * The raw download token only ever lives in this component's state for the instant it takes to submit the hidden POST form (it is never put in a URL).
 */
export function TenantExportPanel({ tenantSlug, status }: { tenantSlug: string; status: ExportPanelStatus }) {
  const t = useTranslations("Export");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<Exclude<PrepareExportResult, { ok: true }>["error"] | null>(null);
  const [started, setStarted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const blocked = status.remaining <= 0 || status.inProgress;

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await prepareTenantExportAction(tenantSlug);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // The token never goes through React state (a state-driven value is not in the DOM yet when a timer fires - found in the hosted browser test:
      // the form was posted with an EMPTY token). It is written straight into the hidden input, posted synchronously, and cleared in the same tick.
      const form = formRef.current;
      const input = tokenRef.current;
      if (!form || !input) {
        setError("unexpected");
        return;
      }
      input.value = result.token;
      form.submit();
      input.value = "";
      setStarted(true);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-1 rounded-lg border p-4 text-sm">
        <h2 className="font-medium">{t("scopeHeading")}</h2>
        <p className="text-muted-foreground">{t("scopeBody")}</p>
        <h2 className="mt-3 font-medium">{t("notIncludedHeading")}</h2>
        <p className="text-muted-foreground">{t("notIncludedBody")}</p>
      </section>

      <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        {t("piiWarning")}
      </p>
      <p className="text-muted-foreground text-sm">{t("freshLoginNote")}</p>

      <div className="flex flex-col gap-1 text-sm">
        <p>{status.lastExportLabel ? t("lastExport", { date: status.lastExportLabel }) : t("neverExported")}</p>
        <p>{status.remaining > 0 ? t("quota", { remaining: status.remaining, limit: status.limit }) : t("quotaNext", { date: status.nextAvailableLabel ?? "-" })}</p>
        {status.inProgress ? <p>{t("inProgress")}</p> : null}
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {t(`errors.${error}`)}{" "}
          {error === "fresh_auth_required" || error === "unauthenticated" ? (
            <a className="underline" href={`/login?next=${encodeURIComponent(`/app/${tenantSlug}/export`)}`}>
              {t("relogin")}
            </a>
          ) : null}
        </p>
      ) : null}
      {started ? <p role="status" className="text-sm">{t("started")}</p> : null}

      <div>
        <button type="button" onClick={start} disabled={pending || blocked} className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50">
          {pending ? t("preparing") : t("start")}
        </button>
      </div>

      {/* POST, token in the body: never in a URL, a log line or a Referer */}
      <form ref={formRef} method="post" action="/api/tenant-export" className="hidden" aria-hidden="true">
        <input ref={tokenRef} type="hidden" name="token" defaultValue="" />
      </form>
    </div>
  );
}
