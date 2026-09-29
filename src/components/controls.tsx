"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { OctagonAlert, Power } from "lucide-react";

export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

async function post(url: string, body?: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j;
}

export function KillSwitch({ on }: { on: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      disabled={pending}
      onClick={() => start(async () => { await post("/api/kill-switch", { on: !on }); router.refresh(); })}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60 ${
        on ? "bg-danger text-white hover:opacity-90" : "border border-danger text-danger hover:bg-danger-soft"
      }`}
      title={on ? "Kill switch is ON: no new trades will be placed. Click to resume." : "Stop all new trading immediately."}
    >
      {on ? <Power className="size-4" aria-hidden /> : <OctagonAlert className="size-4" aria-hidden />}
      {on ? "Kill switch ON. Resume" : "Kill switch"}
    </button>
  );
}

export function ApprovalButtons({ decisionId, deadline }: { decisionId: number; deadline: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [deadline]);

  const act = (action: "approve" | "reject") =>
    start(async () => {
      try {
        setError(null);
        await post(`/api/decisions/${decisionId}/approval`, { action });
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button disabled={pending} onClick={() => act("approve")} className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60 dark:text-black">
        Approve trade
      </button>
      <button disabled={pending} onClick={() => act("reject")} className="rounded-lg border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-2 disabled:opacity-60">
        Reject
      </button>
      {left != null && (
        <span className="tabular text-sm text-muted">
          {left > 0 ? `Auto-skips in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Window closed"}
        </span>
      )}
      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}

export function ResolveOrderButton({ orderId }: { orderId: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      disabled={pending}
      onClick={() => {
        if (!confirm("Only do this after checking Trading 212 yourself. If the order actually went through, close that position manually. Continue?")) return;
        start(async () => { await post(`/api/orders/${orderId}/resolve`); router.refresh(); });
      }}
      className="rounded-lg border border-current px-3 py-1.5 text-xs font-semibold hover:opacity-80 disabled:opacity-60"
    >
      I checked Trading 212: resume trading
    </button>
  );
}
