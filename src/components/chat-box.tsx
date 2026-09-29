"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";

interface Msg {
  id: number | string;
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = ["Why did you pick your last stock?", "What have you learned so far?", "What was your worst trade and why?", "Are you beating the simple screener?"];

export function ChatBox({ initial }: { initial: Msg[] }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setError(null);
    setBusy(true);
    setText("");
    setMsgs((m) => [...m, { id: `u${Date.now()}`, role: "user", content: message }]);
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

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-96 flex-col rounded-xl border border-border bg-surface">
      <div className="flex-1 space-y-3 overflow-y-auto p-5" aria-live="polite">
        {msgs.length === 0 && (
          <div className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted">Ask about any decision, trade or lesson. Answers come from the real records in the database.</p>
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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about a trade, a lesson, or how the AI thinks…" className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" />
        <button disabled={busy || !text.trim()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:text-black">
          <Send className="size-4" aria-hidden /> Send
        </button>
      </form>
    </div>
  );
}
