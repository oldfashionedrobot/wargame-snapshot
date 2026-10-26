ALTER TABLE `matches` ADD `owner_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `matches_owner_created` ON `matches` (`owner_id`,`created_at`);