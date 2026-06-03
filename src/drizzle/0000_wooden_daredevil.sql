CREATE TABLE `sanctum_agencies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo_url` text,
	`brand_color` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sanctum_agencies_slug_unique` ON `sanctum_agencies` (`slug`);--> statement-breakpoint
CREATE TABLE `sanctum_ai_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`requested_by` text,
	`period` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`model` text,
	`prompt_summary` text,
	`posts_created` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_ai_agency_period` ON `sanctum_ai_generations` (`agency_id`,`period`,`status`);--> statement-breakpoint
CREATE INDEX `ix_ai_agency_client` ON `sanctum_ai_generations` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `sanctum_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`metadata_json` text,
	`ip` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_audit_agency_created` ON `sanctum_audit_log` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_agency_entity` ON `sanctum_audit_log` (`agency_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `sanctum_brand_strategy` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`tone` text,
	`audience` text,
	`pillars_json` text,
	`dos` text,
	`donts` text,
	`notes` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sanctum_brand_strategy_client_id_unique` ON `sanctum_brand_strategy` (`client_id`);--> statement-breakpoint
CREATE INDEX `ix_strategy_agency` ON `sanctum_brand_strategy` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sanctum_client_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`assigned_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_assign_client_user` ON `sanctum_client_assignments` (`client_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_assign_agency_user` ON `sanctum_client_assignments` (`agency_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ix_assign_agency_client` ON `sanctum_client_assignments` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `sanctum_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`logo_url` text,
	`brand_color` text,
	`handles_json` text,
	`contact_email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`portal_visible_statuses` text DEFAULT 'pending_approval,approved,scheduled,posted' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_clients_agency` ON `sanctum_clients` (`agency_id`);--> statement-breakpoint
CREATE INDEX `ix_clients_agency_status` ON `sanctum_clients` (`agency_id`,`status`);--> statement-breakpoint
CREATE TABLE `sanctum_content_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`post_type` text NOT NULL,
	`caption` text,
	`platforms_json` text DEFAULT '[]' NOT NULL,
	`scheduled_at` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by` text,
	`ai_generation_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ai_generation_id`) REFERENCES `sanctum_ai_generations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_posts_agency_client_sched` ON `sanctum_content_posts` (`agency_id`,`client_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `ix_posts_agency_client_status` ON `sanctum_content_posts` (`agency_id`,`client_id`,`status`);--> statement-breakpoint
CREATE TABLE `sanctum_credentials_vault` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`platform` text NOT NULL,
	`username` text,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`auth_tag` blob NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_vault_agency_client` ON `sanctum_credentials_vault` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `sanctum_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sanctum_invites_token_hash_unique` ON `sanctum_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_invites_agency` ON `sanctum_invites` (`agency_id`);--> statement-breakpoint
CREATE INDEX `ix_invites_agency_status` ON `sanctum_invites` (`agency_id`,`status`);--> statement-breakpoint
CREATE TABLE `sanctum_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`max_clients` integer,
	`max_team_members` integer,
	`max_ai_generations` integer,
	`max_storage_bytes` integer,
	`price_cents_monthly` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sanctum_portal_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`created_by` text,
	`revoked` integer DEFAULT false NOT NULL,
	`revoked_at` integer,
	`expires_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sanctum_portal_tokens_token_hash_unique` ON `sanctum_portal_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_tokens_agency_client` ON `sanctum_portal_tokens` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `sanctum_post_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`post_id` text NOT NULL,
	`portal_token_id` text NOT NULL,
	`decision` text NOT NULL,
	`note` text,
	`actor_label` text,
	`ip` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `sanctum_content_posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portal_token_id`) REFERENCES `sanctum_portal_tokens`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ix_approvals_agency_post` ON `sanctum_post_approvals` (`agency_id`,`post_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_post_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`post_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_user_id` text,
	`portal_token_id` text,
	`author_label` text,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `sanctum_content_posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`portal_token_id`) REFERENCES `sanctum_portal_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_comments_agency_post` ON `sanctum_post_comments` (`agency_id`,`post_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sanctum_post_media` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`post_id` text NOT NULL,
	`cloudinary_public_id` text NOT NULL,
	`secure_url` text NOT NULL,
	`resource_type` text NOT NULL,
	`format` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`width` integer,
	`height` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `sanctum_content_posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_media_agency_post` ON `sanctum_post_media` (`agency_id`,`post_id`);--> statement-breakpoint
CREATE INDEX `ix_media_agency` ON `sanctum_post_media` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sanctum_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_period_start` integer,
	`current_period_end` integer,
	`external_customer_id` text,
	`external_subscription_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `sanctum_plans`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ix_subscriptions_agency` ON `sanctum_subscriptions` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sanctum_usage_counters` (
	`agency_id` text NOT NULL,
	`period` text NOT NULL,
	`ai_generations_used` integer DEFAULT 0 NOT NULL,
	`storage_bytes_used` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pk_usage_counters` ON `sanctum_usage_counters` (`agency_id`,`period`);--> statement-breakpoint
CREATE TABLE `sanctum_users` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_users_agency_email` ON `sanctum_users` (`agency_id`,lower("email"));--> statement-breakpoint
CREATE INDEX `ix_users_agency` ON `sanctum_users` (`agency_id`);