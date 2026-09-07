import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { StaffReportTotals } from "@/lib/modules/reports/queries";
import { formatUtilizationPercent } from "@/lib/modules/reports/format";

type Labels = {
  completedServiceItems: string;
  uniqueCustomers: string;
  newCustomers: string;
  returningCustomersSuffix: string;
  utilization: string;
};

type UtilizationLabels = {
  unavailable: string;
};

/**
 * Faz 5A.3C — four restrained totals cards, built ONLY from the
 * independently-returned `totals` object (never by summing staff[] rows —
 * see mergeStaffReportData's own header comment for why that would be
 * wrong for completedServiceItems/uniqueCustomers/newCustomers). No
 * revenue/turnover/income/sales/commission/profit anywhere.
 */
export function ReportsSummaryCards({
  totals,
  labels,
  utilizationLabels,
}: {
  totals: StaffReportTotals;
  labels: Labels;
  utilizationLabels: UtilizationLabels;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">
            {labels.completedServiceItems}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">{totals.completedServiceItems}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">
            {labels.uniqueCustomers}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">{totals.uniqueCustomers}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">
            {labels.newCustomers}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">{totals.newCustomers}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {totals.returningCustomers} {labels.returningCustomersSuffix}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">
            {labels.utilization}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">
            {totals.utilization === null
              ? utilizationLabels.unavailable
              : formatUtilizationPercent(totals.utilization)}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
