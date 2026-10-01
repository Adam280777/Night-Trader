CREATE TABLE `study_skips` (
	`symbol` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`reason` text NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `study_skips_until` ON `study_skips` (`until`);--> statement-breakpoint
ALTER TABLE `decisions` ADD `forced` integer DEFAULT false NOT NULL;