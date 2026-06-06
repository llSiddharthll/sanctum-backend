CREATE TABLE `sanctum_message_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`subject` text NOT NULL,
	`client_id` text,
	`project_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text,
	`last_message_at` integer,
	`last_message_preview` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_threads_agency_last_message` ON `sanctum_message_threads` (`agency_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `sanctum_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sender_id` text,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `sanctum_message_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_messages_thread_created` ON `sanctum_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_thread_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `sanctum_message_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_thread_participants_thread_user` ON `sanctum_thread_participants` (`thread_id`,`user_id`);