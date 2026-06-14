CREATE TABLE `sanctum_timers` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`started_at` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_timers_agency_user` ON `sanctum_timers` (`agency_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_timers_agency_project` ON `sanctum_timers` (`agency_id`,`project_id`);