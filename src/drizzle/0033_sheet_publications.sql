CREATE TABLE IF NOT EXISTS `sanctum_sheet_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`sheet_id` text NOT NULL,
	`row_index` integer NOT NULL,
	`post_id` text,
	`task_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sheet_id`) REFERENCES `sanctum_sheets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `sanctum_content_posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_sheet_publications_sheet_row` ON `sanctum_sheet_publications` (`sheet_id`,`row_index`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_sheet_publications_sheet` ON `sanctum_sheet_publications` (`sheet_id`);
