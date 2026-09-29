"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";

interface Status {
  t212Env: "demo" | "live";
  hasT212Keys: boolean;
  t212Source: string | null;
  t212KeyHint: string | null;
  hasOpenAI: boolean;
  openaiSource: string | null;
  openaiKeyHint: string | null;
  openaiModel: string;
}
type Result = { ok: boolean; detail: string };

const input = "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";

function Verdict({ r }: { r?: Result }) {
  if (!r) return null;
  const Icon = r.ok ? CheckCircle2 : XCircle;
  return (
    <p role="status" className={`mt-2 flex items-start gap-2 text-sm ${r.ok ? "text-accent" : "text-danger"}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden /> {r.detail}
    </p>
  );
}

export function ConnectionsForm({ initial }: { initial: Status }) {
  const router = useRouter();
  const [st, setSt] = useState(initial);
  const [env, setEnv] = useState(initial.t212Env);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [oaKey, setOaKey] = useState("");
  const [model, setModel] = useState(initial.openaiModel);
  const [res, setRes] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function call(method: "PUT" | "POST", body?: unknown) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/connections", { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json();
      if (!r.ok) return setErr(j.error ?? "Request failed");
      setRes(j.results);
      setSt(j.status);
      if (Object.values(j.results as Record<string, Result>).some((x) => x.ok)) {
        setKey("");
        setSecret("");
        setOaKey("");
      }
      router.refresh();
    } catch {
      setErr("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const changed = !!(key || secret || oaKey || env !== st.t212Env || model !== st.openaiModel);
  const source = (s: string | null) => (s === "settings" ? "saved in Settings" : s === "environment" ? "from environment" : "not set");

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">API connections</h2>
      <p className="mb-4 text-xs text-muted">Keys are checked against the real service before they are saved, encrypted on the server, and never sent back to your browser. Leave a box empty to keep the current value.</p>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-medium">Trading 212 <span className="text-xs font-normal text-muted">· {st.hasT212Keys ? `${st.t212KeyHint} (${source(st.t212Source)})` : "not set"}</span></h3>
          <div className="space-y-2">
            <select value={env} onChange={(e) => setEnv(e.target.value as "demo" | "live")} className={input} aria-label="Account type">
              <option value="demo">Demo (practice money)</option>
              <option value="live">Live (real money)</option>
            </select>
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" className={input} />
            <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="API secret" className={input} />
          </div>
          <Verdict r={res.t212} />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">OpenAI <span className="text-xs font-normal text-muted">· {st.hasOpenAI ? `${st.openaiKeyHint} (${source(st.openaiSource)})` : "not set"}</span></h3>
          <div className="space-y-2">
            <input type="password" autoComplete="off" value={oaKey} onChange={(e) => setOaKey(e.target.value)} placeholder="API key (sk-…)" className={input} />
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model" className={input} aria-label="Model" />
          </div>
          <Verdict r={res.openai} />
        </div>
      </div>

      {err && <p role="alert" className="mt-3 text-sm text-danger">{err}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          disabled={busy || !changed}
          onClick={() => call("PUT", { t212Env: env, t212Key: key || undefined, t212Secret: secret || undefined, openaiKey: oaKey || undefined, openaiModel: model })}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:text-black"
        >
          {busy ? "Checking…" : "Verify & save"}
        </button>
        <button disabled={busy} onClick={() => call("POST")} className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
          Test saved keys
        </button>
      </div>
    </section>
  );
}

export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) return setMsg({ ok: false, detail: "The new passwords do not match." });
    setBusy(true);
    const r = await fetch("/api/auth/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current, next }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, detail: j.error ?? "Could not change password" });
    setCurrent("");
    setNext("");
    setAgain("");
    setMsg({ ok: true, detail: "Password changed. All other devices have been signed out." });
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">Change password</h2>
      <form onSubmit={submit} className="grid max-w-md gap-2">
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" className={input} />
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (8+ characters)" className={input} />
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Repeat new password" className={input} />
        <div>
          <button disabled={busy || !current || !next} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:text-black">
            {busy ? "Saving…" : "Change password"}
          </button>
        </div>
        <Verdict r={msg ?? undefined} />
      </form>
    </section>
  );
}
