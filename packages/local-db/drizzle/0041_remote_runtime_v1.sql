CREATE TABLE `remote_workspace_bindings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`remote_host_id` text NOT NULL,
	`remote_path` text,
	`port_forwards` text NOT NULL,
	`tunnel_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`remote_host_id`) REFERENCES `remote_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `remote_workspace_bindings_host_idx` ON `remote_workspace_bindings` (`remote_host_id`);