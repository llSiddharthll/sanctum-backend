CREATE TABLE `sanctum_attendance_regularizations` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`type` text NOT NULL,
	`requested_check_in_at` integer,
	`requested_check_out_at` integer,
	`requested_status` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_regular_agency_status` ON `sanctum_attendance_regularizations` (`agency_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_regular_agency_user` ON `sanctum_attendance_regularizations` (`agency_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `sanctum_holidays` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`day` text NOT NULL,
	`name` text NOT NULL,
	`recurring` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_holidays_agency_day` ON `sanctum_holidays` (`agency_id`,`day`);--> statement-breakpoint
CREATE INDEX `ix_holidays_agency` ON `sanctum_holidays` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sanctum_leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`start_day` text NOT NULL,
	`end_day` text NOT NULL,
	`half_day_start` integer DEFAULT false NOT NULL,
	`half_day_end` integer DEFAULT false NOT NULL,
	`days` real DEFAULT 0 NOT NULL,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`leave_type_id`) REFERENCES `sanctum_leave_types`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`decided_by`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_leave_req_agency_status` ON `sanctum_leave_requests` (`agency_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_leave_req_agency_user` ON `sanctum_leave_requests` (`agency_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `sanctum_leave_types` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`name` text NOT NULL,
	`color_token` text DEFAULT 'pine' NOT NULL,
	`paid` integer DEFAULT true NOT NULL,
	`annual_quota` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_leave_types_agency_name` ON `sanctum_leave_types` (`agency_id`,`name`);--> statement-breakpoint
CREATE INDEX `ix_leave_types_agency` ON `sanctum_leave_types` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sanctum_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`entity_type` text,
	`entity_id` text,
	`link` text,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_notifications_user_created` ON `sanctum_notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_notifications_user_unread` ON `sanctum_notifications` (`user_id`,`read_at`);