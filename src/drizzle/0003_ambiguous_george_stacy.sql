CREATE TABLE `sanctum_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`project_id` text,
	`client_id` text,
	`category` text DEFAULT 'other' NOT NULL,
	`amount` integer NOT NULL,
	`description` text,
	`expense_date` integer,
	`receipt_url` text,
	`gst_deductible` integer DEFAULT false NOT NULL,
	`gst_amount` integer,
	`logged_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`logged_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_expenses_agency` ON `sanctum_expenses` (`agency_id`);--> statement-breakpoint
CREATE INDEX `ix_expenses_agency_category` ON `sanctum_expenses` (`agency_id`,`category`);--> statement-breakpoint
CREATE INDEX `ix_expenses_agency_date` ON `sanctum_expenses` (`agency_id`,`expense_date`);--> statement-breakpoint
CREATE INDEX `ix_expenses_agency_project` ON `sanctum_expenses` (`agency_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `ix_expenses_agency_client` ON `sanctum_expenses` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `sanctum_invoice_items` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`description` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit` text DEFAULT 'piece' NOT NULL,
	`rate` integer DEFAULT 0 NOT NULL,
	`gst_rate` real DEFAULT 18 NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `sanctum_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_invoice_items_agency_invoice` ON `sanctum_invoice_items` (`agency_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `ix_invoice_items_invoice` ON `sanctum_invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `sanctum_invoice_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`amount` integer NOT NULL,
	`paid_at` integer,
	`method` text DEFAULT 'bank_transfer' NOT NULL,
	`reference` text,
	`notes` text,
	`recorded_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `sanctum_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_invoice_payments_agency_invoice` ON `sanctum_invoice_payments` (`agency_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `ix_invoice_payments_agency_paid` ON `sanctum_invoice_payments` (`agency_id`,`paid_at`);--> statement-breakpoint
CREATE TABLE `sanctum_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`client_id` text NOT NULL,
	`project_id` text,
	`invoice_number` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`issue_date` integer,
	`due_date` integer,
	`is_interstate` integer DEFAULT false NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`subtotal` integer DEFAULT 0 NOT NULL,
	`tax_total` integer DEFAULT 0 NOT NULL,
	`cgst` integer DEFAULT 0 NOT NULL,
	`sgst` integer DEFAULT 0 NOT NULL,
	`igst` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`terms` text,
	`bank_details` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `sanctum_clients`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `sanctum_projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_invoices_agency_number` ON `sanctum_invoices` (`agency_id`,`invoice_number`);--> statement-breakpoint
CREATE INDEX `ix_invoices_agency` ON `sanctum_invoices` (`agency_id`);--> statement-breakpoint
CREATE INDEX `ix_invoices_agency_status` ON `sanctum_invoices` (`agency_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_invoices_agency_client` ON `sanctum_invoices` (`agency_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `ix_invoices_agency_project` ON `sanctum_invoices` (`agency_id`,`project_id`);