-- Refrens two-way invoice sync.
-- Adds external-identity columns so a Sanctum invoice can be matched 1:1 with a
-- Refrens invoice in both directions without duplicating rows.
ALTER TABLE `sanctum_invoices` ADD COLUMN `refrens_id` text;--> statement-breakpoint
ALTER TABLE `sanctum_invoices` ADD COLUMN `external_source` text;--> statement-breakpoint
ALTER TABLE `sanctum_invoices` ADD COLUMN `refrens_synced_at` integer;--> statement-breakpoint
ALTER TABLE `sanctum_invoices` ADD COLUMN `refrens_sync_error` text;--> statement-breakpoint
ALTER TABLE `sanctum_invoice_payments` ADD COLUMN `refrens_payment_id` text;--> statement-breakpoint
ALTER TABLE `sanctum_clients` ADD COLUMN `refrens_client_id` text;--> statement-breakpoint
-- Upsert keys. SQLite treats NULLs as distinct, so rows that have no Refrens
-- counterpart (Sanctum-only invoices/payments) are unaffected by the UNIQUEs.
CREATE UNIQUE INDEX IF NOT EXISTS `ux_invoices_agency_refrens` ON `sanctum_invoices` (`agency_id`,`refrens_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_invoice_payments_agency_refrens` ON `sanctum_invoice_payments` (`agency_id`,`refrens_payment_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_clients_agency_refrens` ON `sanctum_clients` (`agency_id`,`refrens_client_id`);
