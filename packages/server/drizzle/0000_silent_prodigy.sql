CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`initial_state` text NOT NULL,
	`current_state` text NOT NULL,
	`current_seq` integer NOT NULL,
	`current_turn` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resolutions` (
	`match_id` text NOT NULL,
	`seq` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`events` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`match_id`, `seq`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
