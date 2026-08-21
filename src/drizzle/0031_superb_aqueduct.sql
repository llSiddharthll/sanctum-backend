CREATE TABLE `sanctum_calendar_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text,
	`date` integer NOT NULL,
	`label` text DEFAULT 'Reserved' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_reservations_agency_client_date` ON `sanctum_calendar_reservations` (`agency_id`,`client_id`,`date`);