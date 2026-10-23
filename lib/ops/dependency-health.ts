/**
 * Faz OPS.1A — the smallest useful production health model.
 *
 * Two questions an uptime monitor needs answered, nothing more:
 *   1. Is the application itself serving?            -> /api/health (no dependency, always cheap)
 *   2. Can it reach its two hard dependencies?       -> /api/health/dependencies (this file)
 *
 * The dependency check talks to Supabase's PUBLIC surfaces with the PUBLISHABLE key only (the same key every browser
 * already holds): GoTrue's /auth/v1/health, and one PostgREST request that returns a few bytes whatever the answer.
 * It never uses the service role, never reads a tenant row, and the answer carries no host, key, version string,
 * error text or stack — only "ok" / "fail" per component. Load is bounded: one in-flight check per server instance
 * and a short result cache, so a flood of probes (or an attacker) cannot turn this into a database-load generator.
 */

export type ComponentStatus = "ok" | "fail";

export type DependencyHealth = {
  status: "healthy" | "degraded";
  checks: { auth: ComponentStatus; database: ComponentStatus };
};

export type DependencyHealthDeps = {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  publishableKey?: string;
  timeoutMs?: number;
  /** Injectable clock for the cache; defaults to Date.now. */
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 3000;
export const DEPENDENCY_CACHE_TTL_MS = 20_000;

let cached: { at: number; value: DependencyHealth } | null = null;
let inflight: Promise<DependencyHealth> | null = null;

/** Test-only: forget the cache and any in-flight check. */
export function resetDependencyHealthCache(): void {
  cached = null;
  inflight = null;
}

async function probe(fetchFn: typeof fetch, url: string, key: string, timeoutMs: number): Promise<ComponentStatus> {
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { apikey: key, authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any answer below 500 proves the service is up and routing: GoTrue says 200; PostgREST says 200, or a 4xx
    // permission/missing-table answer that still had to travel through Postgres. 5xx (incl. PostgREST's 503 when it
    // cannot reach the database) and network errors/timeouts are the outage signal.
    return response.status < 500 ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

async function runCheck(deps: DependencyHealthDeps): Promise<DependencyHealth> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = (deps.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = deps.publishableKey ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!base || !key) {
    return { status: "degraded", checks: { auth: "fail", database: "fail" } };
  }

  const [auth, database] = await Promise.all([
    probe(fetchFn, `${base}/auth/v1/health`, key, timeoutMs),
    probe(fetchFn, `${base}/rest/v1/tenants?select=id&limit=1`, key, timeoutMs),
  ]);
  return { status: auth === "ok" && database === "ok" ? "healthy" : "degraded", checks: { auth, database } };
}

export async function checkDependencies(deps: DependencyHealthDeps = {}): Promise<DependencyHealth> {
  const now = deps.now ?? Date.now;
  if (cached && now() - cached.at < DEPENDENCY_CACHE_TTL_MS) return cached.value;
  if (inflight) return inflight;

  inflight = runCheck(deps)
    .then((value) => {
      cached = { at: now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Short commit id of the running release — public repository, so not sensitive, and it ties an alert to a deployment. */
export function releaseId(env: Record<string, string | undefined> = process.env): string {
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  return sha ? sha.slice(0, 7) : "local";
}
