CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_started` ON `job_runs` (`job`,`started_at`);--> statement-breakpoint
ALTER TABLE `event_log` ADD `detail` text;--> statement-breakpoint
CREATE INDEX `event_log_ts` ON `event_log` (`created_at`);