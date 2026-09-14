-- Meta social connect + auto-publish: a client's connected Instagram / Facebook
-- Page accounts (tokens sealed with VAULT_ENC_KEY), short-lived connect
-- sessions, and one publication record per (post, account).
CREATE TABLE IF NOT EXISTS `sanctum_social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`page_id` text,
	`username` text,
	`display_name` text,
	`avatar_url` text,
	`followers_count` integer,
	`access_token_enc` text NOT NULL,
	`meta_user_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`auto_publish` integer DEFAULT 1 NOT NULL,
	`connected_by` text,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_social_account` ON `sanctum_social_accounts` (`agency_id`,`client_id`,`platform`,`external_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_social_agency_client` ON `sanctum_social_accounts` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sanctum_social_connect_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`payload_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sanctum_post_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`post_id` text NOT NULL,
	`social_account_id` text NOT NULL,
	`platform` text NOT NULL,
	`status` text DEFAULT 'publishing' NOT NULL,
	`container_id` text,
	`external_post_id` text,
	`permalink` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `sanctum_content_posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`social_account_id`) REFERENCES `sanctum_social_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_publication_post_account` ON `sanctum_post_publications` (`post_id`,`social_account_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_publications_agency_post` ON `sanctum_post_publications` (`agency_id`,`post_id`);
