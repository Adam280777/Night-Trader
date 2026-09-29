import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

const id = () => integer("id").primaryKey({ autoIncrement: true });
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

/** One pipeline run for one market window on one day. */
export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    tradingDate: text("trading_date").notNull(), // YYYY-MM-DD in market tz
    market: text("market", { enum: ["US", "UK"] }).notNull(),
    mode: text("mode", { enum: ["dry", "demo", "live"] }).notNull(),
    status: text("status", {
      enum: [
        "scheduled",
        "screening",
        "researching",
        "deciding",
        "awaiting_approval",
        "ready_to_buy",
        "executing",
        "holding",
        "exiting",
        "closed",
        "no_trade",
        "blocked",
        "failed",
        "skipped",
      ],
    }).notNull(),
    error: text("error"),
    sessionCloseAt: integer("session_close_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("runs_date_market").on(t.tradingDate, t.market)],
);

export const decisions = sqliteTable("decisions", {
  id: id(),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  ticker: text("ticker"), // T212 ticker e.g. AAPL_US_EQ; null = NO_TRADE
  name: text("name"),
  action: text("action", { enum: ["BUY", "NO_TRADE"] }).notNull(),
  confidence: real("confidence"), // 0..1
  investPct: real("invest_pct"), // fraction of free cash requested by AI
  thesis: text("thesis"),
  expectedMovePct: real("expected_move_pct"),
  exitPlan: text("exit_plan"),
  risks: text("risks"),
  sources: text("sources", { mode: "json" }).$type<{ title: string; url: string }[]>(),
  guardrailNotes: text("guardrail_notes", { mode: "json" }).$type<string[]>(),
  approval: text("approval", {
    enum: ["not_required", "pending", "approved", "rejected", "expired"],
  })
    .notNull()
    .default("not_required"),
  approvalDeadline: integer("approval_deadline", { mode: "timestamp_ms" }),
  marketContext: text("market_context", { mode: "json" }),
  createdAt: createdAt(),
});

/** Every shortlisted stock, picked or not, so we can score counterfactuals. */
export const candidates = sqliteTable(
  "candidates",
  {
    id: id(),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id),
    ticker: text("ticker").notNull(),
    name: text("name"),
    screenScore: real("screen_score"),
    signals: text("signals", { mode: "json" }).$type<Record<string, number | string | null>>(),
    researchSummary: text("research_summary"),
    research: text("research", { mode: "json" }),
    picked: integer("picked", { mode: "boolean" }).notNull().default(false),
    refPrice: real("ref_price"), // price at decision time
    nextOpenPrice: real("next_open_price"), // filled by outcome job
    overnightReturnPct: real("overnight_return_pct"),
    createdAt: createdAt(),
  },
  (t) => [index("candidates_run").on(t.runId)],
);

/** Every order we intend to send. Written BEFORE the API call (T212 is not idempotent). */
export const orders = sqliteTable(
  "orders",
  {
    id: id(),
    decisionId: integer("decision_id").references(() => decisions.id),
    runId: integer("run_id").references(() => runs.id),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    ticker: text("ticker").notNull(),
    quantity: real("quantity").notNull(),
    status: text("status", {
      enum: ["intent", "sent", "filled", "partial", "rejected", "unknown", "cancelled"],
    }).notNull(),
    t212OrderId: text("t212_order_id"),
    filledQuantity: real("filled_quantity"),
    fillPrice: real("fill_price"),
    error: text("error"),
    raw: text("raw", { mode: "json" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("orders_run").on(t.runId)],
);

export const trades = sqliteTable("trades", {
  id: id(),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id),
  decisionId: integer("decision_id")
    .notNull()
    .references(() => decisions.id),
  ticker: text("ticker").notNull(),
  name: text("name"),
  quantity: real("quantity").notNull(),
  entryPrice: real("entry_price"),
  entryAt: integer("entry_at", { mode: "timestamp_ms" }),
  exitPrice: real("exit_price"),
  exitAt: integer("exit_at", { mode: "timestamp_ms" }),
  pnl: real("pnl"),
  pnlPct: real("pnl_pct"),
  status: text("status", { enum: ["open", "closed"] }).notNull(),
  review: text("review"),
  createdAt: createdAt(),
});

export const lessons = sqliteTable("lessons", {
  id: id(),
  tradeId: integer("trade_id").references(() => trades.id),
  text: text("text").notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const equitySnapshots = sqliteTable("equity_snapshots", {
  id: id(),
  ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
  totalValue: real("total_value").notNull(),
  cash: real("cash").notNull(),
  mode: text("mode").notNull(),
});

export const eventLog = sqliteTable("event_log", {
  id: id(),
  ts: createdAt(),
  level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
  source: text("source").notNull(),
  message: text("message").notNull(),
  runId: integer("run_id"),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: id(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: createdAt(),
});

/** Short leases so overlapping cron invocations never run the same step twice. */
export const locks = sqliteTable("locks", {
  name: text("name").primaryKey(),
  until: integer("until").notNull(),
});

/** Small server-side cache (broker instrument list, exchange schedules). */
export const kv = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
