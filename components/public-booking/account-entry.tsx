"use client";

import { useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Faz ACC.1A — the public booking page's account-entry surface. Two
 * mutually exclusive states, chosen entirely by the server-derived
 * isAuthenticated prop (never re-derived here):
 *
 * - Unauthenticated: a compact choice card ("Hesabımla devam et" /
 *   "Üye olmadan devam et"). Guest is never blocked by this card — it
 *   is a plain informational surface above a wizard that already works
 *   without it; dismissing it (or just ignoring it and scrolling past)
 *   has the exact same effect on the booking flow. No new auth system:
 *   the account button is a plain link into the EXISTING customer
 *   magic-link flow (/account/login?next=...), which already means
 *   "sign in if this email has an account, create one otherwise" (see
 *   requestAccountMagicLinkAction's own header) — nothing here decides
 *   sign-in vs. sign-up, and nothing here could, since the server never
 *   reveals which one a given email would be (enumeration-safety).
 *
 * - Authenticated: a compact identity line + a link to /account. No
 *   auth id, no account UUID, no email is rendered here — only the
 *   display name the server already resolved (profileName), which may
 *   itself be null (see booking-wizard.tsx's own prefill comment for
 *   why a null full name is common and not an error state).
 *
 * The salon-assisted "link an existing record" entry point is folded in
 * here too, as the small secondary link the spec asks for — same
 * destination as before (/account/link-salon/[tenantSlug]), just no
 * longer presented as if it were the primary login/signup CTA.
 */
export function AccountEntry({
  tenantSlug,
  tenantName,
  isAuthenticated,
  profileName,
  labels,
}: {
  tenantSlug: string;
  tenantName: string;
  isAuthenticated: boolean;
  profileName: string | null;
  labels: {
    accountChoiceTitle: string;
    accountOptionTitle: string;
    accountOptionBody: string;
    guestOptionTitle: string;
    guestOptionBody: string;
    accountChoiceNote: string;
    authenticatedGreeting: string;
    authenticatedBookingFor: string;
    myAccountLink: string;
    linkExistingRecord: string;
  };
}) {
  const [dismissed, setDismissed] = useState(false);
  const accountHref = `/account/login?next=${encodeURIComponent(`/book/${tenantSlug}`)}`;

  if (isAuthenticated) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-1 px-4 pt-4 sm:max-w-lg">
        <p className="text-sm font-medium">
          {profileName ? labels.authenticatedGreeting.replace("{name}", profileName) : labels.myAccountLink}
        </p>
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">
            {labels.authenticatedBookingFor.replace("{tenantName}", tenantName)}
          </p>
          <Button render={<Link href="/account" />} nativeButton={false} variant="link" size="sm" className="h-auto p-0 text-xs">
            {labels.myAccountLink}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-2 px-4 pt-4 sm:max-w-lg">
      {!dismissed && (
        <Card size="sm">
          <CardContent className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">{labels.accountChoiceTitle}</h2>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button render={<Link href={accountHref} />} nativeButton={false} variant="default" className="h-auto flex-1 flex-col items-start gap-0.5 py-2 text-left whitespace-normal">
                <span className="text-sm font-medium">{labels.accountOptionTitle}</span>
                <span className="text-xs font-normal opacity-80">{labels.accountOptionBody}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto flex-1 flex-col items-start gap-0.5 py-2 text-left whitespace-normal"
                onClick={() => setDismissed(true)}
              >
                <span className="text-sm font-medium">{labels.guestOptionTitle}</span>
                <span className="text-muted-foreground text-xs font-normal">{labels.guestOptionBody}</span>
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{labels.accountChoiceNote}</p>
          </CardContent>
        </Card>
      )}
      <Button
        render={<Link href={`/account/link-salon/${tenantSlug}`} />}
        nativeButton={false}
        variant="link"
        size="sm"
        className="h-auto self-start p-0 text-xs"
      >
        {labels.linkExistingRecord}
      </Button>
    </div>
  );
}
