CREATE TABLE `sanctum_project_members` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_project_members_project_user` ON `sanctum_project_members` (`project_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_project_members_agency_project` ON `sanctum_project_members` (`agency_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `sanctum_project_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`due_date` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_milestones_agency_project` ON `sanctum_project_milestones` (`agency_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `sanctum_project_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`assignee_id` text,
	`due_date` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_tasks_agency_project` ON `sanctum_project_tasks` (`agency_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `ix_tasks_agency_project_status` ON `sanctum_project_tasks` (`agency_id`,`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `sanctum_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'fixed_price' NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`health` text DEFAULT 'on_track' NOT NULL,
	`contract_value` integer DEFAULT 0,
	`currency` text DEFAULT 'INR' NOT NULL,
	`start_date` integer,
	`deadline` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_projects_agency` ON `sanctum_projects` (`agency_id`);--> statement-breakpoint
CREATE INDEX `ix_projects_agency_client` ON `sanctum_projects` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `ix_projects_agency_status` ON `sanctum_projects` (`agency_id`,`status`);