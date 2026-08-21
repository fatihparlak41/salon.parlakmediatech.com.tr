// Deliberately its own file with no "server-only" guard: both
// lib/modules/customers/queries.ts (server) and customers-page-client.tsx
// (client) need the same page size, and the client side must never pull
// in the server-only module just for a constant.
export const CUSTOMERS_PAGE_SIZE = 30;
