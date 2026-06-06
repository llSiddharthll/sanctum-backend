CREATE TABLE `sanctum_time_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`task_id` text,
	`minutes` integer NOT NULL,
	`work_date` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_time_logs_agency_user_date` ON `sanctum_time_logs` (`agency_id`,`user_id`,`work_date`);--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `designation` text;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `department` text;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `hourly_rate` integer;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `weekly_capacity_hrs` integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `skills` text;