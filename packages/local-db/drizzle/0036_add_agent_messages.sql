CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text DEFAULT 'main' NOT NULL,
	`agent_name` text NOT NULL,
	`workspace_id` text,
	`content` text NOT NULL,
	`role` text DEFAULT 'assistant' NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_messages_conversation_id_idx` ON `agent_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `agent_messages_agent_name_idx` ON `agent_messages` (`agent_name`);--> statement-breakpoint
CREATE INDEX `agent_messages_created_at_idx` ON `agent_messages` (`created_at`);