-- Corrects 20260817104813's part D. That migration gave service_role an
-- explicit whitelist (10 tables, 6 functions) sized to what
-- tests/helpers.ts's fixture setup/teardown happened to need through
-- the service-role Data API — the wrong layer to solve it in:
-- test-infrastructure convenience was shaping the production grant
-- surface. Do not edit 104813 to fix this — it was already applied to
-- DEV and applied migrations are immutable; correct forward instead.
--
-- Fixture setup/teardown (and this project's own security_audit_*()
-- test calls) now go through a direct Postgres connection (`testDb` in
-- tests/helpers.ts, backed by TEST_DATABASE_URL — a local/CI-only
-- secret, never in Vercel, never pointed at PROD) that carries its own
-- access. service_role no longer needs any of 104813's part D grants to
-- make the test suite pass, so they come back out here, restoring the
-- target model 20260817104813's part A/B already established: anon and
-- authenticated get only their explicit whitelists (unchanged, still
-- enforced by tests/security-grants-regression.test.ts), service_role
-- gets nothing beyond PROD's own pre-existing MAINTAIN/REFERENCES/
-- TRIGGER/TRUNCATE table-maintenance baseline (not touched here — see
-- 104813's part A/B comments for why that stays), and no default
-- privilege hands any of the three broad access on a future object.
--
-- If a genuine application runtime need for createAdminClient() shows
-- up later (a webhook, a background job), grant exactly what it needs
-- in that feature's own migration — do not restore this whitelist
-- wholesale.

revoke select, insert, update, delete on all tables in schema public from service_role;
revoke execute on all functions in schema public from service_role;
