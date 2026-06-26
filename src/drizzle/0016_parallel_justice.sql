CREATE TABLE `sanctum_custom_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`color_token` text DEFAULT 'pine' NOT NULL,
	`base_role` text DEFAULT 'member' NOT NULL,
	`permissions_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_custom_roles_agency_name` ON `sanctum_custom_roles` (`agency_id`,`name`);--> statement-breakpoint
CREATE INDEX `ix_custom_roles_agency` ON `sanctum_custom_roles` (`agency_id`);--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `custom_role_id` text;