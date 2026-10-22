import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Faz LAUNCH.1A — the four "use server" wrappers in lib/modules/team/member-actions.ts, in isolation: the signed-in
 * user is required BEFORE anything else happens, the Core function receives exactly the input it was given, the
 * Team page is revalidated only after a real success and only for a slug-shaped tenantSlug (client-supplied, never an
 * authority). The Core itself is covered against a real database in launch1a-team-member-actions.test.ts.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  requireUser: vi.fn(),
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
  cores: {
    changeMemberRoleCore: vi.fn(),
    suspendMemberCore: vi.fn(),
    reactivateMemberCore: vi.fn(),
    removeMemberCore: vi.fn(),
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.createClient }));
vi.mock("@/lib/auth/session", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/modules/team/member-management", () => h.cores);

import {
  changeMemberRoleAction,
  reactivateMemberAction,
  removeMemberAction,
  suspendMemberAction,
} from "@/lib/modules/team/member-actions";
import { fail, ok } from "@/lib/errors";

const FAKE_CLIENT = { marker: "cookie-bound client" };
const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBERSHIP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROLE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const target = { tenantId: TENANT_ID, membershipId: MEMBERSHIP_ID, tenantSlug: "bella-hair" };
const roleInput = { ...target, newRoleId: ROLE_A, expectedRoleId: ROLE_B };

const cases = [
  { name: "suspendMemberAction", run: suspendMemberAction, core: h.cores.suspendMemberCore, input: target },
  { name: "reactivateMemberAction", run: reactivateMemberAction, core: h.cores.reactivateMemberCore, input: target },
  { name: "removeMemberAction", run: removeMemberAction, core: h.cores.removeMemberCore, input: target },
  { name: "changeMemberRoleAction", run: changeMemberRoleAction, core: h.cores.changeMemberRoleCore, input: roleInput },
] as const;

beforeEach(() => {
  h.order.length = 0;
  h.requireUser.mockReset().mockImplementation(async () => {
    h.order.push("requireUser");
    return { id: "user" };
  });
  h.createClient.mockReset().mockImplementation(async () => {
    h.order.push("createClient");
    return FAKE_CLIENT;
  });
  h.revalidatePath.mockReset();
  for (const core of Object.values(h.cores)) {
    core.mockReset().mockImplementation(async () => {
      h.order.push("core");
      return ok({ membershipId: MEMBERSHIP_ID });
    });
  }
});

describe.each(cases)("$name", ({ run, core, input }) => {
  it("requires the signed-in user FIRST, then builds the cookie-bound client, then runs the Core", async () => {
    await run(null, input as never);
    expect(h.order).toEqual(["requireUser", "createClient", "core"]);
  });

  it("an unauthenticated caller never reaches the Core (requireUser redirects/throws)", async () => {
    h.requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(run(null, input as never)).rejects.toThrow("NEXT_REDIRECT");
    expect(h.createClient).not.toHaveBeenCalled();
    expect(core).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("hands the Core the cookie-bound client and the input unchanged, and returns its result as-is", async () => {
    const result = await run(null, input as never);
    expect(core).toHaveBeenCalledWith(FAKE_CLIENT, input);
    expect(result).toEqual(ok({ membershipId: MEMBERSHIP_ID }));
  });

  it("revalidates exactly the Team page of the named salon after a real success", async () => {
    await run(null, input as never);
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith("/app/bella-hair/team");
  });

  it("does NOT revalidate after a failure (conflict, refusal, not found) and passes the failure through", async () => {
    const failure = fail("CONFLICT", "Üyenin durumu başka bir işlemle değiştirilmiş. Liste yenilendi.");
    core.mockResolvedValue(failure);
    const result = await run(null, input as never);
    expect(result).toEqual(failure);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["../../etc", "bella hair", "Bella-Hair", "-bella", "bella-", "a/b", "", "x".repeat(64), "bella?x=1", "bella#top"])(
    "a client-supplied tenantSlug of %j is never used to build a revalidation path",
    async (tenantSlug) => {
      await run(null, { ...input, tenantSlug } as never);
      expect(h.revalidatePath).not.toHaveBeenCalled();
      // ...and the operation itself is unaffected: the slug is never an authority
      expect(core).toHaveBeenCalledTimes(1);
    },
  );

  it("a non-string tenantSlug is ignored too", async () => {
    await run(null, { ...input, tenantSlug: 42 } as never);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
