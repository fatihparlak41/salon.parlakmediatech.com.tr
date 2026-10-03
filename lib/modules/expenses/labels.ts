import type trMessages from "@/messages/tr.json";

/**
 * Faz FIN.1B.1 — the Expenses message namespace, typed from the catalog itself. The server page passes
 * messages.Expenses to the client components as one `labels` prop (the same page-client pattern as customers and appointments),
 * so no client component needs the next-intl runtime and the jsdom tests build the exact same labels from the same JSON.
 */
export type ExpenseLabels = (typeof trMessages)["Expenses"];
