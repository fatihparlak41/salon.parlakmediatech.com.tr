// SAAS.1C.2c-A1 - enforcement registry tooling.
//   node scripts/billing-registry.mjs sql        prints the INSERT statements that seed private.billing_categories / billing_action_registry
//   node scripts/billing-registry.mjs check      verifies the fixture's own consistency (every category defined, key formats, no duplicates)
// The SOURCE OF TRUTH is tests/fixtures/billing-enforcement-registry.json. The migration seed is generated from it, and tests/saas1c2c-a1-*.test.ts
// compare the fixture, the seeded database tables and the live catalog (every API-reachable write path must be registered, or the build gate fails).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "tests", "fixtures", "billing-enforcement-registry.json"), "utf8"));
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function problems() {
  const out = [];
  const cats = new Set();
  for (const c of fixture.categories) {
    if (cats.has(c.category)) out.push("duplicate category " + c.category);
    cats.add(c.category);
    if (!/^[A-Z_]+$/.test(c.category)) out.push("bad category name " + c.category);
    if (!["allow", "block"].includes(c.read_only) || !["allow", "block"].includes(c.blocked)) out.push("bad policy for " + c.category);
    if (!Number.isInteger(c.first_stage) || c.first_stage < 0 || c.first_stage > 4) out.push("bad first_stage for " + c.category);
  }
  const keys = new Set();
  for (const a of fixture.actions) {
    if (keys.has(a.action_key)) out.push("duplicate action " + a.action_key);
    keys.add(a.action_key);
    if (!cats.has(a.category)) out.push("unknown category " + a.category + " for " + a.action_key);
    const ok = a.kind === "function" ? /^fn:[a-z0-9_]+$/.test(a.action_key) : /^table:[a-z0-9_]+:(INSERT|UPDATE|DELETE)$/.test(a.action_key);
    if (!ok || !["function", "table_op"].includes(a.kind)) out.push("bad key / kind " + a.action_key);
  }
  return out;
}

const mode = process.argv[2];
if (mode === "check") {
  const p = problems();
  if (p.length) {
    console.error(p.join("\n"));
    process.exit(1);
  }
  console.log(`ok: ${fixture.categories.length} categories, ${fixture.actions.length} actions`);
} else if (mode === "sql") {
  const p = problems();
  if (p.length) throw new Error(p.join("; "));
  const cat = fixture.categories.map((c) => `  (${lit(c.category)}, ${lit(c.read_only)}, ${lit(c.blocked)}, ${c.first_stage}, ${lit(c.description)})`).join(",\n");
  const act = [...fixture.actions].sort((a, b) => a.action_key.localeCompare(b.action_key)).map((a) => `  (${lit(a.action_key)}, ${lit(a.kind)}, ${lit(a.category)})`).join(",\n");
  console.log(`insert into private.billing_categories (category, read_only, blocked, first_stage, description) values\n${cat};\n`);
  console.log(`insert into private.billing_action_registry (action_key, kind, category) values\n${act};`);
} else {
  console.error("usage: node scripts/billing-registry.mjs sql|check");
  process.exit(2);
}
