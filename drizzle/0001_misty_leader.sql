CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `locks` (
	`name` text PRIMARY KEY NOT NULL,
	`until` integer NOT NULL
);
