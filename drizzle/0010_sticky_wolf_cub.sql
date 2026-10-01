CREATE TABLE `model_deployments` (
	`scope` text PRIMARY KEY NOT NULL,
	`champion_version_id` integer NOT NULL,
	`challenger_version_id` integer,
	`previous_champion_version_id` integer,
	`promoted_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`champion_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenger_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`previous_champion_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_version_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`candidate_id` integer NOT NULL,
	`market` text NOT NULL,
	`kind` text NOT NULL,
	`probability` real NOT NULL,
	`raw_probability` real NOT NULL,
	`expected_after_cost_pct` real NOT NULL,
	`cost_pct` real NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`predicted_trade` integer DEFAULT false NOT NULL,
	`actual_return_pct` real,
	`actual_after_cost_pct` real,
	`outcome` integer,
	`created_at` integer NOT NULL,
	`observed_at` integer,
	FOREIGN KEY (`model_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_evidence_version_candidate` ON `model_evidence` (`model_version_id`,`candidate_id`);--> statement-breakpoint
CREATE INDEX `model_evidence_version_observed` ON `model_evidence` (`model_version_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `model_governance_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`action` text NOT NULL,
	`from_version_id` integer,
	`to_version_id` integer,
	`reason` text NOT NULL,
	`evidence` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_governance_events_scope` ON `model_governance_events` (`scope`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_name` text NOT NULL,
	`scope` text NOT NULL,
	`parent_version_id` integer,
	`state` text NOT NULL,
	`samples` integer NOT NULL,
	`training_from` text NOT NULL,
	`training_to` text NOT NULL,
	`first_candidate_id` integer,
	`last_candidate_id` integer,
	`settings_fingerprint` text NOT NULL,
	`settings` text NOT NULL,
	`metrics` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_versions_scope_created` ON `model_versions` (`model_name`,`scope`,`created_at`);--> statement-breakpoint
ALTER TABLE `trades` ADD `instrument_currency` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `account_currency` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `entry_fx_rate` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `exit_fx_rate` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `gross_pnl` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `estimated_spread_cost` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `stamp_duty_cost` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `slippage_cost` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `fx_impact` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `benchmark_return_pct` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `selection_return_pct` real;
--> statement-breakpoint
INSERT INTO `model_versions` (
	`model_name`, `scope`, `state`, `samples`, `training_from`, `training_to`,
	`last_candidate_id`, `settings_fingerprint`, `settings`, `metrics`, `created_at`
)
SELECT
	`name`, 'shared', `state`, `samples`, 'legacy', 'legacy',
	json_extract(`state`, '$.lastCandidateId'), 'legacy', '{}',
	'{"calibrationError":null,"brier":null,"baselineBrier":null,"meanAfterCostReturnPct":null,"maxDrawdownPct":null,"predictedTradeFrequency":null}',
	CAST(strftime('%s', 'now') AS integer) * 1000
FROM `model_state`
WHERE `name` = 'overnight_v1';
--> statement-breakpoint
INSERT OR IGNORE INTO `model_deployments` (`scope`, `champion_version_id`, `updated_at`)
SELECT 'shared', MAX(`id`), CAST(strftime('%s', 'now') AS integer) * 1000
FROM `model_versions`
WHERE `model_name` = 'overnight_v1' AND `scope` = 'shared'
HAVING MAX(`id`) IS NOT NULL;