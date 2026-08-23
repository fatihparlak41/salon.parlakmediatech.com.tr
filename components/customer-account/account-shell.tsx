"use client";

import type { ReactNode } from "react";
import { Link, usePathname } from "@/lib/i18n/navigation";
import { signOutAction } from "@/lib/modules/auth/actions";
import { Button } from "@/components/ui/button";

/**
 * Deliberately its own small header, not TenantAppShell — that sidebar
 * shell is built around a tenant (badge, role name, staff-nav icons),
 * which would visually imply "salon staff app" for a customer here.
 * /account never reuses /app/[tenantSlug]'s chrome, same as it never
 * reuses its routes (2G.1 section 5).
 */
export function AccountShell({
  navLabels,
  signOutLabel,
  children,
}: {
  navLabels: { home: string; appointments: string; profile: string };
  signOutLabel: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const items = [
    { href: "/account", label: navLabels.home },
    { href: "/account/appointments", label: navLabels.appointments },
    { href: "/account/profile", label: navLabels.profile },
  ];

  return (
    <div className="bg-background flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav className="flex items-center gap-1">
            {items.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              {signOutLabel}
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
