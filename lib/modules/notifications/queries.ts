import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  parseNotificationPreferences,
  type NotificationPreferences,
} from "./preference-keys";

/**
 * Faz ACCOUNT.1 — the caller's OWN notification category preferences for
 * one tenant. get_my_notification_preferences derives the membership from
 * auth.uid() inside the database (Faz NOTIF.2A) and raises NF003 when the
 * caller has no active membership in p_tenant_id, so there is no argument
 * here that could name another person's row; tenantId only says which of
 * the caller's own memberships to read.
 *
 * Any error or unexpected shape collapses to null — the account page then
 * hides the category list instead of rendering guessed defaults.
 */
export async function getMyNotificationPreferences(
  tenantId: string,
): Promise<NotificationPreferences | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_notification_preferences", {
    p_tenant_id: tenantId,
  });
  if (error) return null;
  return parseNotificationPreferences(data);
}
