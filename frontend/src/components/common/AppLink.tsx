import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";

type LinkExtras = Omit<ComponentProps<typeof Link>, "to" | "children">;

/**
 * `Link` with a plain-string `to`. The role sub-routes are assembled at runtime
 * (see router.tsx) so they aren't in the router's literal path union; this keeps
 * navigation to them from tripping the strict `to` type at every call site.
 */
export function AppLink({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & LinkExtras) {
  return (
    <Link to={to} {...rest}>
      {children}
    </Link>
  );
}
