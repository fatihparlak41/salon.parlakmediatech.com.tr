import type trMessages from "@/messages/tr.json";

/**
 * Faz FIN.1C.1 — the StaffFinance message namespace, typed from the catalog itself. The server page passes
 * messages.StaffFinance to the client components as one `labels` prop (the same page-client pattern as the expenses page), so
 * no client component needs the next-intl runtime and the jsdom tests build the exact same labels from the same JSON.
 */
export type StaffFinanceLabels = (typeof trMessages)["StaffFinance"];
