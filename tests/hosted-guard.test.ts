import { describe, expect, it } from "vitest";
import { CONFIRM_PHRASE, assertDisposableDatabase, readHostedEnv } from "@/tests/hosted/guard";

/**
 * Faz SAAS.1A release gate — the safety guard of the hosted acceptance suites. It must make it impossible to point those suites at a
 * project that was not declared disposable. IDs HG1-HG10. Pure: no network, no database (the database half uses a fake `sql`).
 */

const REF = "abcdefghijklmnopqrst";
const OTHER = "tsrqponmlkjihgfedcba";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HOSTED_ACCEPTANCE_PROJECT_REF: REF,
    HOSTED_ACCEPTANCE_CONFIRM: CONFIRM_PHRASE,
    HOSTED_ACCEPTANCE_SUPABASE_URL: `https://${REF}.supabase.co`,
    HOSTED_ACCEPTANCE_DATABASE_URL: `postgresql://postgres.${REF}:not-a-real-password@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
    HOSTED_ACCEPTANCE_PUBLISHABLE_KEY: "publishable-placeholder",
    HOSTED_ACCEPTANCE_SERVICE_ROLE_KEY: "service-placeholder",
    ...overrides,
  };
}

describe("HG hosted acceptance guard — readHostedEnv", () => {
  it("HG1 a fully consistent, confirmed disposable declaration is accepted (app defaults to localhost)", () => {
    const hosted = readHostedEnv(env());
    expect(hosted).toMatchObject({ ref: REF, supabaseUrl: `https://${REF}.supabase.co`, appUrl: "http://localhost:3100" });
  });

  it.each([
    "HOSTED_ACCEPTANCE_PROJECT_REF",
    "HOSTED_ACCEPTANCE_CONFIRM",
    "HOSTED_ACCEPTANCE_SUPABASE_URL",
    "HOSTED_ACCEPTANCE_DATABASE_URL",
    "HOSTED_ACCEPTANCE_PUBLISHABLE_KEY",
    "HOSTED_ACCEPTANCE_SERVICE_ROLE_KEY",
  ])("HG2 refuses when %s is missing", (name) => {
    expect(() => readHostedEnv(env({ [name]: undefined }))).toThrow(/refused/);
  });

  it("HG2b an EMPTY value counts as missing", () => {
    for (const name of [
      "HOSTED_ACCEPTANCE_PROJECT_REF",
      "HOSTED_ACCEPTANCE_CONFIRM",
      "HOSTED_ACCEPTANCE_SUPABASE_URL",
      "HOSTED_ACCEPTANCE_DATABASE_URL",
      "HOSTED_ACCEPTANCE_PUBLISHABLE_KEY",
      "HOSTED_ACCEPTANCE_SERVICE_ROLE_KEY",
    ]) {
      expect(() => readHostedEnv(env({ [name]: "" })), name).toThrow(/refused/);
    }
  });

  it("HG3 refuses a value that is not a project ref", () => {
    for (const ref of ["short", "UPPERCASEUPPERCASEUPPE", "abcdefghijklmnopqrs1", `${REF}x`, "localhost"]) {
      // a CONSISTENT declaration (URL and database login agree with the malformed ref): only the format rule can refuse it
      const consistent = env({
        HOSTED_ACCEPTANCE_PROJECT_REF: ref,
        HOSTED_ACCEPTANCE_SUPABASE_URL: `https://${ref}.supabase.co`,
        HOSTED_ACCEPTANCE_DATABASE_URL: `postgresql://postgres.${ref}:not-a-real-password@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
      });
      expect(() => readHostedEnv(consistent), ref).toThrow(/not a project ref/);
    }
  });

  it("HG4 refuses without the confirmation phrase", () => {
    expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_CONFIRM: "yes" }))).toThrow(/confirmation phrase/);
  });

  it("HG5 refuses an API URL that belongs to a DIFFERENT project than the declared one", () => {
    expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_SUPABASE_URL: `https://${OTHER}.supabase.co` }))).toThrow(/API URL/);
    expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_SUPABASE_URL: `https://${REF}.supabase.co.evil.example` }))).toThrow(/API URL/);
    expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_SUPABASE_URL: "http://127.0.0.1:54321" }))).toThrow(/API URL/);
  });

  it("HG6 refuses a database login that belongs to a different project (the classic copy-paste mistake)", () => {
    const url = `postgresql://postgres.${OTHER}:not-a-real-password@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
    expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_DATABASE_URL: url }))).toThrow(/database login/);
    expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres" }))).toThrow(/database login/);
    expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_DATABASE_URL: "not a url" }))).toThrow(/not a URL/);
  });

  it("HG7 the app under test must be local", () => {
    expect(readHostedEnv(env({ HOSTED_ACCEPTANCE_APP_URL: "http://127.0.0.1:3100" })).appUrl).toBe("http://127.0.0.1:3100");
    for (const appUrl of ["https://salon.example.com", "http://localhost.evil.example:3100", "https://127.0.0.1.evil.example"]) {
      expect(() => readHostedEnv(env({ HOSTED_ACCEPTANCE_APP_URL: appUrl }))).toThrow(/locally/);
    }
  });
});

describe("HG hosted acceptance guard — assertDisposableDatabase", () => {
  /** A fake `sql` answering the two guard queries. */
  function fakeSql(state: { marker: string | null; realTenants: number }) {
    return (async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("to_regclass")) return [{ t: state.marker }];
      if (text.includes("from public.tenants")) return [{ n: state.realTenants }];
      throw new Error(`unexpected query: ${text}`);
    }) as unknown as Parameters<typeof assertDisposableDatabase>[0];
  }

  it("HG8 accepts a marked database that holds only hosted-acceptance fixtures", async () => {
    await expect(assertDisposableDatabase(fakeSql({ marker: "hosted_acceptance_disposable_marker", realTenants: 0 }))).resolves.toBeUndefined();
  });

  it("HG9 refuses a database without the disposable marker", async () => {
    await expect(assertDisposableDatabase(fakeSql({ marker: null, realTenants: 0 }))).rejects.toThrow(/marker/);
  });

  it("HG10 refuses a database that holds a real tenant, even when the marker exists", async () => {
    await expect(assertDisposableDatabase(fakeSql({ marker: "hosted_acceptance_disposable_marker", realTenants: 2 }))).rejects.toThrow(/not hosted-acceptance fixtures/);
  });
});
