CREATE TABLE `sanctum_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'misc' NOT NULL,
	`client_id` text,
	`project_id` text,
	`file_url` text NOT NULL,
	`public_id` text,
	`resource_type` text DEFAULT 'image' NOT NULL,
	`format` text,
	`mime_type` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`client_visible` integer DEFAULT false NOT NULL,
	`uploaded_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`uploaded_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_documents_agency_created` ON `sanctum_documents` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_sheets` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`title` text DEFAULT 'Untitled Sheet' NOT NULL,
	`client_id` text,
	`project_id` text,
	`data` text DEFAULT '{}' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_sheets_agency_updated` ON `sanctum_sheets` (`agency_id`,`updated_at`);