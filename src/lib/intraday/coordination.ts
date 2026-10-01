export interface UpcomingOvernightRun {
  id: number;
  sessionCloseAt: Date | null;
}

/** Reserve shared capital when an intraday maximum hold could cross an overnight buy window. */
export function overlappingOvernightRun(
  runs: UpcomingOvernightRun[],
  nowMs: number,
  maxHoldMinutes: number,
  overnightBuyLeadMinutes: number,
): UpcomingOvernightRun | null {
  const latestSafeExit = nowMs + (maxHoldMinutes + 5) * 60_000;
  return runs.find((run) => {
    if (!run.sessionCloseAt) return false;
    const closeMs = run.sessionCloseAt.getTime();
    const buyWindowMs = closeMs - overnightBuyLeadMinutes * 60_000;
    return nowMs < closeMs && latestSafeExit >= buyWindowMs;
  }) ?? null;
}
