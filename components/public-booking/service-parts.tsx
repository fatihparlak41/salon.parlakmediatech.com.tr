import { AtSign, MessageCircle, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toInstagramUrl, toWhatsappUrl } from "@/lib/modules/branches/normalize";
import type { PublicBookingBranch, PublicBookingService } from "@/lib/modules/public-booking/client-queries";
import { durationLine, hasServiceInfo, isDirectlyBookable, priceLine } from "@/lib/modules/public-booking/service-presentation";

/**
 * Faz BEAUTY.1A - the public surfaces of ONE service: the card in the list, the information panel, the inquiry contact
 * actions. Rendering only; every decision (price wording, duration range, bookable or not) comes from service-presentation.ts.
 * Progressive disclosure: the card carries the name, an optional badge, one summary line and "price · duration"; preparation
 * and other notes live only in the panel and on the confirmation, never on the card.
 */

export type ServicePartsLabels = {
  minutesShort: string;
  priceInquiry: string;
  inquiryAction: string;
  bookAction: string;
  aboutService: string;
  beforeAppointment: string;
  afterAppointment: string;
  importantInfo: string;
  inquiryIntro: string;
  noContactConfigured: string;
  contactCall: string;
  contactWhatsapp: string;
  contactInstagram: string;
};

export function ServiceMetaLine({ service, labels }: { service: PublicBookingService; labels: Pick<ServicePartsLabels, "minutesShort" | "priceInquiry"> }) {
  const p = priceLine(service);
  const d = durationLine(service, labels.minutesShort);
  const parts = [p.kind === "price" ? p.text : p.kind === "inquiry" ? labels.priceInquiry : null, d].filter((x): x is string => !!x);
  if (parts.length === 0) return null;
  return <div className="text-sm font-medium tabular-nums">{parts.join(" · ")}</div>;
}

export function ServiceCard({ service, labels, onSelect }: { service: PublicBookingService; labels: ServicePartsLabels; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="service-card"
      className="hover:border-primary hover:bg-primary/5 focus-visible:ring-ring flex flex-col gap-1 rounded-xl border p-4 text-left focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{service.name}</span>
        {service.badge && <Badge variant="secondary">{service.badge}</Badge>}
      </div>
      {service.category && <div className="text-muted-foreground text-sm">{service.category}</div>}
      <ServiceMetaLine service={service} labels={labels} />
      {service.summary && <div className="text-muted-foreground text-sm">{service.summary}</div>}
      {!isDirectlyBookable(service) && <span className="text-primary text-sm font-medium">{labels.inquiryAction}</span>}
    </button>
  );
}

function Note({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{title}</div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function InquiryContact({ branch, labels }: { branch: PublicBookingBranch | null; labels: ServicePartsLabels }) {
  const any = !!branch && (branch.phone || branch.whatsappPhone || branch.instagramHandle);
  if (!any) return <p className="text-muted-foreground text-sm">{labels.noContactConfigured}</p>;
  return (
    <div className="flex flex-wrap gap-2" data-testid="inquiry-contact">
      {branch!.phone && (
        <Button render={<a href={`tel:${branch!.phone}`} />} nativeButton={false} type="button" variant="outline" size="sm">
          <Phone /> {labels.contactCall}
        </Button>
      )}
      {branch!.whatsappPhone && (
        <Button render={<a href={toWhatsappUrl(branch!.whatsappPhone)} target="_blank" rel="noopener noreferrer" />} nativeButton={false} type="button" variant="outline" size="sm">
          <MessageCircle /> {labels.contactWhatsapp}
        </Button>
      )}
      {branch!.instagramHandle && (
        <Button render={<a href={toInstagramUrl(branch!.instagramHandle)} target="_blank" rel="noopener noreferrer" />} nativeButton={false} type="button" variant="outline" size="sm">
          <AtSign /> {labels.contactInstagram}
        </Button>
      )}
    </div>
  );
}

/** The service information step: shown for an inquiry service always (contact actions, no booking) and for a direct service that has information. */
export function ServiceInfoPanel({
  service,
  branch,
  labels,
  onBook,
}: {
  service: PublicBookingService;
  branch: PublicBookingBranch | null;
  labels: ServicePartsLabels;
  onBook: () => void;
}) {
  const direct = isDirectlyBookable(service);
  return (
    <div className="flex flex-col gap-4" data-testid="service-info">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{service.name}</h1>
          {service.badge && <Badge variant="secondary">{service.badge}</Badge>}
        </div>
        <ServiceMetaLine service={service} labels={labels} />
        {service.summary && <p className="text-muted-foreground text-sm">{service.summary}</p>}
      </div>
      {hasServiceInfo(service) && (
        <div className="flex flex-col gap-3 rounded-xl border p-4" data-testid="service-info-box">
          {service.details && <Note title={labels.aboutService} text={service.details} />}
          {service.preparationNote && <Note title={labels.beforeAppointment} text={service.preparationNote} />}
          {service.importantNote && <Note title={labels.importantInfo} text={service.importantNote} />}
          {service.aftercareNote && <Note title={labels.afterAppointment} text={service.aftercareNote} />}
        </div>
      )}
      {direct ? (
        <Button type="button" onClick={onBook}>
          {labels.bookAction}
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{labels.inquiryIntro}</p>
          <InquiryContact branch={branch} labels={labels} />
        </div>
      )}
    </div>
  );
}
