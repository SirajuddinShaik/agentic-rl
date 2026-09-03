ALTER TABLE "user_agent_permissions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_agent_permissions" CASCADE;--> statement-breakpoint
ALTER TABLE "collection_items" DROP CONSTRAINT "collection_items_owner_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_collection_privacy";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "is_public";--> statement-breakpoint
ALTER TABLE "collection_items" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "collections" DROP COLUMN "is_private";--> statement-breakpoint
ALTER TABLE "collections" DROP COLUMN "permissions";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "is_private";--> statement-breakpoint
DROP TYPE "public"."user_agent_role";