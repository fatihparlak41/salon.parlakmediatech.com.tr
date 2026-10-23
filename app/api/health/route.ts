import { NextResponse } from "next/server";
import { releaseId } from "@/lib/ops/dependency-health";

/**
 * Faz OPS.1A — liveness. Answers "is the application serving requests?" and nothing else: no database, no Auth, no
 * environment value, no tenant or user information. Cheap enough for any probe interval. Not behind the locale proxy
 * (proxy.ts excludes /api).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return NextResponse.json(
    { status: "ok", release: releaseId(), time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
