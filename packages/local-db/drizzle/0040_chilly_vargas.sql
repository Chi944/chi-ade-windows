CREATE TABLE `remote_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`user` text,
	`port` integer DEFAULT 22 NOT NULL,
	`identity_file` text,
	`remote_root` text,
	`agent_forwarding` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_hosts_name_idx` ON `remote_hosts` (`name`);--> statement-breakpoint
CREATE INDEX `remote_hosts_host_idx` ON `remote_hosts` (`host`);