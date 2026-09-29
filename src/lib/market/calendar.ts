import type { Exchange, TimeEvent } from "../t212/client";

export interface Session {
  open: Date;
  close: Date;
}

/**
 * Regular-session windows for a working schedule, from T212's own time events,
 * so holidays and early closes are handled by the data, not by our assumptions.
 * Lunch breaks (BREAK_START/END) are ignored: we only need first OPEN and final CLOSE.
 */
export function sessionsFromEvents(events: TimeEvent[]): Session[] {
  const sorted = [...events]
    .filter((e) => e.type === "OPEN" || e.type === "CLOSE")
    .sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const out: Session[] = [];
  let open: Date | null = null;
  for (const e of sorted) {
    if (e.type === "OPEN") open = new Date(e.date);
    else if (open) {
      out.push({ open, close: new Date(e.date) });
      open = null;
    }
  }
  return out;
}

/** The session containing `now`, or the next one to start. */
export function currentOrNextSession(sessions: Session[], now: Date): Session | null {
  return sessions.find((s) => s.close > now) ?? null;
}

/** First session that opens strictly after `after` (the exit session for a position bought before `after`). */
export function nextSessionAfter(sessions: Session[], after: Date): Session | null {
  return sessions.find((s) => s.open > after) ?? null;
}

export function scheduleFor(exchanges: Exchange[], workingScheduleId: number) {
  for (const ex of exchanges) {
    const ws = ex.workingSchedules.find((w) => w.id === workingScheduleId);
    if (ws) return { exchange: ex.name, sessions: sessionsFromEvents(ws.timeEvents) };
  }
  return null;
}

export const minutes = (n: number) => n * 60_000;
