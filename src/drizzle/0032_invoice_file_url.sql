-- Document-sourced invoices carry the uploaded file URL, mirroring
-- proposals.file_url / agreements.file_url (added in 0026). Nullable.
ALTER TABLE `sanctum_invoices` ADD COLUMN `file_url` text;
