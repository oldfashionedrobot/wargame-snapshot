ALTER TABLE `matches` ADD `code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `matches_code` ON `matches` (`code`) WHERE "matches"."code" is not null;