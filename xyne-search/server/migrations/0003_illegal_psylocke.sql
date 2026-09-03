CREATE TABLE "mcp_agent_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_id" uuid NOT NULL,
	"agent_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"config" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_agent_mappings" ADD CONSTRAINT "mcp_agent_mappings_mcp_id_mcps_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_agent_mappings" ADD CONSTRAINT "mcp_agent_mappings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcps" ADD CONSTRAINT "mcps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_agent_unique_index" ON "mcp_agent_mappings" USING btree ("mcp_id","agent_id");--> statement-breakpoint
CREATE INDEX "mcp_agent_mcp_id_index" ON "mcp_agent_mappings" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX "mcp_agent_agent_id_index" ON "mcp_agent_mappings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mcp_created_by_index" ON "mcps" USING btree ("created_by");