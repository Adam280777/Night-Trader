CREATE TABLE `model_state` (
	`name` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`samples` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `candidates` ADD `features` text;--> statement-breakpoint
ALTER TABLE `candidates` ADD `evaluation` text;--> statement-breakpoint
ALTER TABLE `lessons` ADD `rule` text;