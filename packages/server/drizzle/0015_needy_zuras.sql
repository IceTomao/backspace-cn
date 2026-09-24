CREATE TABLE `channel_notification_settings` (
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `channel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_channel_notification_settings_user_id` ON `channel_notification_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `favorite_media` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`filename` text NOT NULL,
	`mimetype` text NOT NULL,
	`size` integer NOT NULL,
	`storage_name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_favorite_media_user_hash` ON `favorite_media` (`user_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_favorite_media_user_id` ON `favorite_media` (`user_id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `idx_push_subscriptions_user_id` ON `push_subscriptions` (`user_id`);