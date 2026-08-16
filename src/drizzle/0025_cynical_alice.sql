CREATE TABLE `sanctum_agreement_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'msa' NOT NULL,
	`description` text,
	`terms_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_agreement_templates_agency` ON `sanctum_agreement_templates` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sanctum_agreements` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`proposal_id` text,
	`project_id` text,
	`template_id` text,
	`agreement_number` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`effective_date` integer,
	`expiration_date` integer,
	`retainer_paise` integer DEFAULT 0,
	`total_value_paise` integer DEFAULT 0,
	`currency` text DEFAULT 'INR' NOT NULL,
	`terms_json` text NOT NULL,
	`token` text,
	`sent_at` integer,
	`signed_at` integer,
	`signer_name` text,
	`signer_email` text,
	`signer_ip` text,
	`signature_data_url` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposal_id`) REFERENCES `sanctum_proposals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `sanctum_agreement_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_agreements_agency_number` ON `sanctum_agreements` (`agency_id`,`agreement_number`);--> statement-breakpoint
CREATE INDEX `ix_agreements_agency` ON `sanctum_agreements` (`agency_id`);--> statement-breakpoint
CREATE INDEX `ix_agreements_agency_client` ON `sanctum_agreements` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `ix_agreements_token` ON `sanctum_agreements` (`token`);--> statement-breakpoint
CREATE TABLE `sanctum_proposal_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`description` text,
	`content_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_proposal_templates_agency` ON `sanctum_proposal_templates` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sanctum_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text,
	`lead_id` text,
	`template_id` text,
	`proposal_number` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`subtotal_paise` integer DEFAULT 0 NOT NULL,
	`tax_paise` integer DEFAULT 0 NOT NULL,
	`total_paise` integer DEFAULT 0 NOT NULL,
	`valid_until` integer,
	`content_json` text NOT NULL,
	`token` text,
	`sent_at` integer,
	`viewed_at` integer,
	`accepted_at` integer,
	`accepted_by` text,
	`rejected_at` integer,
	`rejection_reason` text,
	`converted_agreement_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lead_id`) REFERENCES `sanctum_leads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_id`) REFERENCES `sanctum_proposal_templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_proposals_agency_number` ON `sanctum_proposals` (`agency_id`,`proposal_number`);--> statement-breakpoint
CREATE INDEX `ix_proposals_agency` ON `sanctum_proposals` (`agency_id`);--> statement-breakpoint
CREATE INDEX `ix_proposals_agency_client` ON `sanctum_proposals` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `ix_proposals_agency_lead` ON `sanctum_proposals` (`agency_id`,`lead_id`);--> statement-breakpoint
CREATE INDEX `ix_proposals_token` ON `sanctum_proposals` (`token`);