-- Faz 2F: public guest booking needs retry-safety. A customer on a slow
-- connection may double-click "Randevuyu Oluştur" or resubmit after a
-- refresh; without an idempotency mechanism that creates two identical
-- appointments. No existing column/table serves this purpose (checked:
-- zero idempotency/client-key/request-id-flavored columns anywhere in
-- public schema before this migration).
--
-- Design: the client generates one random UUID per booking *attempt* and
-- resends the same value on any retry of that same attempt (a fresh
-- "Randevuyu Oluştur" click, e.g. after changing the selection, must use
-- a new key). create_guest_booking (next migration) checks
-- (tenant_id, idempotency_key) before inserting:
--   - no existing row  -> proceed, insert normally.
--   - existing row, same branch/service/start/customer -> return the
--     existing appointment's confirmation instead of inserting again
--     (idempotent replay).
--   - existing row, different payload under the same key -> reject
--     (BK007) rather than silently returning stale data or overwriting.
--
-- Nullable: staff-created appointments (create_appointment, unchanged)
-- never set this. Scoped to tenant_id, not global, so the same client
-- UUID colliding across two unrelated tenants (astronomically unlikely,
-- but the index must still be correct) can never conflict. Partial
-- index (WHERE idempotency_key IS NOT NULL) keeps NULLs (the common
-- staff-booking case) out of the uniqueness check entirely — a bare
-- UNIQUE index already treats NULLs as pairwise-distinct in Postgres, so
-- the WHERE clause here is belt-and-suspenders documentation of intent,
-- and keeps the index smaller.
alter table public.appointments
  add column idempotency_key uuid;

create unique index appointments_tenant_idempotency_key_idx
  on public.appointments (tenant_id, idempotency_key)
  where idempotency_key is not null;
