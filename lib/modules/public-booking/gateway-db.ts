import "server-only";
import postgres from "postgres";

/**
 * Direct Postgres connection as the `booking_gateway` role (Phase 2F.2,
 * 20260822170000) — EXECUTE on public.create_guest_booking only, nothing
 * else. Never the browser: this module is server-only, and
 * BOOKING_GATEWAY_DATABASE_URL is never NEXT_PUBLIC_-prefixed.
 *
 * Module-scope singleton, not created per request: Vercel reuses a warm
 * serverless instance across nearby invocations, so one client survives
 * to serve several requests rather than opening a fresh connection every
 * time. max: 1 and prepare: false because this connects through
 * Supabase's transaction-mode pooler (port 6543) — transaction pooling
 * doesn't support server-side prepared statements the way a direct
 * connection would, and the pooler itself is what actually multiplexes
 * many logical callers over a small number of real Postgres backend
 * connections, so this client doesn't need its own large pool on top of
 * that.
 */
let client: ReturnType<typeof postgres> | null = null;

function getGatewayClient() {
  if (!client) {
    const url = process.env.BOOKING_GATEWAY_DATABASE_URL;
    if (!url) {
      throw new Error("BOOKING_GATEWAY_DATABASE_URL is not configured");
    }
    client = postgres(url, { ssl: "require", max: 1, prepare: false, idle_timeout: 20 });
  }
  return client;
}

export type GuestBookingDbInput = {
  tenantSlug: string;
  branchId: string;
  serviceId: string;
  scheduledStartAtUtc: string;
  customerFullName: string;
  customerPhone: string;
  staffMemberId?: string;
  customerEmail?: string;
  idempotencyKey: string;
  /** Server-derived only (see gateway.ts) — never sourced from the
   * browser-supplied GuestBookingGatewayInput. */
  customerAccountUserId: string | null;
  /** Faz 2G.3.1 — a HASH only, computed in gateway.ts via node:crypto.
   * The raw secret never reaches this module, let alone Postgres. */
  claimSecretHash?: string;
};

export type GuestBookingDbResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; code: string; message: string };

/** The gateway's only DB call. Mirrors the exact RPC parameter shape
 * create_guest_booking already accepts (see
 * lib/modules/public-booking/client-queries.ts's createGuestBooking,
 * which called the same function directly from the browser before this
 * phase — same parameters, different caller). */
export async function callCreateGuestBooking(input: GuestBookingDbInput): Promise<GuestBookingDbResult> {
  const sql = getGatewayClient();
  try {
    const [row] = await sql<{ create_guest_booking: Record<string, unknown> }[]>`
      select public.create_guest_booking(
        ${input.tenantSlug},
        ${input.branchId}::uuid,
        ${input.serviceId}::uuid,
        ${input.scheduledStartAtUtc}::timestamptz,
        ${input.customerFullName},
        ${input.customerPhone},
        ${input.staffMemberId ?? null}::uuid,
        ${input.customerEmail ?? null},
        ${input.idempotencyKey}::uuid,
        ${input.customerAccountUserId}::uuid,
        ${input.claimSecretHash ?? null}
      )
    `;
    return { success: true, data: row!.create_guest_booking };
  } catch (err) {
    const pgError = err as { code?: string; message?: string };
    // Postgres error codes for a RAISE EXCEPTION ... USING ERRCODE are
    // returned verbatim as .code by postgres.js — the same BK0nn values
    // the direct-RPC path used to surface via PostgREST's error.code.
    return { success: false, code: pgError.code ?? "UNKNOWN", message: pgError.message ?? "unknown database error" };
  }
}
