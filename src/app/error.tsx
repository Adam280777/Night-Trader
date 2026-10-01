"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("Dashboard render failed", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl items-center px-4">
      <div className="w-full rounded-xl border border-danger/40 bg-surface p-6 text-center shadow-card">
        <AlertTriangle className="mx-auto size-8 text-danger" aria-hidden />
        <h1 className="mt-3 text-xl font-semibold">This view could not be loaded</h1>
        <p className="mt-2 text-sm text-muted">The failure was recorded in the browser console. Retry first, then use Logs and System health to investigate recurring failures.</p>
        {error.digest && <p className="mt-2 font-mono text-xs text-muted">Error reference: {error.digest}</p>}
        <button onClick={retry} className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Try again</button>
      </div>
    </main>
  );
}
