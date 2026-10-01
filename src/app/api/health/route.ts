import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getSettings } from "@/lib/config";
import { getWorkerStatus } from "@/lib/queries";
import { anyUnknownOrders } from "@/lib/t212/safeOrder";

export const dynamic = "force-dynamic";

function validSecret(expected: string, supplied: string | null): boolean {
  if (!supplied?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function GET(req: Request) {
  const secret = process.env.HEALTH_SECRET?.trim();
  if (secret && !validSecret(secret, req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const settings = await getSettings();
  const [worker, unknownOrder] = await Promise.all([getWorkerStatus(settings.ops.workerStaleMinutes), anyUnknownOrders()]);
  const ok = worker.alive && !unknownOrder;
  const detail = {
      ok,
      worker: worker.alive ? "online" : "offline",
      trading: unknownOrder ? "paused_unknown_order" : settings.killSwitch ? "paused_kill_switch" : "available",
    };
  return NextResponse.json(
    secret ? detail : { ok },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
