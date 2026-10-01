"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Info, RefreshCw, Search, TriangleAlert } from "lucide-react";

type Level = "info" | "warn" | "error";
interface Row {
  id: number;
  ts: number;
  level: Level;
  source: string;
  message: string;
  runId: number | null;
  detail: Record<string, unknown> | null;
}
interface Page {
  rows: Row[];
  total: number;
  nextBefore: number | null;
  sources: string[];
}

const LEVELS: Level[] = ["info", "warn", "error"];
const ICON = { info: Info, warn: TriangleAlert, error: AlertTriangle } as const;
const TONE = { info: "text-muted", warn: "text-warn", error: "text-danger" } as const;

const stamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** A datetime-local value is wall-clock time in the browser's zone; the API wants an instant. */
const instant = (local: string) => (local ? String(new Date(local).getTime()) : "");

export function LogViewer() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [levels, setLevels] = useState<Level[]>([]);
  const [source, setSource] = useState("");
  const [runId, setRunId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ.trim()) p.set("q", debouncedQ.trim());
    if (levels.length) p.set("level", levels.join(","));
    if (source) p.set("source", source);
    if (runId.trim()) p.set("runId", runId.trim());
    if (from) p.set("from", instant(from));
    if (to) p.set("to", instant(to));
    return p;
  }, [debouncedQ, levels, source, runId, from, to]);

  const load = useCallback(
    async (before: number | null) => {
      inflight.current?.abort();
      const ctl = new AbortController();
      inflight.current = ctl;
      setLoading(true);
      setError(null);
      try {
        const p = new URLSearchParams(params);
        if (before !== null) p.set("before", String(before));
        const r = await fetch(`/api/logs?${p}`, { signal: ctl.signal });
        if (!r.ok) throw new Error(r.status === 401 ? "Signed out. Reload to sign in again." : `Server said ${r.status}`);
        const j = (await r.json()) as Page;
        setRows((prev) => (before === null ? j.rows : [...prev, ...j.rows]));
        setTotal(j.total);
        setNext(j.nextBefore);
        setSources(j.sources);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError(String(e instanceof Error ? e.message : e));
      } finally {
        if (inflight.current === ctl) setLoading(false);
      }
    },
    [params],
  );

  useEffect(() => {
    // Any filter change (or a manual refresh) starts again from the newest line.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(null);
    return () => inflight.current?.abort();
  }, [load, tick]);

  const toggleLevel = (l: Level) => setLevels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
  const csvHref = `/api/logs?${new URLSearchParams({ ...Object.fromEntries(params), format: "csv" })}`;
  const filtered = params.size > 0;
  const input = "rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent";

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search messages and sources"
              aria-label="Search logs"
              className={`${input} w-full pl-8`}
            />
          </label>
          <div className="flex gap-1" role="group" aria-label="Level">
            {LEVELS.map((l) => (
              <button
                key={l}
                onClick={() => toggleLevel(l)}
                aria-pressed={levels.includes(l)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium capitalize ${
                  levels.includes(l) ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:border-accent"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source" className={input}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input value={runId} onChange={(e) => setRunId(e.target.value.replace(/\D/g, ""))} placeholder="Run #" aria-label="Run number" inputMode="numeric" className={`${input} w-24`} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <label className="flex items-center gap-1.5">
            From
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={input} />
          </label>
          <label className="flex items-center gap-1.5">
            To
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={input} />
          </label>
          {filtered && (
            <button
              onClick={() => {
                setQ("");
                setDebouncedQ("");
                setLevels([]);
                setSource("");
                setRunId("");
                setFrom("");
                setTo("");
              }}
              className="rounded-lg px-2 py-1 hover:text-accent"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <button onClick={() => setTick((n) => n + 1)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 hover:border-accent hover:text-accent">
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
              Refresh
            </button>
            <a href={csvHref} download className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent-soft px-2.5 py-1.5 font-medium text-accent">
              <Download className="size-3.5" aria-hidden />
              Download CSV
            </a>
          </span>
        </div>
        <p className="text-xs text-muted">
          {total.toLocaleString()} matching line{total === 1 ? "" : "s"}
          {filtered ? " (filters applied)" : ""}. The CSV holds every match up to 20,000, oldest first, with UTC and London times. Send it over and I can read exactly what happened.
        </p>
      </section>

      {error && <div className="rounded-xl border border-danger/40 bg-surface p-3 text-sm text-danger">{error}</div>}

      <section className="rounded-xl border border-border bg-surface">
        <ul className="max-h-[65vh] divide-y divide-border overflow-y-auto font-mono text-xs">
          {rows.map((r) => {
            const Icon = ICON[r.level];
            return (
              <li key={r.id} className="px-4 py-2">
                <div className="flex gap-2">
                  <Icon className={`mt-0.5 size-3.5 shrink-0 ${TONE[r.level]}`} aria-hidden />
                  <span className="tabular shrink-0 text-muted">{stamp.format(new Date(r.ts))}</span>
                  <span className="shrink-0 text-muted">{r.source}</span>
                  {r.runId !== null && <span className="shrink-0 text-muted">#{r.runId}</span>}
                  <span className={`min-w-0 break-words whitespace-pre-wrap ${r.level === "error" ? "text-danger" : r.level === "warn" ? "text-warn" : ""}`}>{r.message}</span>
                </div>
                {r.detail && (
                  <details className="mt-1 ml-5 text-[11px] text-muted">
                    <summary className="cursor-pointer hover:text-fg">Structured detail</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-bg p-2 whitespace-pre-wrap text-fg">{JSON.stringify(r.detail, null, 2)}</pre>
                  </details>
                )}
              </li>
            );
          })}
          {rows.length === 0 && !loading && <li className="px-4 py-6 text-muted">{filtered ? "Nothing matches those filters." : "Nothing logged yet."}</li>}
          {next !== null && (
            <li className="px-4 py-3 text-center">
              <button onClick={() => void load(next)} disabled={loading} className="rounded-lg border border-border px-3 py-1.5 text-muted hover:border-accent hover:text-accent disabled:opacity-50">
                {loading ? "Loading" : "Load older"}
              </button>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
