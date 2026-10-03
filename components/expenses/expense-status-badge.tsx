import { Badge } from "@/components/ui/badge";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import type { ExpenseStatus } from "@/lib/modules/expenses/types";

const STATUS_VARIANT: Record<
  ExpenseStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  open: "outline",
  partially_paid: "default",
  paid: "secondary",
  cancelled: "destructive",
};

/** The stored status, plus "Vadesi geçti" as a derived SECOND badge: overdue is a reading of the due date, never a status. */
export function ExpenseStatusBadge({
  status,
  isOverdue,
  labels,
}: {
  status: ExpenseStatus;
  isOverdue: boolean;
  labels: ExpenseLabels;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={STATUS_VARIANT[status]}>{labels.status[status]}</Badge>
      {isOverdue && (
        <Badge variant="destructive">{labels.status.overdue}</Badge>
      )}
    </span>
  );
}
