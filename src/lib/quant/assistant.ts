import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { currentMode, getEnvConfig, getSettings } from "../config";
import { getAccountState, tryClient } from "../account";
import { getWorkerStatus } from "../queries";
import { getActiveLessons, getPerformanceStats } from "./memory";
import { getModelReport } from "./learn";
import { FEATURE_BY_KEY } from "./features";
import { roundTripCostPct } from "./costs";
import { DEFAULT_TUNING, GROUP_META, TUNING_PARAMS, TUNING_GROUPS, type QuantTuning, type TuningParam } from "./tuning";
import type { Evaluation } from "./schemas";

const { runs, decisions, trades, candidates } = schema;

const pct = (x: number | null | undefined, dp = 2) => (x == null || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "" : ""}${x.toFixed(dp)}%`);
const pp = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(0)}%`);
const money = (x: number | null | undefined, ccy = "") => (x == null || !Number.isFinite(x) ? "n/a" : `${x.toFixed(2)}${ccy ? ` ${ccy}` : ""}`);
const bare = (t: string) => t.split("_")[0];

/** Very small keyword router. Ordered: the first intent whose test passes wins. */
type Intent = { name: string; test: RegExp; run: (q: string) => Promise<string> };

async function answerAccount(): Promise<string> {
  const client = await tryClient();
  if (!client) return "No Trading 212 keys are saved, so I cannot read the account. Add them on the Settings page and I will be able to show the balance and any open position.";
  try {
    const [account, positions] = await Promise.all([getAccountState(client), client.getPositions()]);
    const env = (await getEnvConfig()).t212Env;
    const lines = [
      `**Trading 212 (${env})**`,
      `- Total value: ${money(account.totalValue, account.currency)}`,
      `- Available cash: ${money(account.availableCash, account.currency)}`,
    ];
    if (positions.length === 0) {
      lines.push("- No open positions.");
    } else {
      lines.push("", "**Open positions**");
      for (const p of positions) {
        const pnl = p.walletImpact?.unrealizedProfitLoss;
        lines.push(
          `- ${bare(p.instrument.ticker)} (${p.instrument.name}): ${p.quantity} @ ${money(p.averagePricePaid)}, now ${money(p.currentPrice)}${pnl == null ? "" : `, unrealised ${money(pnl, account.currency)}`}`,
        );
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `I could not read your Trading 212 account just now: ${String(err).slice(0, 200)}`;
  }
}

async function answerStatus(): Promise<string> {
  const settings = await getSettings();
  const [mode, worker, env] = await Promise.all([currentMode(settings), getWorkerStatus(), getEnvConfig()]);
  const last = worker.lastHeartbeat ? new Date(worker.lastHeartbeat).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "never";
  const [latest] = await getDb().select().from(runs).orderBy(desc(runs.id)).limit(1);
  return [
    `**Status**`,
    `- Mode: ${mode === "dry" ? "dry run (no orders are sent)" : mode === "demo" ? "demo account (practice money)" : "LIVE (real money)"}`,
    `- Scheduler: ${worker.alive ? "online" : "offline"} (last tick ${last})`,
    `- Markets enabled: ${[settings.markets.US ? "US" : null, settings.markets.UK ? "UK" : null].filter(Boolean).join(", ") || "none"}`,
    `- Trading enabled: ${settings.tradingEnabled ? "yes" : "no"}${settings.killSwitch ? " · kill switch is ON" : ""}`,
    `- Approval mode: ${settings.approvalMode}`,
    `- Trading 212 keys: ${env.t212Key && env.t212Secret ? "saved" : "missing"}`,
    latest ? `- Latest run: ${latest.tradingDate} ${latest.market} — ${latest.status}${latest.error ? ` (${latest.error})` : ""}` : `- No runs recorded yet.`,
  ].join("\n");
}

async function answerPerformance(): Promise<string> {
  const s = await getPerformanceStats();
  if (s.closedTrades === 0) return "There are no closed trades yet, so there is no track record to report. Once trades start closing I will be able to show win rate, average result and how the picks compare with the rest of the shortlist.";
  const lines = [
    `**Track record**`,
    `- ${s.closedTrades} closed trades, win rate ${pp(s.winRate)}`,
    `- Average result ${pct(s.avgPnlPct)} (wins ${pct(s.avgWinPct)}, losses ${pct(s.avgLossPct)})`,
    `- Total P&L ${money(s.totalPnl)}`,
  ];
  if (s.byMarket.length) lines.push("", "**By market**", ...s.byMarket.map((m) => `- ${m.market}: ${m.n} trades, win ${pp(m.winRate)}, avg ${pct(m.avgPnlPct)}`));
  if (s.byConfidence.length) lines.push("", "**By confidence**", ...s.byConfidence.map((b) => `- ${b.bucket}: ${b.n} trades, win ${pp(b.winRate)}, avg ${pct(b.avgPnlPct)}`));
  if (s.shortlistAvgOvernightPct != null && s.pickedAvgOvernightPct != null) {
    const edge = s.pickedAvgOvernightPct - s.shortlistAvgOvernightPct;
    lines.push(
      "",
      `**Is the engine adding value?** Picks averaged ${pct(s.pickedAvgOvernightPct)} overnight against ${pct(s.shortlistAvgOvernightPct)} for the whole shortlist — ${edge >= 0 ? `an edge of ${pct(edge)} over simply taking a shortlisted name at random` : `${pct(Math.abs(edge))} worse than taking a shortlisted name at random, which is the number to watch`}.`,
    );
  }
  if (s.recent.length) lines.push("", "**Last trades**", ...s.recent.map((r) => `- ${r.date} ${bare(r.ticker)}: ${pct(r.pnlPct)}${r.confidence == null ? "" : ` (confidence ${pp(r.confidence)})`}`));
  return lines.join("\n");
}

async function answerModel(): Promise<string> {
  const r = await getModelReport();
  const lines = [
    `**The decision model**`,
    `- Trained on ${r.samples} outcomes (${r.labelledRows} labelled shortlist rows available)`,
    `- Base rate of a shortlisted name clearing costs overnight: ${r.baseRate == null ? "n/a" : pp(r.baseRate)}`,
    `- Calibration error: ${r.calibrationError == null ? "not enough data yet" : (r.calibrationError * 100).toFixed(1) + " percentage points"}`,
  ];
  if (r.reliability?.length) {
    lines.push("", "**Reliability (predicted vs actual)**", ...r.reliability.filter((b) => b.n > 0).map((b) => `- said ${pp(b.predicted)} → happened ${pp(b.realised)} (${b.n} cases)`));
  }
  if (r.learned.length) {
    lines.push("", "**What it weighs most right now**", ...r.learned.map((l) => `- ${l.label}: ${l.weight >= 0 ? "+" : ""}${l.weight.toFixed(2)}${l.prior == null ? "" : ` (started at ${l.prior >= 0 ? "+" : ""}${l.prior.toFixed(2)})`}`));
  }
  if (r.rules.length) lines.push("", "**Rules mined from outcomes**", ...r.rules.map((x) => `- ${x.text}`));
  else lines.push("", "No statistically significant rules have been mined yet — that needs at least 30 samples in a bucket and a p-value under 0.05.");
  return lines.join("\n");
}

async function answerLessons(): Promise<string> {
  const ls = await getActiveLessons(30);
  if (!ls.length) return "There are no active lessons yet. Lessons are re-derived from the outcome data after every learning cycle, so they appear once there is enough history for a pattern to be statistically significant.";
  return ["**Active lessons**", ...ls.map((l) => `- ${l.text}${l.tags.length ? ` _[${l.tags.join(", ")}]_` : ""}`)].join("\n");
}

async function answerHistory(): Promise<string> {
  const rows = await getDb()
    .select({ run: runs, decision: decisions, trade: trades })
    .from(runs)
    .leftJoin(decisions, eq(decisions.runId, runs.id))
    .leftJoin(trades, eq(trades.runId, runs.id))
    .orderBy(desc(runs.id))
    .limit(10);
  if (!rows.length) return "No runs have happened yet.";
  return [
    "**Last 10 runs**",
    ...rows.map(({ run, decision, trade }) => {
      const what = decision?.action === "BUY" ? `bought ${bare(decision.ticker ?? "?")}` : decision ? "no trade" : run.status;
      const res = trade?.pnlPct == null ? "" : ` → ${pct(trade.pnlPct)}`;
      return `- ${run.tradingDate} ${run.market}: ${what}${decision?.confidence == null ? "" : ` (confidence ${pp(decision.confidence)})`}${res}${run.error ? ` · ${run.error}` : ""}`;
    }),
  ].join("\n");
}

/** Pulls the stored evaluation for a decision and turns the attributions back into prose. */
function explainEvaluation(ev: Evaluation): string[] {
  const lines: string[] = [];
  lines.push(
    `- Probability of clearing costs: ${pp(ev.probability)} (learned model ${pp(ev.modelProbability)}${ev.analogueProbability == null ? ", no usable historical analogues" : `, historical analogues ${pp(ev.analogueProbability)} from ${ev.analogueSamples} similar setups`})`,
  );
  lines.push(`- Expected move ${pct(ev.expectedMovePct)} against round-trip costs of ${pct(ev.costPct)}, so edge ${pct(ev.edgePct)} (risk-adjusted ${pct(ev.riskAdjustedEdgePct)})`);
  lines.push(`- Overnight volatility assumed ${pct(ev.sigmaPct)}; Kelly-implied size ${pp(ev.kellyFraction)} of free cash before guardrails`);
  const top = [...ev.attributions].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 6);
  if (top.length) {
    lines.push("", "**What pushed the number around**");
    for (const a of top) lines.push(`- ${a.label} at ${a.display}: ${a.contribution >= 0 ? "+" : ""}${a.contribution.toFixed(2)} log-odds`);
  }
  if (ev.vetoes.length) lines.push("", `**Vetoes:** ${ev.vetoes.join("; ")}`);
  return lines;
}

async function answerWhy(q: string): Promise<string> {
  const db = getDb();
  // If the question names a ticker, explain that candidate; otherwise explain the latest decision.
  const words = q.toUpperCase().match(/\b[A-Z]{1,6}\b/g) ?? [];
  const stop = new Set(["WHY", "DID", "THE", "IT", "PICK", "BUY", "NOT", "AND", "FOR", "YOU", "WHAT", "HOW", "IS", "A", "OF", "ON", "TO", "IN", "AI", "NO", "TRADE"]);
  const guesses = words.filter((w) => !stop.has(w) && w.length >= 2);

  if (guesses.length) {
    const rows = await db
      .select({ c: candidates, run: runs })
      .from(candidates)
      .innerJoin(runs, eq(candidates.runId, runs.id))
      .orderBy(desc(candidates.id))
      .limit(400);
    const hit = rows.find((r) => guesses.includes(bare(r.c.ticker).toUpperCase()));
    if (hit) {
      const ev = hit.c.evaluation as Evaluation | null;
      const lines = [`**${bare(hit.c.ticker)} — ${hit.run.tradingDate} ${hit.run.market} run**`, `- ${hit.c.picked ? "This is the name the engine picked." : "This was shortlisted but not picked."}`];
      if (hit.c.researchSummary) lines.push(`- ${hit.c.researchSummary}`);
      if (ev) lines.push(...explainEvaluation(ev));
      else lines.push("- No stored evaluation for this candidate (it predates the local engine).");
      if (hit.c.overnightReturnPct != null) lines.push("", `**What actually happened:** ${pct(hit.c.overnightReturnPct)} overnight.`);
      return lines.join("\n");
    }
  }

  const [latest] = await db.select().from(decisions).orderBy(desc(decisions.id)).limit(1);
  if (!latest) return "There is no decision on record yet to explain.";
  const [run] = await db.select().from(runs).where(eq(runs.id, latest.runId)).limit(1);
  const lines = [`**${run?.tradingDate ?? ""} ${run?.market ?? ""} decision: ${latest.action === "BUY" ? `buy ${bare(latest.ticker ?? "?")}` : "no trade"}**`];
  if (latest.thesis) lines.push("", latest.thesis);
  if (latest.confidence != null) lines.push("", `- Confidence ${pp(latest.confidence)}, expected move ${pct(latest.expectedMovePct)}, requested size ${pp(latest.investPct)} of free cash`);
  if (latest.risks) lines.push(`- Risks: ${latest.risks}`);
  if (latest.exitPlan) lines.push(`- Exit plan: ${latest.exitPlan}`);
  if (latest.guardrailNotes?.length) lines.push("", "**Guardrails and rules applied**", ...latest.guardrailNotes.map((n) => `- ${n}`));

  const cand = await db.select().from(candidates).where(and(eq(candidates.runId, latest.runId), eq(candidates.picked, true))).limit(1);
  const ev = cand[0]?.evaluation as Evaluation | null;
  if (ev) lines.push("", ...explainEvaluation(ev));
  return lines.join("\n");
}

async function answerShortlist(): Promise<string> {
  const db = getDb();
  const [latest] = await db.select().from(runs).orderBy(desc(runs.id)).limit(1);
  if (!latest) return "No runs have happened yet, so there is no shortlist to show.";
  const rows = await db.select().from(candidates).where(eq(candidates.runId, latest.id)).orderBy(desc(candidates.screenScore));
  if (!rows.length) return `The ${latest.tradingDate} ${latest.market} run has not produced a shortlist yet (status: ${latest.status}).`;
  return [
    `**Shortlist for ${latest.tradingDate} ${latest.market}**`,
    ...rows.map((c) => {
      const ev = c.evaluation as Evaluation | null;
      const bits = [ev ? `p ${pp(ev.probability)}` : null, ev ? `edge ${pct(ev.riskAdjustedEdgePct)}` : null, c.overnightReturnPct == null ? null : `actual ${pct(c.overnightReturnPct)}`].filter(Boolean);
      return `- ${c.picked ? "**" : ""}${bare(c.ticker)}${c.picked ? "** (picked)" : ""}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
    }),
  ].join("\n");
}

async function answerHow(): Promise<string> {
  const tuning = (await getSettings()).quant;
  return [
    "**How this system decides, end to end**",
    "1. **Trigger.** An external timer calls the app every minute, so runs happen with your PC off. Shortly before each enabled market closes, a run starts.",
    `2. **Screen.** The tradable instrument list comes from Trading 212; it is filtered to liquid, non-leveraged stocks and ranked on momentum, relative volume, gap history, volatility and position in range, down to a shortlist of ${tuning.shortlistSize}.`,
    `3. **Research.** For each shortlisted name the app pulls ${tuning.analogueBars} daily bars plus free headlines, scores the headlines with a finance-tuned lexicon (half-life ${tuning.newsHalfLifeHours} hours), and classifies events such as earnings, guidance, upgrades and legal news. No paid API is involved.`,
    "4. **Evaluate.** Each candidate becomes a feature vector. Three things produce a probability: a logistic model trained on this app's own past outcomes, kernel-weighted analogues from the stock's own history of similar setups, and rules mined from outcomes. These are blended in log-odds and calibrated against how the model has actually performed.",
    `5. **Decide.** Expected move minus round-trip cost gives an edge; the engine charges ${tuning.uncertaintyPenalty} standard error${tuning.uncertaintyPenalty === 1 ? "" : "s"} of estimation uncertainty against it, ranks on what survives, and sizes at ${(tuning.kellyFraction * 100).toFixed(0)}% of Kelly. If nothing clears the bar, the answer is no trade — which is a real answer, not a failure.`,
    "6. **Guardrails.** Position caps, minimum cash, daily and weekly loss breakers, cost checks, no leveraged products, and the kill switch all sit downstream and cannot be overridden by anything above.",
    "7. **Execute and learn.** Buy near the close, sell at the next open, then record the overnight return for *every* shortlisted name — picked or not. Those counterfactuals are what trains the model, so it gets sharper every single day.",
    "",
    "Everything above runs inside this app on Vercel. There is no AI provider and no per-run cost, and every number in steps 2 to 5 is adjustable on the Settings page.",
  ].join("\n");
}

function answerHelp(): string {
  return [
    "I answer from the app's own data — the Trading 212 account, past runs, the decision model, its learned rules and its current configuration. Things you can ask:",
    "- *How is my account doing?* — balance and open positions, live from Trading 212",
    "- *What's the status?* — mode, scheduler, markets, guardrail switches",
    "- *How have we performed?* — win rate, averages, picks vs the rest of the shortlist",
    "- *Why did it pick AAPL?* or *why no trade?* — the actual numbers behind the decision",
    "- *Show the shortlist* — the latest run's candidates with probabilities and outcomes",
    "- *What has the model learned?* — calibration, feature weights, mined rules",
    "- *What are you weighing most heavily?* — the features currently driving decisions",
    "- *How are you configured?* — every tuning parameter and anything moved off its default",
    "- *What does the Kelly fraction do?* — a plain explanation of any single setting",
    "- *What if I raised the uncertainty charge?* — the consequence of moving a setting",
    "- *What does a trade cost?* — the round-trip cost model for each market",
    "- *How does it work?* — the full pipeline",
    "",
    "I do not browse the web and I never guess: if the data is not in the app, I will tell you.",
  ].join("\n");
}

/** Renders a stored tuning value the way the Settings page shows it. */
function showParam(p: TuningParam, tuning: QuantTuning): string {
  const v = tuning[p.key];
  if (typeof v === "boolean") return v ? "on" : "off";
  const scaled = Math.round(v * (p.scale ?? 1) * 1000) / 1000;
  if (!p.unit) return String(scaled);
  // "%" and "×" read wrong with a space; word-like units need one.
  return /^[%×]$/.test(p.unit) ? `${scaled}${p.unit}` : `${scaled} ${p.unit}`;
}

/** Finds the setting a question is about, by key or by words from its label. */
function findParam(q: string): TuningParam | null {
  const lower = q.toLowerCase();
  const direct = TUNING_PARAMS.find((p) => lower.includes(p.key.toLowerCase()));
  if (direct) return direct;

  let best: { p: TuningParam; score: number } | null = null;
  for (const p of TUNING_PARAMS) {
    const words = p.label.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length === 0) continue;
    const hits = words.filter((w) => lower.includes(w)).length;
    if (hits === 0) continue;
    const score = hits / words.length;
    if (!best || score > best.score) best = { p, score };
  }
  return best && best.score >= 0.5 ? best.p : null;
}

async function answerTuning(q: string): Promise<string> {
  const tuning = (await getSettings()).quant;
  const one = findParam(q);

  if (one) {
    const changed = tuning[one.key] !== DEFAULT_TUNING[one.key];
    return [
      `**${one.label}** — currently ${showParam(one, tuning)}${changed ? ` (default is ${showParam(one, DEFAULT_TUNING)})` : " (the default)"}`,
      "",
      one.hint,
      "",
      `It lives under *${GROUP_META[one.group].title}* in Settings, and takes effect on the next run.`,
    ].join("\n");
  }

  const changedParams = TUNING_PARAMS.filter((p) => tuning[p.key] !== DEFAULT_TUNING[p.key]);
  const lines = ["**How I am configured**", ""];
  for (const group of TUNING_GROUPS) {
    const params = TUNING_PARAMS.filter((p) => p.group === group);
    lines.push(`*${GROUP_META[group].title}*`);
    for (const p of params) {
      const isChanged = tuning[p.key] !== DEFAULT_TUNING[p.key];
      lines.push(`- ${p.label}: ${showParam(p, tuning)}${isChanged ? ` (moved from ${showParam(p, DEFAULT_TUNING)})` : ""}`);
    }
    lines.push("");
  }
  lines.push(
    changedParams.length === 0
      ? "Everything is on its shipped default. Ask me what any single setting does, or change it on the Settings page."
      : `${changedParams.length} setting${changedParams.length === 1 ? " is" : "s are"} away from the default. Ask *what does X do* for any of them.`,
  );
  return lines.join("\n");
}

/** Explains the direction of travel if a setting is moved, using the registry's stated consequence. */
async function answerWhatIf(q: string): Promise<string> {
  const p = findParam(q);
  if (!p) {
    return [
      "Tell me which setting you mean and I will explain what moving it does — for example *what if I raised the Kelly fraction*, *what if I turned off the earnings veto*, or *what if I lowered the minimum turnover*.",
      "",
      "Ask *how are you configured* to see the full list.",
    ].join("\n");
  }

  const tuning = (await getSettings()).quant;
  const direction = /\b(rais|increas|higher|more|up|bigger|loosen)\w*\b/i.test(q) ? "up" : /\b(lower|decreas|reduc|less|down|smaller|tighten)\w*\b/i.test(q) ? "down" : null;

  const lines = [`**${p.label}** is currently ${showParam(p, tuning)}.`, "", p.hint];
  if (p.kind === "number" && direction) {
    lines.push(
      "",
      direction === "up"
        ? `Moving it up pushes behaviour toward the second half of that description; the range I accept is ${p.min} to ${p.max}${p.unit ? ` ${p.unit}` : ""}.`
        : `Moving it down pushes behaviour toward the first half of that description; the range I accept is ${p.min} to ${p.max}${p.unit ? ` ${p.unit}` : ""}.`,
    );
  }
  lines.push(
    "",
    "Nothing is retroactive: the change applies to the next run, and every past decision keeps the numbers it was actually made with. The safety limits are enforced separately and are unaffected.",
  );
  return lines.join("\n");
}

async function answerCosts(): Promise<string> {
  const tuning = (await getSettings()).quant;
  const typical = { atrPct: 2, dollarVolume: 5e7 };
  const us = roundTripCostPct("US", typical, tuning);
  const uk = roundTripCostPct("UK", typical, tuning);
  return [
    "**What a round trip costs**",
    "I assume a cost before I assume a profit, because a trade that cannot clear its own costs is not a trade.",
    "",
    `- Typical US name: about ${pct(us)} round trip, plus ${pct(tuning.openingAuctionSlippagePct)} demanded for selling into the opening auction.`,
    `- Typical UK name: about ${pct(uk)} round trip, higher because UK buys pay ${pct(tuning.ukStampDutyPct)} stamp duty.`,
    `- FX conversion: ${pct(tuning.fxFeePctPerSide)} on each side of a non-GBP trade.`,
    tuning.extraCostBufferPct > 0 ? `- Your extra safety buffer adds ${pct(tuning.extraCostBufferPct)} on top of all of the above.` : null,
    "",
    "The spread portion is not a constant: it is estimated per name from its own volatility and turnover, so an illiquid, jumpy stock is charged more than a mega-cap. Expected move has to beat all of it before I will act.",
  ]
    .filter(Boolean)
    .join("\n");
}

const INTENTS: Intent[] = [
  { name: "help", test: /\b(help|what can you (do|answer)|commands)\b/i, run: async () => answerHelp() },
  { name: "whatif", test: /\b(what if|what would happen|if i (rais|lower|increas|decreas|turn|change|set)|should i (rais|lower|increas|decreas|change))\w*/i, run: answerWhatIf },
  { name: "how", test: /\b(how does (it|this|the system)|how do you (work|decide)|explain the (system|pipeline|process)|what do you do)\b/i, run: answerHow },
  { name: "costs", test: /\b(cost|fee|commission|stamp duty|spread|slippage|fx|break ?even)\b/i, run: async () => answerCosts() },
  { name: "tuning", test: /\b(configur|tuning|parameter|setting|knob|dial|what does .* (do|mean)|how are you set)\w*/i, run: answerTuning },
  { name: "why", test: /\b(why|reason|thesis|justif|explain the (decision|pick|trade))\b/i, run: answerWhy },
  { name: "shortlist", test: /\b(shortlist|candidates|what did it look at|watchlist)\b/i, run: answerShortlist },
  { name: "model", test: /\b(model|calibrat|weights?|weigh(ing|s)?|learned|learning|confidence bucket|how smart)\b/i, run: answerModel },
  { name: "lessons", test: /\b(lesson|rule)s?\b/i, run: answerLessons },
  { name: "performance", test: /\b(perform|track record|win rate|p ?& ?l|pnl|profit|how are we doing|results?)\b/i, run: answerPerformance },
  { name: "account", test: /\b(account|balance|cash|position|holding|portfolio|equity|how much (money|do i))\b/i, run: answerAccount },
  { name: "status", test: /\b(status|scheduler|cron|running|mode|kill ?switch|online)\b/i, run: answerStatus },
  { name: "history", test: /\b(history|recent runs?|last (run|trade|night)|yesterday|past trades?)\b/i, run: answerHistory },
];

async function overview(): Promise<string> {
  const [status, perf] = await Promise.all([answerStatus(), answerPerformance()]);
  return [
    "I am not sure which part you mean, so here is the current picture.",
    "",
    status,
    "",
    perf,
    "",
    "Ask me *why did it pick X*, *show the shortlist*, *what has the model learned*, *how are you configured* or *how does it work* for more detail.",
  ].join("\n");
}

/** Deterministic, data-backed reply. No network calls beyond Trading 212 and the app's own database. */
export async function answerQuestion(message: string): Promise<string> {
  const q = message.trim();
  if (!q) return answerHelp();
  for (const intent of INTENTS) {
    if (intent.test.test(q)) {
      try {
        return await intent.run(q);
      } catch (err) {
        return `I hit an error reading the data for that (${String(err).slice(0, 150)}). Try again in a moment.`;
      }
    }
  }
  // A bare ticker is a common shorthand for "tell me about this name".
  if (/^[A-Za-z.]{1,6}\??$/.test(q)) return answerWhy(q);
  return overview();
}

/** Exposed so the learning page can label feature keys consistently with the chat. */
export const featureLabel = (key: string) => FEATURE_BY_KEY.get(key)?.label ?? key;
