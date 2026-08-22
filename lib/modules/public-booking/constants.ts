/**
 * Forward booking horizon, in days. Mirrored in
 * supabase/migrations/20260822150500_public_booking_functions.sql
 * (get_public_availability_slots' v_horizon calculation) — duplicated
 * rather than queried because it's a small, rarely-changing constant and
 * the DB function already independently enforces it as the authority;
 * this value only drives the client's date-picker range so the two
 * never need to be fetched together. If this ever needs to become
 * tenant-configurable, both this constant's usage and the migration's
 * v_horizon line move together in one change.
 */
export const PUBLIC_BOOKING_HORIZON_DAYS = 30;
