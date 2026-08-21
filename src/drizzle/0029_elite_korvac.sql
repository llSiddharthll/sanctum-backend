ALTER TABLE `sanctum_documents` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_documents` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_post_media` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sanctum_post_media` ADD `archived_at` integer;