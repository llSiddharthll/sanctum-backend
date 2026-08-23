ALTER TABLE `sanctum_project_tasks` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_project_tasks` ADD `archived_month` text;--> statement-breakpoint
ALTER TABLE `sanctum_content_posts` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_content_posts` ADD `archived_month` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_tasks_agency_archived` ON `sanctum_project_tasks` (`agency_id`,`archived_month`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_posts_agency_client_archived` ON `sanctum_content_posts` (`agency_id`,`client_id`,`archived_month`);
