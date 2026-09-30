import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { config } from "dotenv";

// Tests hit the real Supabase DEV project (no local Docker stack on this
// machine — see README "Supabase") using credentials from .env.local.
// Passed explicitly via test.env (not just a mutated process.env) because
// Vitest's test files run in a separate worker context that doesn't
// automatically inherit env vars set by this config file's own process.
// quiet: true — dotenv's own documented option (v17+) to suppress its
// startup log line, which otherwise also prints one of its rotating
// promotional "tip" strings (including one phrased to target AI agents
// specifically: "auth for agents [www.vestauth.com]"). Officially
// supported, not a workaround; keeps test output deterministic and
// free of third-party promotional text either way.
const { parsed } = config({ path: ".env.local", quiet: true });

// Faz NOTIF.1A — real SMTP credentials must NEVER reach a test process.
// .env.local can legitimately hold the real Google Workspace SMTP settings
// (the local dev server reads them too), and passing every .env.local
// variable into the test environment would hand them to any test that
// happens to reach the default email transport. They are removed here — from
// this process (dotenv just populated process.env, which forked workers
// inherit) and from the explicit test.env below. A test that needs an SMTP
// endpoint sets one itself, and only ever a loopback catcher: the transport
// (lib/email/smtp-transport.ts) additionally refuses any non-loopback host
// outside a Vercel production deployment, so this is the second lock, not
// the only one.
const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_APP_PASSWORD", "EMAIL_FROM_ADDRESS"];
for (const key of SMTP_ENV_KEYS) delete process.env[key];
const testEnv = Object.fromEntries(
  Object.entries(parsed ?? {}).filter(([key]) => !SMTP_ENV_KEYS.includes(key)),
);

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // Faz FIN.1A remote review — .test.tsx admits the one jsdom UI
    // regression file (finance-checkout-ui.test.tsx), which opts itself
    // into jsdom per-file via a `// @vitest-environment jsdom` directive
    // at its own top. This global environment stays "node": every other
    // (DB-integration) test file is unaffected.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 20000,
    hookTimeout: 30000,
    env: testEnv,
    // All test files hit the same live remote Supabase project (no local
    // Docker stack — see README "Supabase"), including real
    // signInWithPassword calls against Supabase Auth's rate limiter.
    // Running files in parallel workers multiplies concurrent auth load
    // for no benefit here, and previously tripped that rate limit once a
    // second test file was added. Sequential is the right default for
    // this project, not just a workaround.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Mirrors tsconfig.json's "@/*" path — needed the first time a test
      // imports real app code (lib/auth/session-errors.ts) instead of only
      // ./helpers. Vitest doesn't read tsconfig paths on its own.
      "@": rootDir,
      // Phase 2F.2: lib/modules/public-booking/{gateway,turnstile,gateway-db}.ts
      // import "server-only", which throws outside Next's own build
      // pipeline (see tests/stubs/server-only-stub.ts's own comment for
      // why this is safe — test-only, no effect on the real build).
      "server-only": path.join(rootDir, "tests/stubs/server-only-stub.ts"),
    },
  },
});
