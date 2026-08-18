ALTER TABLE `sanctum_agreements` ADD `file_url` text;--> statement-breakpoint
ALTER TABLE `sanctum_documents` ADD `hide_from_team` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_projects` ADD `billing_type` text DEFAULT 'one_time' NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_projects` ADD `recurring_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_proposals` ADD `billing_type` text DEFAULT 'one_time' NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_proposals` ADD `recurring_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_proposals` ADD `file_url` text;--> statement-breakpoint
ALTER TABLE `sanctum_users` ADD `monthly_salary_paise` integer;