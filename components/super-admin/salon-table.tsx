import { Link } from "@/lib/i18n/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HealthBadge, LifecycleBadge } from "@/components/super-admin/status-badges";
import { formatDate, relativeDays, relativeLabel } from "@/components/super-admin/format";
import type { AdminSalonRow, HealthLevel, Lifecycle } from "@/lib/modules/platform/admin";

export type SalonTableLabels = {
  columns: { salon: string; owner: string; status: string; setup: string; booking: string; staff: string; customers: string; appointments: string; created: string; lastActivity: string };
  lifecycle: Record<Lifecycle, string>;
  levels: Record<HealthLevel, string>;
  setupComplete: string;
  setupIncomplete: string;
  bookingOn: string;
  bookingOff: string;
  noOwner: string;
  unknownOwner: string;
  relative: { never: string; today: string; yesterday: string; daysAgo: string };
};

/**
 * The salon list. Dense on purpose (an operations console, not a showcase): one row per salon, Owner and contact on the row, state as a
 * label plus a badge, numbers right-aligned. It receives only what admin_list_tenants returns, i.e. no customer data exists in its props.
 * Wide on small screens by horizontal scroll, never by dropping the columns an operator needs.
 */
export function SalonTable({ rows, labels, now }: { rows: AdminSalonRow[]; labels: SalonTableLabels; now: Date }) {
  const c = labels.columns;
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{c.salon}</TableHead>
            <TableHead>{c.owner}</TableHead>
            <TableHead>{c.status}</TableHead>
            <TableHead>{c.setup}</TableHead>
            <TableHead>{c.booking}</TableHead>
            <TableHead className="text-right">{c.staff}</TableHead>
            <TableHead className="text-right">{c.customers}</TableHead>
            <TableHead className="text-right">{c.appointments}</TableHead>
            <TableHead>{c.created}</TableHead>
            <TableHead>{c.lastActivity}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.tenantId} data-slug={row.slug}>
              <TableCell className="min-w-44">
                <Link href={`/super-admin/salons/${row.tenantId}`} className="font-medium underline-offset-4 hover:underline">
                  {row.name}
                </Link>
                <div className="text-muted-foreground font-mono text-xs">{row.slug}</div>
              </TableCell>
              <TableCell className="min-w-44">
                {row.ownerCount === 0 && !row.ownerEmail ? (
                  <span className="text-destructive text-sm">{labels.noOwner}</span>
                ) : (
                  <>
                    <div className="text-sm">{row.ownerName ?? labels.unknownOwner}</div>
                    <div className="text-muted-foreground text-xs">{row.ownerEmail}</div>
                  </>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  <LifecycleBadge lifecycle={row.lifecycle} labels={labels.lifecycle} />
                  {row.healthLevel === "critical" || row.healthLevel === "warning" ? <HealthBadge level={row.healthLevel} labels={labels.levels} /> : null}
                </div>
              </TableCell>
              <TableCell className="text-sm">{row.setupComplete ? labels.setupComplete : labels.setupIncomplete}</TableCell>
              <TableCell className="text-sm">{row.bookingEnabled ? labels.bookingOn : labels.bookingOff}</TableCell>
              <TableCell className="text-right tabular-nums">{row.staffCount}</TableCell>
              <TableCell className="text-right tabular-nums">{row.customerCount}</TableCell>
              <TableCell className="text-right tabular-nums">{row.appointmentCount}</TableCell>
              <TableCell className="text-muted-foreground text-sm whitespace-nowrap">{formatDate(row.createdAt)}</TableCell>
              <TableCell className="text-muted-foreground text-sm whitespace-nowrap">{relativeLabel(relativeDays(row.lastActivityAt, now), labels.relative)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
