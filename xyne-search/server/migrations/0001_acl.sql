CREATE TABLE "acl" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" integer NOT NULL,
	"role" text NOT NULL,
	"source_type" text DEFAULT 'direct' NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acl" ADD CONSTRAINT "acl_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acl" ADD CONSTRAINT "acl_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acl_unique_grant" ON "acl" USING btree ("resource_type","resource_id","principal_type","principal_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "acl_resource_index" ON "acl" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "acl_principal_index" ON "acl" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "acl_source_index" ON "acl" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "acl_workspace_index" ON "acl" USING btree ("workspace_id");