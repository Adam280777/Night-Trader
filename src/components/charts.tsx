"use client";

import { Area, AreaChart, Bar, BarChart, Cell, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const GRID = "var(--border)";
const AXIS = { fontSize: 11, fill: "var(--muted)" };
const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--fg)" };

export function EquityChart({ data, currency }: { data: { ts: number; value: number }[]; currency: string }) {
  if (data.length < 2) return <p className="py-10 text-center text-sm text-muted">The equity curve appears after a couple of snapshots (the worker records one every 15 minutes).</p>;
  const min = Math.min(...data.map((d) => d.value));
  const max = Math.max(...data.map((d) => d.value));
  const pad = Math.max((max - min) * 0.2, max * 0.002);
  return (
    <div className="h-64" role="img" aria-label="Account value over time">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} />
          <YAxis domain={[min - pad, max + pad]} tick={AXIS} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => v.toFixed(0)} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => new Date(t as number).toLocaleString("en-GB")} formatter={(v) => [`${Number(v).toFixed(2)} ${currency}`, "Account value"]} />
          <Area type="monotone" dataKey="value" stroke="var(--accent)" strokeWidth={2} fill="url(#eq)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TradeReturnsChart({ data }: { data: { label: string; pct: number }[] }) {
  if (data.length === 0) return <p className="py-10 text-center text-sm text-muted">No closed trades yet.</p>;
  return (
    <div className="h-56" role="img" aria-label="Return of each closed trade">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
          <ReferenceLine y={0} stroke={GRID} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--surface-2)" }} formatter={(v) => [`${Number(v).toFixed(2)}%`, "Return"]} />
          <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.pct >= 0 ? "var(--accent)" : "var(--danger)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
