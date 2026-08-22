import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { PublicBookingContext } from "./client-queries";

/** Server-side mirror of fetchPublicBookingContext, used once by
 * app/[locale]/book/[tenantSlug]/page.tsx for the initial render so the
 * page has real content on first paint instead of a loading skeleton —
 * most visitors arrive from Instagram/WhatsApp/a QR code straight into
 * this page, not via client-side navigation from elsewhere in the app. */
export async function getPublicBookingContext(tenantSlug: string): Promise<PublicBookingContext> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_public_booking_context", { p_tenant_slug: tenantSlug });
  if (error || !data) return { bookable: false };
  return data as unknown as PublicBookingContext;
}
