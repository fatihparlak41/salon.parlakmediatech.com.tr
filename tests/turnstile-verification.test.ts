import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "../lib/modules/public-booking/turnstile";

/**
 * Direct unit coverage for verifyTurnstileToken itself — previously
 * exercised only indirectly via booking-gateway.test.ts's injected/mocked
 * verifier, which never runs this function's own body at all (see that
 * file's own header comment: "never a real call to Cloudflare"). That
 * gap is exactly why the 2026-09-03 PROD incident (a real Cloudflare
 * siteverify HTTP 400) went uncaught until it happened live: nothing in
 * the suite had ever exercised this function's actual fetch/parsing
 * logic, mocked or otherwise. global.fetch is stubbed here — still never
 * a real network call to Cloudflare, but now the function's own request
 * construction and non-OK-response handling both get real coverage.
 */

const REAL_SECRET = "test-secret-value-not-a-real-credential";
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = REAL_SECRET;
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("verifyTurnstileToken — fail-closed on every non-success path", () => {
  it("missing secret: fails closed without ever calling fetch", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["missing-input-secret"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("network failure (fetch throws): fails closed", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["provider-unreachable"]);
  });

  it("provider 200 + success:true: the only path that passes", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const result = await verifyTurnstileToken("some-token");
    expect(result).toEqual({ success: true });
  });

  it("provider 200 + success:false: fails closed with Cloudflare's own error-codes, unchanged by this patch", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { success: false, "error-codes": ["invalid-input-response"] }));
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["invalid-input-response"]);
  });
});

describe("verifyTurnstileToken — non-OK response diagnostic enrichment (this patch)", () => {
  it("real-incident shape: a non-OK response with a non-JSON/empty body still fails closed with just the status code", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 400 }));
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["provider-http-400"]);
  });

  it("non-OK + JSON body with error-codes/hostname/action: all three surfaced, still fails closed", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(400, {
        "error-codes": ["invalid-input-secret"],
        hostname: "salon.parlakmediatech.com.tr",
        action: "guest-booking",
      }),
    );
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual([
      "provider-http-400",
      "provider-error-codes:invalid-input-secret",
      "provider-hostname:salon.parlakmediatech.com.tr",
      "provider-action:guest-booking",
    ]);
  });

  it("non-OK + JSON body with a message field: surfaced and length-capped", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(400, { message: "Bad request: malformed payload" }));
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain("provider-message:Bad request: malformed payload");
  });

  it("non-OK + plain-text body: truncated to ~300 chars in the raw-text fallback", async () => {
    const longBody = "x".repeat(500);
    fetchSpy.mockResolvedValueOnce(new Response(longBody, { status: 502 }));
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes![0]).toBe("provider-http-502");
    const bodyEntry = result.errorCodes!.find((c) => c.startsWith("provider-body:"));
    expect(bodyEntry).toBeDefined();
    expect(bodyEntry!.length).toBeLessThanOrEqual("provider-body:".length + 300);
  });

  it("non-OK + a credential-shaped string in the body: redacted, never logged raw", async () => {
    const secretLookingValue = "aVeryLongSecretLookingTokenValue1234567890ABCDEF";
    fetchSpy.mockResolvedValueOnce(new Response(`error: ${secretLookingValue}`, { status: 403 }));
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    const bodyEntry = result.errorCodes!.find((c) => c.startsWith("provider-body:"));
    expect(bodyEntry).toBeDefined();
    expect(bodyEntry).not.toContain(secretLookingValue);
    expect(bodyEntry).toContain("[REDACTED]");
  });

  it("the caller's own token is never sent to fetch anywhere but the request itself, and never appears in errorCodes", async () => {
    const distinctiveToken = "THIS-IS-THE-CALLERS-OWN-TOKEN-NEVER-LOG-ME-0099887766";
    fetchSpy.mockResolvedValueOnce(new Response("upstream error", { status: 400 }));
    const result = await verifyTurnstileToken(distinctiveToken);
    expect(JSON.stringify(result.errorCodes)).not.toContain(distinctiveToken);
  });

  it("the secret is never sent anywhere but the request body, and never appears in errorCodes", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("upstream error", { status: 400 }));
    const result = await verifyTurnstileToken("some-token");
    expect(JSON.stringify(result.errorCodes)).not.toContain(REAL_SECRET);
  });

  it("even if reading the response body itself throws, still fails closed with just the status code", async () => {
    const brokenResponse = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("body stream errored")),
    } as unknown as Response;
    fetchSpy.mockResolvedValueOnce(brokenResponse);
    const result = await verifyTurnstileToken("some-token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["provider-http-500"]);
  });
});
