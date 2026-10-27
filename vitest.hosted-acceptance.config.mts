// Hosted acceptance config — runs tests/hosted/*.hosted.ts against a DISPOSABLE hosted Supabase project and a LOCAL app.
//
//   npm run test:hosted        (after exporting the HOSTED_ACCEPTANCE_* variables listed in tests/hosted/guard.ts)
//
// Deliberately does NOT load .env.local (that file carries the DEV project's credentials). Every credential comes from the operator's
// shell, and readHostedEnv() throws unless they all describe the same disposable project. Never part of the default `vitest run`.
import path from "node:path";
import { defineConfig } from "vitest/config";
import { readHostedEnv } from "./tests/hosted/guard";

const hosted = readHostedEnv();
const rootDir = __dirname.replace(/\\/g, "/");

export default defineConfig({
  root: rootDir,
  test: {
    environment: "node",
    include: ["tests/hosted/**/*.hosted.ts"],
    testTimeout: 90000,
    hookTimeout: 180000,
    fileParallelism: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: hosted.supabaseUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: hosted.publishableKey,
      SUPABASE_SERVICE_ROLE_KEY: hosted.serviceRoleKey,
      TEST_DATABASE_URL: hosted.databaseUrl,
      HOSTED_ACCEPTANCE_APP_URL: hosted.appUrl,
    },
  },
  resolve: {
    alias: {
      "@": rootDir,
      "server-only": path.join(rootDir, "tests/stubs/server-only-stub.ts"),
    },
  },
});
