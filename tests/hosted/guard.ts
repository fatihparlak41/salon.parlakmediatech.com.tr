/**
 * Safety guard for the HOSTED acceptance suites (tests/hosted/*.hosted.ts, vitest.hosted-acceptance.config.mts).
 *
 * These suites create synthetic users and tenants and suspend/remove memberships on a REAL hosted Supabase project, so they must
 * be impossible to point at production by accident. Nothing here names a project: the operator supplies a DISPOSABLE project and
 * every one of the following must hold before a single write happens.
 *
 *   1. HOSTED_ACCEPTANCE_PROJECT_REF       the disposable project's ref (20 lowercase letters)
 *   2. HOSTED_ACCEPTANCE_CONFIRM           the literal phrase below — proof a human read this file
 *   3. HOSTED_ACCEPTANCE_SUPABASE_URL      must be exactly https://<ref>.supabase.co
 *   4. HOSTED_ACCEPTANCE_DATABASE_URL      its user must be postgres.<ref> (the pooler login of THE SAME project)
 *   5. HOSTED_ACCEPTANCE_PUBLISHABLE_KEY / HOSTED_ACCEPTANCE_SERVICE_ROLE_KEY   that project's keys
 *   6. the database must contain the marker table public.hosted_acceptance_disposable_marker (the operator creates it once,
 *      see assertDisposableDatabase) and NO tenant whose slug does not start with "h-" — a project holding real tenants
 *      (production) is refused even if every variable above was set by mistake.
 *
 * Secrets come only from the environment of the operator's shell; none are stored in the repository.
 */

export const CONFIRM_PHRASE = "i-confirm-this-is-a-disposable-project-with-no-customer-data";
export const MARKER_TABLE = "hosted_acceptance_disposable_marker";

export type HostedEnv = {
  ref: string;
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  databaseUrl: string;
  appUrl: string;
};

/** Pure and synchronous (the vitest config calls it before any test module is loaded). Throws on anything unexpected. */
export function readHostedEnv(env: Record<string, string | undefined> = process.env): HostedEnv {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`hosted acceptance refused: ${name} is not set (see tests/hosted/guard.ts)`);
    return value;
  };

  const ref = need("HOSTED_ACCEPTANCE_PROJECT_REF");
  if (!/^[a-z]{20}$/.test(ref)) throw new Error("hosted acceptance refused: HOSTED_ACCEPTANCE_PROJECT_REF is not a project ref");
  if (need("HOSTED_ACCEPTANCE_CONFIRM") !== CONFIRM_PHRASE) {
    throw new Error("hosted acceptance refused: HOSTED_ACCEPTANCE_CONFIRM does not carry the confirmation phrase");
  }

  const supabaseUrl = need("HOSTED_ACCEPTANCE_SUPABASE_URL").replace(/\/+$/, "");
  if (supabaseUrl !== `https://${ref}.supabase.co`) {
    throw new Error("hosted acceptance refused: the API URL is not the declared project's URL");
  }

  const databaseUrl = need("HOSTED_ACCEPTANCE_DATABASE_URL");
  let dbUser: string;
  try {
    dbUser = decodeURIComponent(new URL(databaseUrl).username);
  } catch {
    throw new Error("hosted acceptance refused: HOSTED_ACCEPTANCE_DATABASE_URL is not a URL");
  }
  if (dbUser !== `postgres.${ref}`) {
    throw new Error("hosted acceptance refused: the database login does not belong to the declared project");
  }

  const appUrl = (env.HOSTED_ACCEPTANCE_APP_URL ?? "http://localhost:3100").replace(/\/+$/, "");
  const app = new URL(appUrl);
  if (!["localhost", "127.0.0.1"].includes(app.hostname)) {
    throw new Error("hosted acceptance refused: the app under test must run locally (HOSTED_ACCEPTANCE_APP_URL)");
  }

  return {
    ref,
    supabaseUrl,
    publishableKey: need("HOSTED_ACCEPTANCE_PUBLISHABLE_KEY"),
    serviceRoleKey: need("HOSTED_ACCEPTANCE_SERVICE_ROLE_KEY"),
    databaseUrl,
    appUrl,
  };
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Runs first in every hosted suite, before anything is written. A disposable project is marked once by its operator:
 *   create table public.hosted_acceptance_disposable_marker (id int primary key default 1);   -- on the DISPOSABLE project only
 */
export async function assertDisposableDatabase(sql: Sql): Promise<void> {
  const [marker] = await sql`select to_regclass('public.hosted_acceptance_disposable_marker')::text as t`;
  if (!marker?.t) {
    throw new Error("hosted acceptance refused: the database has no disposable-project marker table (see tests/hosted/guard.ts)");
  }
  const [real] = await sql`select count(*)::int as n from public.tenants where slug not like 'h-%'`;
  if (Number(real?.n) !== 0) {
    throw new Error("hosted acceptance refused: the database holds tenants that are not hosted-acceptance fixtures");
  }
}
