-- Pinned messages: the few messages that explain what is going on with a client.
-- Surfaced on the client overview so anyone joining mid-flight can catch up.
ALTER TABLE `sanctum_messages` ADD COLUMN `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_messages` ADD COLUMN `pinned_by` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_messages_thread_pinned` ON `sanctum_messages` (`thread_id`,`pinned_at`);
