ALTER TABLE `sanctum_clients` ADD `industry` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `website` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `phone_cc` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `client_source` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `gst_number` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `payment_terms_days` integer;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `billing_address` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `billing_state` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `billing_city` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `billing_pincode` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `relationship_health` text DEFAULT 'good' NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `next_follow_up_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD `internal_notes` text;