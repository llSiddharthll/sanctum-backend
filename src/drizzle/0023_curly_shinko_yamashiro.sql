CREATE TABLE `sanctum_client_user_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_client_user_projects` ON `sanctum_client_user_projects` (`user_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `ix_client_user_projects_user` ON `sanctum_client_user_projects` (`user_id`);--> statement-breakpoint
CREATE TABLE `sanctum_lead_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`author_id` text,
	`type` text DEFAULT 'note' NOT NULL,
	`body` text NOT NULL,
	`due_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `sanctum_leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_lead_activities_lead_created` ON `sanctum_lead_activities` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`company` text,
	`email` text,
	`phone` text,
	`source` text,
	`service` text,
	`budget` text,
	`message` text,
	`stage` text DEFAULT 'new' NOT NULL,
	`estimated_value` integer,
	`owner_id` text,
	`converted_client_id` text,
	`last_activity_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_leads_agency_stage_created` ON `sanctum_leads` (`agency_id`,`stage`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_push_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agency_id` text NOT NULL,
	`platform` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_push_tokens_user` ON `sanctum_push_tokens` (`user_id`);--> statement-breakpoint
ALTER TABLE `sanctum_invites` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `sanctum_invites` ADD `project_scope_json` text;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `client_id` text;