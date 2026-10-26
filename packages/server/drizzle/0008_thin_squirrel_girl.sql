ALTER TABLE `matches` ADD `deadline` integer;--> statement-breakpoint
ALTER TABLE `matches` ADD `ended_by` text;--> statement-breakpoint
ALTER TABLE `seats` ADD `clock_remaining_ms` integer;