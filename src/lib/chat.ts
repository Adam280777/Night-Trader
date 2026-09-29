/**
 * Conversation sessions.
 *
 * A conversation ends when you stop talking. Rather than growing one endless thread that still
 * shows last week's questions, messages are grouped by silence: a gap longer than the idle window
 * starts a fresh session, so coming back later gives you a clean page. Nothing is deleted by this -
 * the model's actual knowledge lives in its own records, not in the chat log.
 */

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

/** Six hours of quiet ends a conversation. */
export const SESSION_IDLE_MS = 6 * 3_600_000;

/**
 * The messages belonging to the conversation that is still open, oldest first. Returns nothing once
 * the last exchange has itself gone stale, which is what makes the page reset on its own.
 */
export function currentSession<T extends Pick<ChatMessage, "createdAt">>(rows: T[], now = Date.now(), idleMs = SESSION_IDLE_MS): T[] {
  let start = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].createdAt.getTime() - rows[i - 1].createdAt.getTime() > idleMs) start = i;
  }
  const session = rows.slice(start);
  const last = session.at(-1);
  return last && now - last.createdAt.getTime() > idleMs ? [] : session;
}
