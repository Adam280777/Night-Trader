ALTER TABLE `orders` ADD `reference_price` real;--> statement-breakpoint
ALTER TABLE `orders` ADD `reference_at` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `reference_source` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `quote_age_ms` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `spread_pct` real;--> statement-breakpoint
ALTER TABLE `orders` ADD `slippage_pct` real;