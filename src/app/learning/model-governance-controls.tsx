"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface ModelGovernanceControlsProps {
  scope: "shared" | "US" | "UK";
  championVersionId: number;
  challengerVersionId: number | null;
  previousChampionVersionId: number | null;
  readyForManualPromotion: boolean;
}

export function ModelGovernanceControls({
  scope,
  championVersionId,
  challengerVersionId,
  previousChampionVersionId,
  readyForManualPromotion,
}: ModelGovernanceControlsProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const canPromote = challengerVersionId != null && previousChampionVersionId == null && readyForManualPromotion;
  const canRollback = previousChampionVersionId != null;

  const submit = (action: "promote" | "rollback") => {
    const typedReason = reason.trim();
    if (typedReason.length < 3) {
      setMessage({ ok: false, text: "Enter an explicit reason of at least 3 characters." });
      return;
    }
    const target =
      action === "promote"
        ? `challenger v${challengerVersionId} as the ${scope} champion`
        : `previous champion v${previousChampionVersionId}, replacing v${championVersionId}`;
    if (!window.confirm(`Confirm manual ${action} of ${target}?\n\nReason: ${typedReason}`)) return;

    startTransition(async () => {
      setMessage(null);
      try {
        const response = await fetch("/api/model-governance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, action, reason: typedReason }),
        });
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
        setReason("");
        setMessage({ ok: true, text: `${scope} model ${action} completed. Refreshing governance evidence.` });
        router.refresh();
      } catch (error) {
        setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  return (
    <form
      className="mt-4 space-y-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit("promote");
      }}
      aria-labelledby={`governance-controls-${scope}`}
    >
      <div>
        <label id={`governance-controls-${scope}`} htmlFor={`governance-reason-${scope}`} className="text-sm font-medium">
          Manual action reason
        </label>
        <p className="mt-1 text-xs text-muted">Required for the immutable governance event. No model is promoted automatically.</p>
      </div>
      <textarea
        id={`governance-reason-${scope}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        minLength={3}
        maxLength={500}
        required
        rows={2}
        disabled={pending || (!canPromote && !canRollback)}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        placeholder="State the evidence and operator rationale"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={pending || !canPromote}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Working…" : "Promote after manual review"}
        </button>
        <button
          type="button"
          disabled={pending || !canRollback}
          onClick={() => submit("rollback")}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Working…" : "Roll back to previous champion"}
        </button>
      </div>
      {!canPromote && challengerVersionId != null && previousChampionVersionId == null && (
        <p className="text-xs text-muted">Promotion remains disabled until every configured evidence threshold is met.</p>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} aria-live="polite" className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
          {message.text}
        </p>
      )}
    </form>
  );
}
