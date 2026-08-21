// Split from queries.ts (which is server-only) so client components can
// import this value without pulling the server-only guard into the
// client bundle — same fix as lib/modules/customers/constants.ts in
// Phase 2C for the identical import-leak class.
export const APPOINTMENTS_PAGE_SIZE = 30;
