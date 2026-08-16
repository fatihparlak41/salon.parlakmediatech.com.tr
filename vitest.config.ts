import { defineConfig } from "vitest/config";
import { config } from "dotenv";

// Tests hit the real Supabase DEV project (no local Docker stack on this
// machine — see README "Supabase") using credentials from .env.local.
// Passed explicitly via test.env (not just a mutated process.env) because
// Vitest's test files run in a separate worker context that doesn't
// automatically inherit env vars set by this config file's own process.
const { parsed } = config({ path: ".env.local" });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    env: parsed,
    // All test files hit the same live remote Supabase project (no local
    // Docker stack — see README "Supabase"), including real
    // signInWithPassword calls against Supabase Auth's rate limiter.
    // Running files in parallel workers multiplies concurrent auth load
    // for no benefit here, and previously tripped that rate limit once a
    // second test file was added. Sequential is the right default for
    // this project, not just a workaround.
    fileParallelism: false,
  },
});
