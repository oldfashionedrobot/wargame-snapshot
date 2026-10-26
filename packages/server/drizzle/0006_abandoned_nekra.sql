-- Every match so far is development data, and seats replace the owner they
-- were kept by, so they are cleared rather than migrated. Hand-written: a
-- generated migration only changes shape.
DELETE FROM `resolutions`;--> statement-breakpoint
DELETE FROM `matches`;--> statement-breakpoint
CREATE TABLE `seats` (
	`match_id` text NOT NULL,
	`number` integer NOT NULL,
	`occupant` text,
	`color` text NOT NULL,
	PRIMARY KEY(`match_id`, `number`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seats_occupant` ON `seats` (`occupant`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
DROP INDEX `matches_owner_created`;--> statement-breakpoint
ALTER TABLE `matches` DROP COLUMN `owner_id`;