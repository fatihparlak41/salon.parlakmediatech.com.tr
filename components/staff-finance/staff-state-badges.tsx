import { Badge } from "@/components/ui/badge";
import { lifecycleLabel, paymentStateLabel } from "@/lib/modules/staff-finance/format";
import type { StaffFinanceLabels } from "@/lib/modules/staff-finance/labels";
import type { StaffLifecycle, StaffPaymentState } from "@/lib/modules/staff-finance/types";

const LIFECYCLE_VARIANT: Record<StaffLifecycle, "default" | "secondary" | "destructive" | "outline"> = {
  open: "outline",
  finalized: "secondary",
  cancelled: "destructive",
};

const PAYMENT_VARIANT: Record<StaffPaymentState, "default" | "secondary" | "destructive" | "outline"> = {
  nothing_due: "outline",
  unpaid: "outline",
  partially_paid: "default",
  paid: "secondary",
  // paid in excess of what is due: the warning chip
  overpaid: "destructive",
};

/**
 * The stored lifecycle, the generated payment state, and "Vadesi geçti" as a derived EXTRA badge: overdue is a reading of the
 * due date, never a state. A cancelled period shows no payment chip (its figures are all zero by definition).
 */
export function StaffStateBadges({
  lifecycle,
  paymentState,
  isOverdue,
  labels,
}: {
  lifecycle: StaffLifecycle;
  paymentState: StaffPaymentState;
  isOverdue: boolean;
  labels: StaffFinanceLabels;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={LIFECYCLE_VARIANT[lifecycle]}>{lifecycleLabel(labels, lifecycle)}</Badge>
      {lifecycle !== "cancelled" ? <Badge variant={PAYMENT_VARIANT[paymentState]}>{paymentStateLabel(labels, paymentState)}</Badge> : null}
      {isOverdue && lifecycle !== "cancelled" ? <Badge variant="destructive">{labels.paymentState.overdue}</Badge> : null}
    </span>
  );
}
