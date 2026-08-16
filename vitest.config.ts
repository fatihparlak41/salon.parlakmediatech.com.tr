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
  },
});
