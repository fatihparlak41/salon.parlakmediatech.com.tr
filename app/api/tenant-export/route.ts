import "server-only";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildExportArchive, exportFolder } from "@/lib/modules/export/archive";
import { completeTenantExport, consumeTenantExportToken, failTenantExport, sectionPageFetcher } from "@/lib/modules/export/queries";
import { hashToken, isWellFormedToken } from "@/lib/modules/export/token";

/**
 * Faz SAAS.1C.2b - the export DOWNLOAD (streamed zip). POST only, with the single-use token in the form body (never in the URL, so it cannot reach
 * access logs, history or a Referer header). The caller must be signed in; the database consumes the token atomically and answers ONE generic
 * refusal for every kind of failure (unknown / used / expired / someone else's / not an Owner any more), which becomes ONE generic 403 here.
 * Nothing is buffered: pages of rows go straight into a streaming zip. The response is never cached and nothing is written to disk or to a bucket.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REFUSED = () => NextResponse.json({ error: "export_unavailable" }, { status: 403, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  // same-origin only: a cross-site form post cannot know the token, but refusing early keeps the surface small
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return REFUSED();
    } catch {
      return REFUSED();
    }
  }

  let token: unknown;
  try {
    token = (await request.formData()).get("token");
  } catch {
    return REFUSED();
  }
  if (!isWellFormedToken(token)) return REFUSED();

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const consumed = await consumeTenantExportToken(supabase, hashToken(token));
  if (!consumed.ok) return REFUSED();

  const now = new Date();
  const { stream, report } = buildExportArchive({
    fetchPage: sectionPageFetcher(supabase, consumed.request_id),
    now,
    snapshotAt: consumed.fence_at,
    tenantTimezone: consumed.tenant_timezone,
    tenantCurrency: consumed.tenant_currency,
  });

  const body = Readable.toWeb(
    Readable.from(
      (async function* () {
        try {
          for await (const chunk of stream) yield chunk;
          const r = report();
          await completeTenantExport(supabase, consumed.request_id, r.counts, r.bytes);
        } catch (e) {
          const code = e instanceof Error && /^[a-z0-9_]{1,40}$/.test(e.message) ? e.message : "export_failed";
          await failTenantExport(supabase, consumed.request_id, code);
          throw e;
        }
      })(),
    ),
  ) as unknown as ReadableStream<Uint8Array>;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exportFolder(now)}.zip"`,
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
