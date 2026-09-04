import { AtSign, MessageCircle, Navigation } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toInstagramUrl, toWhatsappUrl } from "@/lib/modules/branches/normalize";
import type { PublicBookingBranch } from "@/lib/modules/public-booking/client-queries";

/**
 * Faz 2I.2F (Batch A) — compact, owner-managed salon identity block
 * shown above the booking wizard. Deliberately minimal: salon name,
 * branch address, and up to 3 outline-button links — never a marketing
 * page, never price/duration/capacity. `branch` is `null` on a
 * multi-branch tenant's "choose a branch" step (booking-wizard.tsx
 * passes its own `branch` lookup straight through) so the address and
 * contact actions genuinely wait for a branch to be selected, per spec;
 * a single-branch tenant has `branch` set from the very first render,
 * so its identity block is complete immediately. Only a configured
 * field renders its button — no placeholder/disabled states.
 */
export function SalonContactHeader({
  tenantName,
  branch,
  labels,
}: {
  tenantName: string;
  branch: PublicBookingBranch | null;
  labels: { whatsapp: string; instagram: string; directions: string };
}) {
  const hasAnyAction = !!branch && (branch.whatsappPhone || branch.instagramHandle || branch.locationUrl);

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <Badge variant="secondary" className="mx-auto h-6 px-2.5 text-sm font-semibold">
        {tenantName}
      </Badge>
      {branch?.address && <p className="text-muted-foreground text-sm">{branch.address}</p>}
      {hasAnyAction && (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {branch!.whatsappPhone && (
            <Button
              render={<a href={toWhatsappUrl(branch!.whatsappPhone)} target="_blank" rel="noopener noreferrer" />}
              nativeButton={false}
              type="button"
              variant="outline"
              size="sm"
            >
              <MessageCircle /> {labels.whatsapp}
            </Button>
          )}
          {branch!.instagramHandle && (
            <Button
              render={<a href={toInstagramUrl(branch!.instagramHandle)} target="_blank" rel="noopener noreferrer" />}
              nativeButton={false}
              type="button"
              variant="outline"
              size="sm"
            >
              <AtSign /> {labels.instagram}
            </Button>
          )}
          {branch!.locationUrl && (
            <Button
              render={<a href={branch!.locationUrl} target="_blank" rel="noopener noreferrer" />}
              nativeButton={false}
              type="button"
              variant="outline"
              size="sm"
            >
              <Navigation /> {labels.directions}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
