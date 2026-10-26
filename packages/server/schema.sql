CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`initial_state` text NOT NULL,
	`current_state` text NOT NULL,
	`current_seq` integer NOT NULL,
	`current_turn` text NOT NULL,
	`map_id` text DEFAULT 'classic' NOT NULL,
	`winner` text,
	`archived_at` integer,
	`code` text,
	`deadline` integer,
	`ended_by` text
);

CREATE UNIQUE INDEX `matches_code` ON `matches` (`code`) WHERE "matches"."code" is not null;
CREATE TABLE `resolutions` (
	`match_id` text NOT NULL,
	`seq` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`events` text NOT NULL,
	`rolls` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`match_id`, `seq`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `seats` (
	`match_id` text NOT NULL,
	`number` integer NOT NULL,
	`occupant` text,
	`color` text NOT NULL,
	`clock_remaining_ms` integer,
	PRIMARY KEY(`match_id`, `number`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `seats_occupant` ON `seats` (`occupant`);
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);

