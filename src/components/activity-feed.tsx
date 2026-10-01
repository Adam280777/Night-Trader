"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, BookOpen, CircleDot, Info, Pause, Play, TriangleAlert } from "lucide-react";
import type { ActivityFeedData } from "@/lib/activity";

type Feed = ActivityFeedData;

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function time(ms: number, local: boolean): string {
  const d = new Date(ms);
  // Until the component has mounted, the server and the browser must agree, and they only do in
  // UTC. Local time is swapped in straight after, which is what you actually want to read.
  if (!local) return d.toISOString().slice(11, 19);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const LEVEL_ICON = { info: Info, warn: TriangleAlert, error: AlertTriangle } as const;
const LEVEL_CLASS = { info: "text-muted", warn: "text-warn", error: "text-danger" } as const;
const subscribeMounted = () => () => {};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular mt-1 text-xl font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function ActivityFeed({ initial }: { initial: Feed }) {
  const [feed, setFeed] = useState<Feed>(initial);
  const [live, setLive] = useState(true);
  const [failed, setFailed] = useState(false);
  const mounted = useSyncExternalStore(subscribeMounted, () => true, () => false);
  const liveRef = useRef(true);

  // Mirrored into a ref so the polling loop below can read the latest value without being torn
  // down and restarted every time it changes.
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    let stop = false;
    async function poll() {
      if (liveRef.current && document.visibilityState === "visible") {
        try {
          const r = await fetch("/api/activity", { cache: "no-store" });
          if (!r.ok) throw new Error();
          if (!stop) {
            setFeed(await r.json());
            setFailed(false);
          }
        } catch {
          if (!stop) setFailed(true);
        }
      }
      if (!stop) setTimeout(poll, 5000);
    }
    const t = setTimeout(poll, 5000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, []);

  const { run, knowledge, now } = feed;
  const beat = feed.heartbeatAt;
  const beatStale = !beat || now - beat > 5 * 60_000;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm">
          <CircleDot className={`size-4 ${beatStale ? "text-danger" : "text-accent"}`} aria-hidden />
          {beatStale ? (
            <span className="text-danger">The scheduler has not checked in{beat ? ` since ${ago(beat, now)}` : " yet"}.</span>
          ) : (
            <span className="text-muted">
              Scheduler checked in {ago(beat, now)}
              {feed.schedulerSource ? ` via ${feed.schedulerSource.replaceAll("-", " ")}` : ""}.
            </span>
          )}
          {failed && <span className="text-warn">· could not refresh</span>}
        </span>
        <button
          onClick={() => setLive((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-accent"
        >
          {live ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {live ? "Pause" : "Resume"}
        </button>
      </div>

      {feed.killSwitch && (
        <p className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          The kill switch is on. Nothing new will be bought; open positions are still managed to their exit.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Symbols known" value={String(knowledge.symbols)} hint={`${knowledge.researched} with stored research`} />
        <Stat label="Studied in the last hour" value={String(knowledge.studiedLastHour)} hint={feed.continuousResearch ? "Studying continuously" : "Continuous study is off"} />
        <Stat label="Mode" value={feed.tradingEnabled ? "Placing orders" : "Dry run"} hint={run ? `Last run was ${run.mode}` : undefined} />
        <Stat label="Featured run" value={run ? (run.active ? run.status.replace(/_/g, " ") : "idle") : "none yet"} hint={run ? `${run.strategy === "intraday_momentum" ? "Intraday" : "Overnight"} · ${run.market} · ${run.tradingDate}` : undefined} />
      </div>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">What it is doing now</h2>
        {run ? (
          <>
            <p className="mt-2 text-sm">
              <span className={run.active ? "text-accent" : "text-muted"}>{run.stage}</span>
              <span className="text-muted">
                {" "}
                · run #{run.id} · updated {ago(run.updatedAt, now)}
                {run.sessionCloseAt && run.active ? ` · ${Math.max(0, Math.round((run.sessionCloseAt - now) / 60_000))} min to the close` : ""}
              </span>
            </p>
            {run.error && <p className="mt-1 text-sm text-danger">{run.error}</p>}
            {feed.shortlist.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {feed.shortlist.map((c) => (
                  <li key={c.ticker} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">
                      <b>{c.ticker.replace(/_.*$/, "")}</b> <span className="text-muted">{c.name}</span>
                      {c.picked && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent uppercase">picked</span>}
                    </span>
                    <span className="tabular shrink-0 text-xs text-muted">
                      {c.score !== null ? c.score.toFixed(2) : "—"} ·{" "}
                      <span className={c.state === "researched" ? "text-accent" : c.state === "failed" ? "text-danger" : ""}>
                        {c.state === "queued" ? "waiting to be researched" : c.state}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">No run has been created yet. One is scheduled automatically ahead of each close.</p>
        )}
        {feed.scheduling.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted">
            {feed.scheduling.map((s) => (
              <li key={s.key}>
                <b>{s.label}</b> · {s.text} · checked {ago(s.at, now)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted uppercase">
          <BookOpen className="size-4" aria-hidden /> Recently studied
        </h2>
        <p className="mt-1 text-xs text-muted">
          The model works through the tradable universe all day, scoring names and reading their headlines, so a decision is
          made from research it already has rather than starting cold before the close.
        </p>
        {knowledge.recent.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing studied yet. The first round runs on the next spare tick.</p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {knowledge.recent.map((k) => (
              <li key={k.symbol} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">
                  <b>{k.symbol}</b> <span className="text-muted">{k.name}</span>
                </span>
                <span className="tabular shrink-0 text-xs text-muted">
                  score {k.score !== null ? k.score.toFixed(2) : "—"} · seen {k.observations}× · {k.researchedAt ? "researched" : "signals only"} · {ago(k.updatedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Log</h2>
        <ul className="mt-3 space-y-1.5 font-mono text-xs">
          {feed.events.map((e) => {
            const Icon = LEVEL_ICON[e.level];
            return (
              <li key={e.id} className="flex gap-2">
                <Icon className={`mt-0.5 size-3.5 shrink-0 ${LEVEL_CLASS[e.level]}`} aria-hidden />
                <span className="tabular shrink-0 text-muted">{time(e.ts, mounted)}</span>
                <span className="shrink-0 text-muted">{e.source}</span>
                <span className={e.level === "error" ? "text-danger" : e.level === "warn" ? "text-warn" : ""}>{e.message}</span>
              </li>
            );
          })}
          {feed.events.length === 0 && <li className="text-muted">Nothing logged yet.</li>}
        </ul>
      </section>
    </div>
  );
}
