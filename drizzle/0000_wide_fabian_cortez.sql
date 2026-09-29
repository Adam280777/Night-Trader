CREATE TABLE `candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`ticker` text NOT NULL,
	`name` text,
	`screen_score` real,
	`signals` text,
	`research_summary` text,
	`research` text,
	`picked` integer DEFAULT false NOT NULL,
	`ref_price` real,
	`next_open_price` real,
	`overnight_return_pct` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `candidates_run` ON `candidates` (`run_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`ticker` text,
	`name` text,
	`action` text NOT NULL,
	`confidence` real,
	`invest_pct` real,
	`thesis` text,
	`expected_move_pct` real,
	`exit_plan` text,
	`risks` text,
	`sources` text,
	`guardrail_notes` text,
	`approval` text DEFAULT 'not_required' NOT NULL,
	`approval_deadline` integer,
	`market_context` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `equity_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`total_value` real NOT NULL,
	`cash` real NOT NULL,
	`mode` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`run_id` integer
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` integer,
	`text` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer,
	`run_id` integer,
	`side` text NOT NULL,
	`ticker` text NOT NULL,
	`quantity` real NOT NULL,
	`status` text NOT NULL,
	`t212_order_id` text,
	`filled_quantity` real,
	`fill_price` real,
	`error` text,
	`raw` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_run` ON `orders` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trading_date` text NOT NULL,
	`market` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`session_close_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_date_market` ON `runs` (`trading_date`,`market`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`decision_id` integer NOT NULL,
	`ticker` text NOT NULL,
	`name` text,
	`quantity` real NOT NULL,
	`entry_price` real,
	`entry_at` integer,
	`exit_price` real,
	`exit_at` integer,
	`pnl` real,
	`pnl_pct` real,
	`status` text NOT NULL,
	`review` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
