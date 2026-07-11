ALTER TABLE "auth"."apikeys" RENAME COLUMN "user_id" TO "reference_id";--> statement-breakpoint
ALTER TABLE "auth"."apikeys" DROP CONSTRAINT "apikeys_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "auth"."apikeys_user_id_idx";--> statement-breakpoint
ALTER TABLE "auth"."apikeys" ADD COLUMN "config_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth"."apikeys" ADD CONSTRAINT "apikeys_reference_id_users_id_fk" FOREIGN KEY ("reference_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apikeys_config_id_idx" ON "auth"."apikeys" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikeys_reference_id_idx" ON "auth"."apikeys" USING btree ("reference_id");