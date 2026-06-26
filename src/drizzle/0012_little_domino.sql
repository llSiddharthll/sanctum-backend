CREATE TABLE `sanctum_attendance_policy` (
	`agency_id` text PRIMARY KEY NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`workdays_csv` text DEFAULT '1,2,3,4,5' NOT NULL,
	`shift_start_min` integer DEFAULT 540 NOT NULL,
	`shift_end_min` integer DEFAULT 1080 NOT NULL,
	`full_day_minutes` integer DEFAULT 480 NOT NULL,
	`half_day_minutes` integer DEFAULT 240 NOT NULL,
	`late_grace_minutes` integer DEFAULT 15 NOT NULL,
	`count_overtime` integer DEFAULT true NOT NULL,
	`enforce_ip` integer DEFAULT false NOT NULL,
	`allowed_ips_csv` text,
	`enforce_geo` integer DEFAULT false NOT NULL,
	`geo_lat` real,
	`geo_lng` real,
	`geo_radius_m` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sanctum_attendance_records` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`check_in_at` integer,
	`check_out_at` integer,
	`worked_minutes` integer DEFAULT 0 NOT NULL,
	`overtime_minutes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'present' NOT NULL,
	`is_late` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'self' NOT NULL,
	`note` text,
	`check_in_ip` text,
	`check_in_lat` real,
	`check_in_lng` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `sanctum_agencies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `sanctum_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_attendance_user_day` ON `sanctum_attendance_records` (`user_id`,`day`);--> statement-breakpoint
CREATE INDEX `ix_attendance_agency_day` ON `sanctum_attendance_records` (`agency_id`,`day`);--> statement-breakpoint
CREATE INDEX `ix_attendance_agency_user_day` ON `sanctum_attendance_records` (`agency_id`,`user_id`,`day`);