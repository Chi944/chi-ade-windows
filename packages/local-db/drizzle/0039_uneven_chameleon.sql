CREATE TABLE `agent_message_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`acknowledged_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `agent_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_message_receipts_message_workspace_idx` ON `agent_message_receipts` (`message_id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `agent_message_receipts_workspace_idx` ON `agent_message_receipts` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `shared_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scope` text DEFAULT 'project' NOT NULL,
	`workspace_id` text DEFAULT '' NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`summary` text,
	`author_workspace_id` text,
	`content_hash` text NOT NULL,
	`token_estimate` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_memories_project_scope_key_idx` ON `shared_memories` (`project_id`,`scope`,`workspace_id`,`key`);--> statement-breakpoint
CREATE INDEX `shared_memories_project_updated_at_idx` ON `shared_memories` (`project_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `recipient_workspace_id` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `kind` text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `status` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `token_estimate` integer;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `correlation_id` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `reply_to_id` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `acknowledged_at` integer;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `agent_messages` SET `updated_at` = `created_at` WHERE `updated_at` = 0;--> statement-breakpoint
CREATE INDEX `agent_messages_project_id_idx` ON `agent_messages` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_messages_recipient_status_idx` ON `agent_messages` (`recipient_workspace_id`,`status`);
