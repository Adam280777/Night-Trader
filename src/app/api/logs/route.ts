import { NextResponse } from "next/server";
import { MAX_EXPORT, MAX_PAGE, logSources, logsToCsv, parseLevels, queryLogs, type LogQuery } from "@/lib/logs";

export const dynamic = "force-dynamic";

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Accepts epoch milliseconds or anything Date can parse. */
const time = (v: string | null): number | undefined => {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  const t = Number.isFinite(n) ? n : Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const csv = p.get("format") === "csv";
  const filter: LogQuery = {
    q: p.get("q") ?? undefined,
    levels: parseLevels(p.get("level")),
    sources: p.get("source")?.split(",").map((s) => s.trim()).filter(Boolean),
    runId: num(p.get("runId")),
    from: time(p.get("from")),
    to: time(p.get("to")),
    before: csv ? undefined : num(p.get("before")),
    limit: csv ? Math.min(num(p.get("limit")) ?? MAX_EXPORT, MAX_EXPORT) : Math.min(num(p.get("limit")) ?? 200, MAX_PAGE),
  };

  if (csv) {
    const { rows, total } = await queryLogs(filter);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return new Response(logsToCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="overnight-trader-logs-${stamp}.csv"`,
        "X-Rows-Exported": String(rows.length),
        "X-Rows-Matching": String(total),
        "Cache-Control": "no-store",
      },
    });
  }

  const [result, sources] = await Promise.all([queryLogs(filter), logSources()]);
  return NextResponse.json({ ...result, sources });
}
