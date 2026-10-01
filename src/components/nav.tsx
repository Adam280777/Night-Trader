"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Brain, History, LayoutDashboard, LogOut, MessageCircle, Radio, ScrollText, Settings, SlidersHorizontal, Wrench } from "lucide-react";

const ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/activity", label: "Live activity", icon: Radio },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/system", label: "System health", icon: Wrench },
  { href: "/history", label: "History", icon: History },
  { href: "/learning", label: "Learning", icon: Brain },
  { href: "/chat", label: "Ask the model", icon: MessageCircle },
  { href: "/quant", label: "Quant settings", icon: SlidersHorizontal },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  if (path === "/login") return null;
  return (
    <nav className="border-b border-border bg-surface md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex items-center gap-2 px-5 py-4 text-base font-semibold">
        <Activity className="size-5 text-accent" aria-hidden />
        Trading Bot
      </div>
      <ul className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
                  active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          router.push("/login");
          router.refresh();
        }}
        className="mx-3 mt-2 mb-3 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg md:absolute md:bottom-2 md:left-0 md:mx-3"
      >
        <LogOut className="size-4" aria-hidden />
        Sign out
      </button>
    </nav>
  );
}
