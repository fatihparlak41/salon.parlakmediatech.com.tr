# Hosted acceptance suites

`*.hosted.ts` files here run against a REAL hosted Supabase project and a LOCAL copy of the app. They are not picked up by the default `vitest run` and must never be pointed at production.

## Safety model (`guard.ts`, unit-tested by `tests/hosted-guard.test.ts`)

The run is refused unless **all** of these hold, so a wrong environment fails loudly before any write:

- `HOSTED_ACCEPTANCE_PROJECT_REF` is a project ref, and `HOSTED_ACCEPTANCE_SUPABASE_URL` is exactly `https://<ref>.supabase.co`
- the database login in `HOSTED_ACCEPTANCE_DATABASE_URL` is `postgres.<ref>` (the same project)
- `HOSTED_ACCEPTANCE_CONFIRM` carries the confirmation phrase written in `guard.ts`
- the app under test is local (`HOSTED_ACCEPTANCE_APP_URL`, default `http://localhost:3100`)
- the database has the marker table `public.hosted_acceptance_disposable_marker` and **no tenant** whose slug does not start with `h-`

## Running

1. Create a throw-away project (never production, never the dev project). Apply the migrations. On that project only, run once:
   `create table public.hosted_acceptance_disposable_marker (id int primary key default 1);`
2. Set the project's Auth to the values you want to verify (Confirm email on, minimum password length 8, Site URL and redirect list for the local app).
3. Export the `HOSTED_ACCEPTANCE_*` variables in your own shell (keys and the database password are never stored in the repository) and start the app locally against that project.
4. `npm run test:hosted`
5. Delete the project afterwards and verify it is gone.

Only synthetic users and tenants are created (slugs start with `h-`) and they are removed at the end of the run.
