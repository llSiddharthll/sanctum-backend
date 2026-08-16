CREATE TABLE `sanctum_attendance_checkout_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`requested_check_out_at` integer NOT NULL,
	`check_out_lat` real,
	`check_out_lng` real,
	`check_out_location` text,
	`distance_m` integer,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_checkout_req_agency_status` ON `sanctum_attendance_checkout_requests` (`agency_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_checkout_req_agency_user` ON `sanctum_attendance_checkout_requests` (`agency_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `sanctum_document_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`client_id` text,
	`project_id` text,
	`client_visible` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_document_folders_agency_parent` ON `sanctum_document_folders` (`agency_id`,`parent_id`);--> statement-breakpoint
ALTER TABLE `sanctum_documents` ADD `folder_id` text;