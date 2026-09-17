-- Authorization redesign (docs/authorization/README.md §H).
-- Normalized roles / grants / assignments / overrides, server-side sessions,
-- task ownership, and client project-access columns. Legacy columns
-- (users.role, users.permissions_json, users.custom_role_id, custom_roles,
-- agencies.role_permissions_json) are left untouched; they are migrated by
-- src/authz/migrate-legacy.ts and dropped in a later migration.
CREATE TABLE IF NOT EXISTS `sanctum_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`key` text,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL CHECK (`kind` IN ('system','custom')),
	`actor_type` text NOT NULL CHECK (`actor_type` IN ('staff','client')),
	`is_locked` integer DEFAULT false NOT NULL,
	`color_token` text DEFAULT 'pine' NOT NULL,
	`template_key` text,
	`archived_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_roles_agency_key` ON `sanctum_roles` (`agency_id`,`key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_roles_agency` ON `sanctum_roles` (`agency_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_roles_agency_name_active` ON `sanctum_roles` (`agency_id`, lower(`name`)) WHERE `archived_at` IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sanctum_role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL CHECK (`scope` IN ('own','assigned','project','client','organization')),
	PRIMARY KEY(`role_id`, `permission`, `scope`),
	FOREIGN KEY (`role_id`) REFERENCES `sanctum_roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sanctum_user_roles` (
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`agency_id` text NOT NULL,
	`assigned_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`user_id`, `role_id`),
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `sanctum_roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_user_roles_agency_role` ON `sanctum_user_roles` (`agency_id`,`role_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sanctum_user_permission_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text CHECK (`scope` IS NULL OR `scope` IN ('own','assigned','project','client','organization')),
	`effect` text NOT NULL CHECK (`effect` IN ('grant','deny')),
	`reason` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CHECK ((`effect` = 'grant' AND `scope` IS NOT NULL) OR (`effect` = 'deny' AND `scope` IS NULL)),
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_user_overrides` ON `sanctum_user_permission_overrides` (`user_id`,`permission`,`effect`, coalesce(`scope`, ''));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_user_overrides_agency_user` ON `sanctum_user_permission_overrides` (`agency_id`,`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sanctum_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`actor_type` text NOT NULL CHECK (`actor_type` IN ('staff','client','portal_link')),
	`user_id` text,
	`portal_token_id` text,
	`refresh_hash` text NOT NULL,
	`prev_refresh_hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_reason` text,
	`ip` text,
	`user_agent` text,
	CHECK ((`actor_type` = 'portal_link' AND `portal_token_id` IS NOT NULL) OR (`actor_type` <> 'portal_link' AND `user_id` IS NOT NULL)),
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portal_token_id`) REFERENCES `sanctum_portal_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_sessions_refresh` ON `sanctum_sessions` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_sessions_prev_refresh` ON `sanctum_sessions` (`prev_refresh_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_sessions_user` ON `sanctum_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_sessions_portal_token` ON `sanctum_sessions` (`portal_token_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sanctum_portal_token_projects` (
	`token_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`token_id`, `project_id`),
	FOREIGN KEY (`token_id`) REFERENCES `sanctum_portal_tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sanctum_agencies` ADD `authz_migrated_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_portal_tokens` ADD `role_id` text REFERENCES sanctum_roles(id);--> statement-breakpoint
ALTER TABLE `sanctum_portal_tokens` ADD `project_access` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_project_tasks` ADD `created_by` text REFERENCES sanctum_users(id);--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `kind` text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `authz_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `client_project_access` text;--> statement-breakpoint
UPDATE `sanctum_users` SET `kind` = 'client' WHERE `role` = 'client';
