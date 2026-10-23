import { NextResponse } from "next/server";
import { checkDependencies, releaseId } from "@/lib/ops/dependency-health";

/**
 * Faz OPS.1A — dependency health: can this deployment reach Supabase Auth and the database? Public by design (an
 * external uptime monitor must be able to call it) and therefore deliberately poor in information: per-component
 * "ok" / "fail" only, no hosts, keys, versions, error text or tenant/user data. Bounded load: results are cached for
 * a few seconds per server instance (lib/ops/dependency-health.ts). 200 when healthy, 503 when degraded so a plain
 * status-code monitor needs no body parsing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const health = await checkDependencies();
  return NextResponse.json(
    { status: health.status, checks: health.checks, release: releaseId(), time: new Date().toISOString() },
    { status: health.status === "healthy" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
