CREATE TABLE `sanctum_project_task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`task_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`mentions_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_task_comments_task_created` ON `sanctum_project_task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_project_task_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`project_id` text NOT NULL,
	`blocker_task_id` text NOT NULL,
	`blocked_task_id` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocker_task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_task_deps_edge` ON `sanctum_project_task_dependencies` (`blocker_task_id`,`blocked_task_id`);--> statement-breakpoint
CREATE INDEX `ix_task_deps_blocked` ON `sanctum_project_task_dependencies` (`blocked_task_id`);--> statement-breakpoint
CREATE INDEX `ix_task_deps_agency_project` ON `sanctum_project_task_dependencies` (`agency_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `sanctum_project_task_label_links` (
	`agency_id` text NOT NULL,
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`),
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `sanctum_project_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `sanctum_project_task_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_task_label_links_label` ON `sanctum_project_task_label_links` (`label_id`);--> statement-breakpoint
CREATE TABLE `sanctum_project_task_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'pine' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_task_labels_project_name` ON `sanctum_project_task_labels` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `ix_task_labels_agency_project` ON `sanctum_project_task_labels` (`agency_id`,`project_id`);--> statement-breakpoint
ALTER TABLE `sanctum_project_tasks` ADD `priority` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_project_tasks` ADD `estimate_minutes` integer;--> statement-breakpoint
ALTER TABLE `sanctum_project_tasks` ADD `start_date` integer;--> statement-breakpoint
ALTER TABLE `sanctum_project_tasks` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_project_tasks` ADD `parent_task_id` text REFERENCES sanctum_project_tasks(id);--> statement-breakpoint
CREATE INDEX `ix_tasks_agency_project_parent` ON `sanctum_project_tasks` (`agency_id`,`project_id`,`parent_task_id`);--> statement-breakpoint
CREATE INDEX `ix_tasks_agency_project_priority` ON `sanctum_project_tasks` (`agency_id`,`project_id`,`priority`);--> statement-breakpoint
-- Backfill: existing 'done' tasks get completed_at from their updated_at (spec §2.7).
UPDATE `sanctum_project_tasks` SET `completed_at` = `updated_at` WHERE `status` = 'done' AND `completed_at` IS NULL;