import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { StaffReportRow } from "@/lib/modules/reports/queries";
import { fillTemplate, splitMinutes, formatUtilizationPercent } from "@/lib/modules/reports/format";

type TableLabels = {
  staffColumn: string;
  completedServiceItemsColumn: string;
  customersColumn: string;
  customersBreakdownTemplate: string;
  completedMinutesColumn: string;
  utilizationColumn: string;
  cancelledColumn: string;
  noShowColumn: string;
  serviceMixColumn: string;
  serviceMixMoreTemplate: string;
};

type UtilizationLabels = {
  unavailable: string;
  noScheduleHelper: string;
  tooltip: string;
};

type Props = {
  rows: StaffReportRow[];
  tableLabels: TableLabels;
  utilizationLabels: UtilizationLabels;
  minutesFormatTemplate: string;
};

const TOP_SERVICE_COUNT = 3;

function topServices(row: StaffReportRow) {
  return [...row.serviceMix].sort((a, b) => b.completedCount - a.completedCount).slice(0, TOP_SERVICE_COUNT);
}

function ServiceMixTags({ row, labels }: { row: StaffReportRow; labels: TableLabels }) {
  const top = topServices(row);
  const remaining = row.serviceMix.length - top.length;
  if (top.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {top.map((mix) => (
        <Badge key={mix.serviceId} variant="secondary" className="text-xs font-normal">
          {mix.serviceName ?? "—"} · {mix.completedCount}
        </Badge>
      ))}
      {remaining > 0 && (
        <span className="text-muted-foreground self-center text-xs">
          {fillTemplate(labels.serviceMixMoreTemplate, { count: remaining })}
        </span>
      )}
    </div>
  );
}

function UtilizationValue({ row, labels }: { row: StaffReportRow; labels: UtilizationLabels }) {
  if (row.utilization === null) {
    return (
      <span className="text-muted-foreground text-sm" title={labels.noScheduleHelper}>
        {labels.unavailable}
      </span>
    );
  }
  return (
    <span className="text-sm font-medium tabular-nums" title={labels.tooltip}>
      {formatUtilizationPercent(row.utilization)}
    </span>
  );
}

function MinutesValue({ minutes, template }: { minutes: number; template: string }) {
  const { hours, minutes: mins } = splitMinutes(minutes);
  return <span className="tabular-nums">{fillTemplate(template, { hours, minutes: mins })}</span>;
}

/**
 * Faz 5A.3C — one comparison view, rendered twice via responsive
 * visibility (Tailwind `hidden md:block` / `md:hidden`), not two separate
 * data-fetching paths: a desktop table for wide screens, stacked cards on
 * mobile. Cancellation/no-show are rendered as plain muted numbers —
 * operational counts, not a red/warning score, per the locked V1 rule.
 */
export function ReportsStaffComparison({ rows, tableLabels, utilizationLabels, minutesFormatTemplate }: Props) {
  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tableLabels.staffColumn}</TableHead>
              <TableHead className="text-right">{tableLabels.completedServiceItemsColumn}</TableHead>
              <TableHead>{tableLabels.customersColumn}</TableHead>
              <TableHead className="text-right">{tableLabels.completedMinutesColumn}</TableHead>
              <TableHead className="text-right">{tableLabels.utilizationColumn}</TableHead>
              <TableHead className="text-right">{tableLabels.cancelledColumn}</TableHead>
              <TableHead className="text-right">{tableLabels.noShowColumn}</TableHead>
              <TableHead className="min-w-48">{tableLabels.serviceMixColumn}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.staffId}>
                <TableCell className="font-medium">{row.staffName}</TableCell>
                <TableCell className="text-right tabular-nums">{row.completedServiceItems}</TableCell>
                <TableCell>
                  <div className="tabular-nums">{row.uniqueCustomers}</div>
                  <div className="text-muted-foreground text-xs tabular-nums">
                    {fillTemplate(tableLabels.customersBreakdownTemplate, {
                      newCount: row.newCustomers,
                      returningCount: row.returningCustomers,
                    })}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <MinutesValue minutes={row.completedMinutes} template={minutesFormatTemplate} />
                </TableCell>
                <TableCell className="text-right">
                  <UtilizationValue row={row} labels={utilizationLabels} />
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {row.cancelledAppointments}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {row.noShowAppointments}
                </TableCell>
                <TableCell>
                  <ServiceMixTags row={row} labels={tableLabels} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile stacked cards */}
      <div className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <div key={row.staffId} className="bg-card rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-medium">{row.staffName}</h3>
              <UtilizationValue row={row} labels={utilizationLabels} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{tableLabels.completedServiceItemsColumn}</dt>
              <dd className="text-right tabular-nums">{row.completedServiceItems}</dd>

              <dt className="text-muted-foreground">{tableLabels.customersColumn}</dt>
              <dd className="text-right tabular-nums">
                {row.uniqueCustomers}
                <span className="text-muted-foreground ml-1 text-xs">
                  ({fillTemplate(tableLabels.customersBreakdownTemplate, {
                    newCount: row.newCustomers,
                    returningCount: row.returningCustomers,
                  })})
                </span>
              </dd>

              <dt className="text-muted-foreground">{tableLabels.completedMinutesColumn}</dt>
              <dd className="text-right">
                <MinutesValue minutes={row.completedMinutes} template={minutesFormatTemplate} />
              </dd>
            </dl>
            <div className="mt-3">
              <ServiceMixTags row={row} labels={tableLabels} />
            </div>
            <div className="text-muted-foreground mt-3 flex gap-4 text-xs">
              <span>
                {tableLabels.cancelledColumn}: {row.cancelledAppointments}
              </span>
              <span>
                {tableLabels.noShowColumn}: {row.noShowAppointments}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
