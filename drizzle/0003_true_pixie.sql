CREATE TABLE `knowledge` (
	`symbol` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`name` text,
	`market` text NOT NULL,
	`price` real,
	`screen_score` real,
	`avg_score` real,
	`best_score` real,
	`observations` integer DEFAULT 0 NOT NULL,
	`signals` text,
	`research` text,
	`summary` text,
	`sentiment` real,
	`news_burst` real,
	`overnight_risk` text,
	`researched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_market_score` ON `knowledge` (`market`,`screen_score`);--> statement-breakpoint
CREATE INDEX `knowledge_updated` ON `knowledge` (`updated_at`);