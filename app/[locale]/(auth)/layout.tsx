// Route groups have no URL of their own, so Next's generated LayoutRoutes
// union has no entry for "(auth)" — the typed LayoutProps helper doesn't
// cover this case, hence the plain React.ReactNode type here.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
