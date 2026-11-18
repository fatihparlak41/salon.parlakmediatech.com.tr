/**
 * Faz SAAS.1C.2b - the export data scope, derived from the REAL schema. The column lists MUST equal the explicit SELECT lists in
 * public.export_read_section (a test compares them against the database). Nothing here is ever "select *".
 *
 * EXCLUDED on purpose (see EXCLUDED_DATA): auth / password / session data, internal user ids (created_by, voided_by, ...), request idempotency
 * keys and fingerprints, treatment photo BINARIES and storage paths, booking-claim secrets, subscription / billing / provider data, platform
 * admin data, memberships / roles / invitations, push subscriptions, notification outbox, audit logs.
 */

export const EXPORT_VERSION = 1;

export type ExportSection = { key: string; columns: readonly string[]; description: string };

export const SECTIONS: readonly ExportSection[] = [
  { key: "tenant", description: "Salon profile and customer self-service settings", columns: ["id", "name", "slug", "timezone", "currency", "created_at", "customer_cancellation_enabled", "customer_cancellation_cutoff_minutes", "customer_reschedule_enabled", "customer_reschedule_cutoff_minutes"] },
  { key: "branches", description: "Branches", columns: ["id", "name", "address", "phone", "whatsapp_phone", "instagram_handle", "location_url", "is_primary", "created_at", "updated_at", "deleted_at"] },
  { key: "staff", description: "Staff members", columns: ["id", "full_name", "email", "phone", "color", "status", "display_order", "concurrent_capacity", "created_at", "updated_at", "deleted_at"] },
  { key: "staff_branches", description: "Staff to branch assignments", columns: ["staff_member_id", "branch_id", "created_at"] },
  { key: "staff_services", description: "Staff to service assignments", columns: ["staff_member_id", "service_id", "created_at"] },
  { key: "staff_schedules", description: "Weekly working hours", columns: ["id", "staff_member_id", "branch_id", "weekday", "start_time", "end_time", "created_at", "updated_at", "deleted_at"] },
  { key: "staff_schedule_exceptions", description: "Time off and schedule exceptions", columns: ["id", "staff_member_id", "exception_date", "type", "start_time", "end_time", "reason", "created_at", "updated_at", "deleted_at"] },
  { key: "services", description: "Services", columns: ["id", "category", "name", "description", "duration_minutes", "price", "status", "display_order", "pricing_mode", "booking_mode", "price_public", "display_duration_min", "display_duration_max", "public_summary", "public_details", "preparation_note", "aftercare_note", "important_note", "badge_label", "rebook_min_days", "rebook_max_days", "created_at", "updated_at", "deleted_at"] },
  { key: "service_branches", description: "Service to branch assignments", columns: ["service_id", "branch_id", "created_at"] },
  { key: "customers", description: "Customers", columns: ["id", "full_name", "phone", "email", "notes", "status", "created_at", "updated_at", "deleted_at"] },
  { key: "appointments", description: "Appointments", columns: ["id", "branch_id", "customer_id", "status", "notes", "source", "scheduled_start_at", "scheduled_end_at", "created_at", "updated_at"] },
  { key: "appointment_items", description: "Appointment items (service lines)", columns: ["id", "appointment_id", "service_id", "staff_member_id", "actual_staff_member_id", "scheduled_start_at", "scheduled_end_at", "duration_minutes", "price", "sequence", "appointment_status", "created_at", "updated_at"] },
  { key: "appointment_sales", description: "Sales / checkout records", columns: ["id", "branch_id", "appointment_id", "customer_id", "currency", "subtotal", "discount_amount", "total_amount", "status", "finalized_at", "created_at", "updated_at"] },
  { key: "appointment_sale_items", description: "Sale lines", columns: ["id", "sale_id", "appointment_item_id", "service_id", "service_name_snapshot", "actual_staff_member_id", "unit_price", "created_at", "updated_at"] },
  { key: "payments", description: "Customer payments", columns: ["id", "branch_id", "appointment_sale_id", "amount", "method", "paid_at", "note", "status", "voided_at", "void_reason", "created_at"] },
  { key: "expenses", description: "Expenses", columns: ["id", "branch_id", "category_key", "description", "vendor_name", "note", "expense_date", "due_date", "amount", "currency", "status", "cancelled_at", "cancel_reason", "created_at", "updated_at"] },
  { key: "expense_payments", description: "Expense payments", columns: ["id", "expense_id", "amount", "method", "paid_at", "note", "status", "voided_at", "void_reason", "created_at"] },
  { key: "staff_commission_rules", description: "Staff commission rules", columns: ["id", "staff_member_id", "service_id", "kind", "percentage", "fixed_amount", "effective_from", "created_at"] },
  { key: "treatment_notes", description: "Treatment history notes", columns: ["appointment_item_id", "note", "created_at", "updated_at"] },
  { key: "treatment_photos", description: "Treatment photo METADATA (no image files)", columns: ["id", "appointment_item_id", "kind", "mime_type", "size_bytes", "status", "created_at", "confirmed_at"] },
  { key: "consent_booking_claims", description: "Booking-to-account claim metadata (no secrets)", columns: ["id", "customer_id", "appointment_id", "expires_at", "consumed_at", "created_at"] },
  { key: "consent_account_links", description: "Customer account link metadata", columns: ["id", "customer_id", "claimed_via", "is_primary", "created_at", "deleted_at"] },
] as const;

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

export const EXCLUDED_DATA: readonly string[] = [
  "authentication data: passwords, password hashes, sessions, tokens, auth user records",
  "internal user ids (created_by, updated_by, voided_by, cancelled_by, consumed_by_user_id, membership ids)",
  "request idempotency keys and fingerprints",
  "treatment photo files (binaries) and storage paths - only metadata is exported",
  "booking-claim secrets and e-mail snapshots",
  "subscription, billing, plan and payment-provider data",
  "platform administration records and internal notes",
  "team memberships, roles, permissions, invitations",
  "push subscriptions, notification outbox and delivery records",
  "audit logs",
];

export type ExportSectionKey = (typeof SECTIONS)[number]["key"];
