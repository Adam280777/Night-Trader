ALTER TABLE `runs` ADD `strategy` text DEFAULT 'overnight' NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `strategy` text DEFAULT 'overnight' NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `stop_price` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `target_price` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `trailing_stop_pct` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `high_watermark` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `planned_exit_at` integer;--> statement-breakpoint
ALTER TABLE `trades` ADD `exit_reason` text;