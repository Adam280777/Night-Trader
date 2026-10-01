import type { Settings } from "./config";

export interface SettingsIssue {
  level: "warn" | "info";
  /** Section of the settings page the issue belongs to. */
  field: string;
  message: string;
}

/** Cross-field sanity checks: combinations that are each valid alone but defeat each other together. Pure. */
export function settingsIssues(s: Settings): SettingsIssue[] {
  const out: SettingsIssue[] = [];
  const add = (level: SettingsIssue["level"], field: string, message: string) => out.push({ level, field, message });

  if (!s.markets.US && !s.markets.UK) add("warn", "markets", "Both markets are switched off, so no run will ever be created.");
  if (s.killSwitch) add("warn", "killSwitch", "The kill switch is on: no new trades will be started until it is turned off.");

  const lead = s.minutesBeforeCloseToResearch - s.minutesBeforeCloseToBuy;
  if (lead < 20) {
    add("warn", "timing", `Only ${lead} minutes separate the start of research from the buy window. Screening and research can take 10 or more, so a run may run out of time.`);
  }
  if (s.approvalMode && s.approvalWindowMinutes > Math.max(1, lead - 5)) {
    add("info", "timing", "The approval window is longer than the time available before the buy window, so it will be cut short.");
  }
  if (s.weeklyLossLimitPct < s.dailyLossLimitPct) add("warn", "limits", "The weekly loss limit is tighter than the daily one, so the daily limit can never be reached first.");
  if (s.ukMinConfidence < s.minConfidence) add("info", "confidence", "The UK confidence floor is below the general one, so the general floor applies to UK trades too.");
  if (s.maxPositionPct > 0.5) add("warn", "limits", `A single position may be up to ${Math.round(s.maxPositionPct * 100)}% of the account. One bad gap could cost a large share of it.`);
  if (s.tradingEnabled && !s.approvalMode) add("info", "approval", "Orders will be placed without asking you first.");
  if (s.demoForceTrade && s.demoForceInvestPct > s.maxPositionPct) {
    add("info", "demo", "The demo exploration stake is above the position cap, so it will be reduced to the cap.");
  }
  if (s.quant.studyMaxScored > s.quant.studyMaxScan) add("info", "study", "The study round scores more names than it scans, so the scan cap is the limit.");
  if (s.ops.logRetentionDays < 3) add("info", "ops", "Logs are kept for under three days, which may not be enough to investigate a problem found later.");
  if (s.ops.maxUsQuoteAgeSeconds > 900) add("warn", "ops", "US execution quotes may be up to 15 minutes old before a buy is blocked.");
  if (s.ops.maxUkQuoteAgeSeconds > 1800) add("warn", "ops", "UK execution quotes may be over 30 minutes old before a buy is blocked.");
  if (s.ops.maxSlippagePct > 2) add("warn", "ops", "Critical slippage alerts only fire above 2%, which can hide poor execution.");
  return out;
}
