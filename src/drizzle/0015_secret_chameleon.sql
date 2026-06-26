CREATE TABLE `sanctum_client_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`email` text,
	`phone` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`is_billing` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_client_contacts_agency_client` ON `sanctum_client_contacts` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `sanctum_client_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`author_id` text,
	`type` text DEFAULT 'note' NOT NULL,
	`body` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`due_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_client_notes_agency_client_created` ON `sanctum_client_notes` (`agency_id`,`client_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_client_tag_links` (
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`client_id`, `tag_id`),
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `sanctum_client_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_client_tag_links_tag` ON `sanctum_client_tag_links` (`tag_id`);--> statement-breakpoint
CREATE INDEX `ix_client_tag_links_agency_client` ON `sanctum_client_tag_links` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `sanctum_client_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`color_token` text DEFAULT 'pine' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_client_tags_agency_name` ON `sanctum_client_tags` (`agency_id`,`name`);--> statement-breakpoint
CREATE TABLE `sanctum_deals` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`title` text NOT NULL,
	`stage` text DEFAULT 'lead' NOT NULL,
	`value_paise` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`probability` integer DEFAULT 0 NOT NULL,
	`expected_close_at` integer,
	`owner_id` text,
	`lost_reason` text,
	`notes` text,
	`created_by` text,
	`closed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_deals_agency_stage` ON `sanctum_deals` (`agency_id`,`stage`);--> statement-breakpoint
CREATE INDEX `ix_deals_agency_client` ON `sanctum_deals` (`agency_id`,`client_id`);--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `owner_id` text REFERENCES sanctum_users(id);--> statement-breakpoint
CREATE INDEX `ix_clients_agency_owner` ON `sanctum_clients` (`agency_id`,`owner_id`);--> statement-breakpoint
CREATE INDEX `ix_clients_agency_followup` ON `sanctum_clients` (`agency_id`,`next_follow_up_at`);