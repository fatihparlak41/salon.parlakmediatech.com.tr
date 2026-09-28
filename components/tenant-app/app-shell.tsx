"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "@/lib/i18n/navigation";
import { Link } from "@/lib/i18n/navigation";
import { Menu as MenuIcon, LogOut, Bell, UserRound } from "lucide-react";
import { SignOutForm } from "@/components/auth/sign-out-form";
import { PushDeviceGuard } from "@/components/pwa/push-device-guard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export type TenantNavItem = {
  href: string;
  label: string;
  icon: ReactNode;
};

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function NavLinks({
  items,
  basePath,
  onNavigate,
}: {
  items: TenantNavItem[];
  basePath: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const fullHref = `${basePath}${item.href}`;
        const isActive =
          item.href === ""
            ? pathname === basePath
            : pathname === fullHref || pathname.startsWith(`${fullHref}/`);

        return (
          <Link
            key={fullHref}
            href={fullHref}
            onClick={onNavigate}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground"
            aria-current={isActive ? "page" : undefined}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export type UserMenuLabels = {
  account: string;
  notifications: string;
};

function UserMenu({
  roleName,
  userEmail,
  signOutLabel,
  basePath,
  labels,
  onNavigate,
}: {
  roleName: string;
  userEmail: string;
  signOutLabel: string;
  basePath: string;
  labels: UserMenuLabels;
  onNavigate?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50">
        <Avatar className="size-8">
          <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-xs">
            {initialsFrom(userEmail)}
          </AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-sidebar-foreground">
            {userEmail}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {roleName}
          </span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{userEmail}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {/* Faz ACCOUNT.1 — personal, per-member pages. Deliberately NOT gated
            on any permission (unlike the "Ayarlar" nav entry): every active
            member of the salon, whatever their role, can reach their own
            profile and device notification controls from here. */}
        <DropdownMenuGroup>
          <DropdownMenuItem
            render={<Link href={`${basePath}/account`} onClick={onNavigate} />}
            className="cursor-pointer"
          >
            <UserRound />
            {labels.account}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href={`${basePath}/account#notifications`} onClick={onNavigate} />}
            className="cursor-pointer"
          >
            <Bell />
            {labels.notifications}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <SignOutForm>
          <button type="submit" className="w-full">
            <DropdownMenuItem variant="destructive" className="cursor-pointer">
              <LogOut />
              {signOutLabel}
            </DropdownMenuItem>
          </button>
        </SignOutForm>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TenantAppShell({
  tenantSlug,
  tenantName,
  roleName,
  userEmail,
  navItems,
  signOutLabel,
  userMenuLabels,
  deviceOwnerTag,
  children,
}: {
  tenantSlug: string;
  tenantName: string;
  roleName: string;
  userEmail: string;
  navItems: TenantNavItem[];
  signOutLabel: string;
  userMenuLabels: UserMenuLabels;
  /** Server-computed tag of the signed-in user (lib/pwa/device-owner-tag.ts). */
  deviceOwnerTag: string;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const basePath = `/app/${tenantSlug}`;

  return (
    <div className="bg-background flex min-h-screen">
      <PushDeviceGuard ownerTag={deviceOwnerTag} />
      {/* Desktop sidebar */}
      <aside className="bg-sidebar border-sidebar-border sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <Badge variant="secondary" className="h-6 px-2.5 text-sm font-semibold">
            {tenantName}
          </Badge>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <NavLinks items={navItems} basePath={basePath} />
        </div>
        <div className="border-sidebar-border border-t p-3">
          <UserMenu
            roleName={roleName}
            userEmail={userEmail}
            signOutLabel={signOutLabel}
            basePath={basePath}
            labels={userMenuLabels}
          />
        </div>
      </aside>

      {/* Mobile header + slide-over nav */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/95 sticky top-0 z-40 flex items-center gap-3 border-b px-4 py-3 backdrop-blur-sm md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger
              render={<Button variant="ghost" size="icon" aria-label="Menü" />}
            >
              <MenuIcon />
            </SheetTrigger>
            <SheetContent side="left" className="bg-sidebar w-72 p-0">
              <SheetTitle className="sr-only">{tenantName}</SheetTitle>
              <SheetDescription className="sr-only">Salon navigasyonu</SheetDescription>
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-2 px-4 py-4">
                  <Badge variant="secondary" className="h-6 px-2.5 text-sm font-semibold">
                    {tenantName}
                  </Badge>
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-2">
                  <NavLinks
                    items={navItems}
                    basePath={basePath}
                    onNavigate={() => setMobileOpen(false)}
                  />
                </div>
                <div className="border-sidebar-border border-t p-3">
                  <UserMenu
                    roleName={roleName}
                    userEmail={userEmail}
                    signOutLabel={signOutLabel}
                    basePath={basePath}
                    labels={userMenuLabels}
                    onNavigate={() => setMobileOpen(false)}
                  />
                </div>
              </div>
            </SheetContent>
          </Sheet>
          <Badge variant="secondary" className="h-6 px-2.5 text-sm font-semibold">
            {tenantName}
          </Badge>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
