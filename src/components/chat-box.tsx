"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Trash2 } from "lucide-react";
import { SESSION_IDLE_MS } from "@/lib/chat";

interface Msg {
  id: number | string;
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "Why did you pick your last stock?",
  "What have you learned so far?",
  "What are you researching right now?",
  "How are you configured right now?",
  "Are you well calibrated?",
  "What was your worst trade and why?",
];

export function ChatBox({ initial }: { initial: Msg[] }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const lastActivity = useRef(0);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  // Any new message counts as activity. Tracked in an effect rather than in the send handler so
  // the render phase stays free of clock reads.
  useEffect(() => {
    lastActivity.current = Date.now();
  }, [msgs]);

  // The server groups messages into conversations by silence, but a tab left open all night would
  // otherwise still be showing yesterday's. Retire it on the same rule the server uses.
  useEffect(() => {
    const t = setInterval(() => {
      if (lastActivity.current > 0 && Date.now() - lastActivity.current > SESSION_IDLE_MS) setMsgs([]);
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setError(null);
    setBusy(true);
    setText("");
    setMsgs((m) => [...m, { id: `u${m.length}-${message.length}`, role: "user", content: message }]);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Request failed");
      setMsgs((m) => [...m, { id: j.id, role: "assistant", content: j.content }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setClearing(true);
    setError(null);
    try {
      const r = await fetch("/api/chat", { method: "DELETE" });
      if (!r.ok) throw new Error("Could not clear the conversation");
      setMsgs([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-96 flex-col rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
        <span className="text-xs text-muted">{msgs.length > 0 ? `${msgs.length} message${msgs.length === 1 ? "" : "s"} in this conversation` : "New conversation"}</span>
        <button
          onClick={clear}
          disabled={clearing || msgs.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted"
        >
          <Trash2 className="size-3.5" aria-hidden /> Clear
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-5" aria-live="polite">
        {msgs.length === 0 && (
          <div className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted">
              Ask about any decision, trade, lesson or setting. Answers are computed from the real records in the database, so
              the model can only tell you things it actually did. Conversations start fresh after a few hours of quiet.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-surface-2">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-accent text-white dark:text-black" : "bg-surface-2"}`}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="text-sm text-muted">Thinking…</div>}
        {error && <div className="text-sm text-danger">{error}</div>}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="flex gap-2 border-t border-border p-3"
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about a trade, a lesson, a setting, or how the model reasons…" className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
        <button disabled={busy || !text.trim()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:text-black">
          <Send className="size-4" aria-hidden /> Send
        </button>
      </form>
    </div>
  );
}
