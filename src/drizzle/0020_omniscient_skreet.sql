CREATE TABLE `sanctum_task_assignees` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_task_assignee` ON `sanctum_task_assignees` (`task_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_task_assignees_task` ON `sanctum_task_assignees` (`task_id`);