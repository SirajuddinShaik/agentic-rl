CREATE SCHEMA "workflow";
--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('User', 'TeamLeader', 'Admin', 'SuperAdmin');--> statement-breakpoint
CREATE TYPE "public"."app_type" AS ENUM('google-workspace', 'google-drive', 'gmail', 'google-calendar', 'slack', 'mcp', 'github', 'xyne', 'data-source', 'database', 'KnowledgeBase', 'web-search', 'chat-memory', 'microsoft-drive', 'microsoft-outlook', 'microsoft-calendar', 'microsoft-sharepoint', 'attachment', 'zoho-desk');--> statement-breakpoint
CREATE TYPE "public"."auth_type" AS ENUM('oauth', 'service_account', 'custom', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."connector_type" AS ENUM('SaaS', 'Database', 'Api', 'File', 'Website', 'Mcp');--> statement-breakpoint
CREATE TYPE "public"."status" AS ENUM('connected', 'connecting', 'paused', 'failed', 'not-connected', 'authenticated');--> statement-breakpoint
CREATE TYPE "public"."type" AS ENUM('ChangeToken', 'Partial', 'FullSync');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('NotStarted', 'Started', 'Failed', 'Successful');--> statement-breakpoint
CREATE TYPE "public"."chat_type" AS ENUM('default', 'kb_chat');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('web', 'mobile', 'slack');--> statement-breakpoint
CREATE TYPE "public"."message_feedback" AS ENUM('like', 'dislike');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('system', 'user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."creation_source" AS ENUM('direct', 'workflow');--> statement-breakpoint
CREATE TYPE "public"."user_agent_role" AS ENUM('owner', 'editor', 'viewer', 'shared');--> statement-breakpoint
CREATE TYPE "public"."sdk_resource_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."step_type" AS ENUM('manual', 'automated');--> statement-breakpoint
CREATE TYPE "public"."tool_execution_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tool_type" AS ENUM('delay', 'slack', 'gmail', 'agent', 'merged_node', 'form', 'email', 'ai_agent', 'qna_agent', 'webhook', 'http_request', 'jira');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('draft', 'active', 'processing', 'paused', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."call_type" AS ENUM('video', 'audio');--> statement-breakpoint
CREATE TYPE "public"."user_workflow_role" AS ENUM('owner', 'shared', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."channel_member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('channel', 'direct');--> statement-breakpoint
CREATE TYPE "public"."ingestion_status" AS ENUM('pending', 'in_progress', 'paused', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."v2_chat_conversation_origin" AS ENUM('chat', 'extract', 'ephemeral');--> statement-breakpoint
CREATE TYPE "public"."v2_chat_message_feedback_rating" AS ENUM('like', 'dislike');--> statement-breakpoint
CREATE TYPE "public"."v2_chat_message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."v2_chat_tool_call_status" AS ENUM('pending', 'completed', 'error');--> statement-breakpoint
CREATE TYPE "public"."v2_chat_turn_status" AS ENUM('running', 'completed', 'errored', 'aborted');--> statement-breakpoint
CREATE TABLE "abbreviation" (
	"id" serial PRIMARY KEY NOT NULL,
	"word" text NOT NULL,
	"full_form" text NOT NULL,
	"votes" integer DEFAULT 0 NOT NULL,
	"total_defs" integer DEFAULT 0 NOT NULL,
	"alt_count" integer DEFAULT 0 NOT NULL,
	"example_doc_id" text,
	"all_full_forms" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"created_by" text NOT NULL,
	"external_id" text NOT NULL,
	"photoLink" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspaces_domain_unique" UNIQUE("domain"),
	CONSTRAINT "workspaces_created_by_unique" UNIQUE("created_by"),
	CONSTRAINT "workspaces_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"photoLink" text,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_login" timestamp with time zone,
	"role" "role" DEFAULT 'User' NOT NULL,
	"refreshToken" text,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "user_personalization" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"email" text NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vespa_system_prompt" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "user_personalization_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "connector_type" NOT NULL,
	"auth_type" "auth_type" NOT NULL,
	"app_type" "app_type" NOT NULL,
	"config" jsonb NOT NULL,
	"credentials" text,
	"subject" text,
	"oauth_credentials" text,
	"api_key" text,
	"status" "status" DEFAULT 'connecting' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "connectors_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "connectors_workspace_id_user_id_app_type_auth_type_name_unique" UNIQUE("workspace_id","user_id","app_type","auth_type","name")
);
--> statement-breakpoint
CREATE TABLE "oauth_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"connector_id" integer NOT NULL,
	"client_id" text,
	"client_secret" text,
	"oauth_scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"app_type" "app_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"is_global" boolean DEFAULT false,
	CONSTRAINT "oauth_providers_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"email" text NOT NULL,
	"connector_id" integer NOT NULL,
	"type" "type" NOT NULL,
	"status" "sync_status" DEFAULT 'NotStarted' NOT NULL,
	"app_type" "app_type" NOT NULL,
	"auth_type" "auth_type" NOT NULL,
	"config" jsonb NOT NULL,
	"last_ran_on" timestamp with time zone DEFAULT NOW(),
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sync_jobs_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "sync_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"data_added" integer DEFAULT 0 NOT NULL,
	"data_updated" integer DEFAULT 0 NOT NULL,
	"data_deleted" integer DEFAULT 0 NOT NULL,
	"summary" jsonb NOT NULL,
	"error_message" text DEFAULT '',
	"type" "type" NOT NULL,
	"status" "sync_status" NOT NULL,
	"auth_type" "auth_type" NOT NULL,
	"app_type" "app_type" NOT NULL,
	"config" jsonb NOT NULL,
	"last_ran_on" timestamp with time zone DEFAULT NOW(),
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sync_history_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"is_bookmarked" boolean DEFAULT false NOT NULL,
	"email" text NOT NULL,
	"title" text NOT NULL,
	"attachments" jsonb NOT NULL,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	"platform" "platform" DEFAULT 'web' NOT NULL,
	"via_apiKey" boolean DEFAULT false NOT NULL,
	"chat_type" "chat_type" DEFAULT 'default' NOT NULL,
	CONSTRAINT "chats_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"chat_external_id" text NOT NULL,
	"message" text NOT NULL,
	"message_role" "message_role" NOT NULL,
	"thinking" text DEFAULT '' NOT NULL,
	"deep_research_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"modelId" text NOT NULL,
	"email" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_citations" jsonb DEFAULT '[]' ::jsonb NOT NULL,
	"fileIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	"error_message" text DEFAULT '',
	"queryRouterClassification" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feedback" jsonb,
	"tokens_used" integer DEFAULT 0,
	"cost" numeric(10, 6) DEFAULT '0' NOT NULL,
	"is_summary" boolean DEFAULT false NOT NULL,
	"time_taken_ms" integer,
	CONSTRAINT "messages_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "chat_trace" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"chat_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"chat_external_id" text NOT NULL,
	"message_external_id" text NOT NULL,
	"email" text NOT NULL,
	"trace_json" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prompt" text,
	"model" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"app_integrations" jsonb DEFAULT '[]'::jsonb,
	"allow_web_search" boolean DEFAULT false,
	"is_rag_on" boolean DEFAULT true NOT NULL,
	"search_filter_enabled" boolean DEFAULT true NOT NULL,
	"doc_ids" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	"via_apiKey" boolean DEFAULT false NOT NULL,
	"creation_source" "creation_source" DEFAULT 'direct' NOT NULL,
	"system_prompt_main" text,
	"system_prompt_tools" text,
	"system_prompt_subagents" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_extractor" boolean DEFAULT false NOT NULL,
	"response_schema" jsonb,
	"extractor_max_retries" integer DEFAULT 2 NOT NULL,
	CONSTRAINT "agents_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "sub_agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"parent_agent_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"system_prompt" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thinking_level" text DEFAULT 'medium' NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sub_agents_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "user_agent_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"role" "user_agent_role" DEFAULT 'shared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sdk_resource_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"role" "sdk_resource_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"connector_id" integer NOT NULL,
	"external_id" text,
	"tool_name" text NOT NULL,
	"tool_schema" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "tools_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "tools_workspace_id_connector_id_tool_name_unique" UNIQUE("workspace_id","connector_id","tool_name")
);
--> statement-breakpoint
CREATE TABLE "shared_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"share_token" text NOT NULL,
	"title" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "shared_chats_share_token_unique" UNIQUE("share_token"),
	CONSTRAINT "unique_chat_message_share" UNIQUE("chat_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"parent_id" uuid,
	"workspace_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"path" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"vespa_doc_id" varchar(100),
	"total_file_count" integer DEFAULT 0 NOT NULL,
	"original_name" varchar(255),
	"storage_path" text,
	"storage_key" varchar(100),
	"mime_type" varchar(100),
	"file_size" bigint,
	"checksum" varchar(64),
	"uploaded_by_email" varchar(255),
	"uploaded_by_id" integer,
	"last_updated_by_email" varchar(255),
	"last_updated_by_id" integer,
	"processing_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp,
	"upload_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"vespa_metadata_sync_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"vespa_metadata_sync_attempts" integer DEFAULT 0 NOT NULL,
	"vespa_metadata_sync_error" text,
	"vespa_metadata_synced_at" timestamp,
	"vespa_metadata_sync_next_attempt_at" timestamp,
	"vespa_metadata_sync_started_at" timestamp,
	"status_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "collection_ls_projections" (
	"collection_id" uuid PRIMARY KEY NOT NULL,
	"projection" jsonb NOT NULL,
	"built_from_source_updated_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"vespa_doc_id" varchar(100) NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"allow_overrides" boolean DEFAULT false NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"last_updated_by_email" varchar(255),
	"last_updated_by_id" integer,
	"upload_status" varchar(20) DEFAULT 'completed' NOT NULL,
	"vespa_metadata_sync_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"vespa_metadata_sync_attempts" integer DEFAULT 0 NOT NULL,
	"vespa_metadata_sync_error" text,
	"vespa_metadata_synced_at" timestamp,
	"vespa_metadata_sync_next_attempt_at" timestamp,
	"vespa_metadata_sync_started_at" timestamp,
	"status_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb,
	"ls_projection_source_updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"via_apiKey" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docling_async_files" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"vespa_doc_id" text NOT NULL,
	"collection_id" uuid NOT NULL,
	"parent_id" uuid,
	"collection_name" text NOT NULL,
	"file_name" text NOT NULL,
	"original_name" text,
	"source_path" text NOT NULL,
	"source_storage_key" text,
	"stage_dir" text,
	"parts_dir" text,
	"results_dir" text,
	"manifest_path" text,
	"path" text DEFAULT '/' NOT NULL,
	"mime_type" text DEFAULT 'application/pdf' NOT NULL,
	"base_mime_type" text DEFAULT 'application/pdf' NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"uploaded_by_email" text,
	"page_title" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" text DEFAULT 'ingestion' NOT NULL,
	"base_priority" integer DEFAULT 0 NOT NULL,
	"priority_override" integer,
	"effective_priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_split' NOT NULL,
	"total_pages" integer DEFAULT 0 NOT NULL,
	"total_parts" integer DEFAULT 0 NOT NULL,
	"page_chunk_size" integer DEFAULT 0 NOT NULL,
	"ready_parts_count" integer DEFAULT 0 NOT NULL,
	"submitted_parts_count" integer DEFAULT 0 NOT NULL,
	"active_parts_count" integer DEFAULT 0 NOT NULL,
	"split_attempt_count" integer DEFAULT 0 NOT NULL,
	"write_attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"ocr_activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docling_async_parts" (
	"file_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"doc_id" text NOT NULL,
	"current_job_id" text,
	"part_path" text NOT NULL,
	"result_path" text,
	"start_page" integer NOT NULL,
	"end_page" integer NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"part_size_bytes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"submitted_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"written_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"submit_permit_id" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "docling_async_parts_pk" PRIMARY KEY("file_id","part_index")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled' NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"key_prefix" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_tool_id" uuid NOT NULL,
	"workflow_execution_id" uuid NOT NULL,
	"status" "tool_execution_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"root_workflow_step_exe_id" uuid,
	"completed_by" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_step_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_execution_id" uuid NOT NULL,
	"workflow_step_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "step_type" DEFAULT 'automated' NOT NULL,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"parent_step_id" uuid,
	"prev_step_ids" uuid[] DEFAULT '{}',
	"next_step_ids" uuid[] DEFAULT '{}',
	"tool_exec_ids" uuid[] DEFAULT '{}',
	"time_estimate" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"completed_by" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_step_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "step_type" DEFAULT 'automated' NOT NULL,
	"parent_step_id" uuid,
	"prev_step_ids" uuid[] DEFAULT '{}',
	"next_step_ids" uuid[] DEFAULT '{}',
	"tool_ids" uuid[] DEFAULT '{}',
	"time_estimate" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"description" text,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"root_workflow_step_template_id" uuid,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_tool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"type" "tool_type" NOT NULL,
	"value" jsonb,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_invited_users" (
	"call_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"invited_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "call_invited_users_call_id_user_id_pk" PRIMARY KEY("call_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "call_participants" (
	"call_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "call_participants_call_id_user_id_pk" PRIMARY KEY("call_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"ended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"room_link" text NOT NULL,
	"call_type" "call_type" DEFAULT 'audio' NOT NULL,
	CONSTRAINT "calls_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "user_workflow_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"workflow_id" uuid NOT NULL,
	"role" "user_workflow_role" DEFAULT 'shared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "direct_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"sent_by_user_id" integer NOT NULL,
	"sent_to_user_id" integer NOT NULL,
	"message_content" jsonb NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "channel_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"last_read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"sent_by_user_id" integer NOT NULL,
	"message_content" jsonb NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	"pinned_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_external_id" text NOT NULL,
	"workspace_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"purpose" text,
	"type" "channel_type" DEFAULT 'public' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "channels_channel_external_id_unique" UNIQUE("channel_external_id")
);
--> statement-breakpoint
CREATE TABLE "thread_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"sender_id" integer NOT NULL,
	"message_content" jsonb NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_message_id" integer NOT NULL,
	"message_type" "message_type" NOT NULL,
	"channel_id" integer,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connector_id" integer NOT NULL,
	"workspace_id" integer NOT NULL,
	"status" "ingestion_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_sync_state" (
	"connector_id" integer NOT NULL,
	"table_name" text NOT NULL,
	"last_pk" text,
	"last_updated_at" bigint,
	"last_lsn" text,
	"rows_synced" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "database_sync_state_connector_id_table_name_unique" UNIQUE("connector_id","table_name")
);
--> statement-breakpoint
CREATE TABLE "thread_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" varchar(255) NOT NULL,
	"item_id" varchar(255) NOT NULL,
	"item_index" integer NOT NULL,
	"item_text" text NOT NULL,
	"summary_text" text,
	"total_items" integer NOT NULL,
	"summary_type" varchar(50) NOT NULL,
	"processing_status" varchar(50) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "thread_summaries_ticket_id_item_id_summary_type_unique" UNIQUE("ticket_id","item_id","summary_type")
);
--> statement-breakpoint
CREATE TABLE "ticket_aggregated_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" varchar(255) NOT NULL,
	"summary_type" varchar(50) NOT NULL,
	"final_summary" text,
	"processing_status" varchar(50) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_aggregated_summaries_ticket_id_summary_type_unique" UNIQUE("ticket_id","summary_type")
);
--> statement-breakpoint
CREATE TABLE "agent_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"chat_id" integer NOT NULL,
	"message_id" integer,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"content" text NOT NULL,
	"reasoning" text,
	"citations" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_documents_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "v2_chat_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_path" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2_chat_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"agent_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint,
	"next_ordinal" integer DEFAULT 0 NOT NULL,
	"idem_key" text NOT NULL,
	"origin_kind" "v2_chat_conversation_origin" DEFAULT 'chat' NOT NULL,
	"starred" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2_chat_message_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"rating" "v2_chat_message_feedback_rating" NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comment" text,
	"share_chat" boolean DEFAULT false NOT NULL,
	"model_snapshot" text,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"retrieved_source_ids" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"run_id" text,
	"role" "v2_chat_message_role" NOT NULL,
	"ordinal" integer NOT NULL,
	"parent_message_id" text,
	"created_at" bigint NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stats" jsonb,
	"idem_key" text
);
--> statement-breakpoint
CREATE TABLE "v2_chat_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"parent_run_id" text,
	"agent_id" text NOT NULL,
	"sub_agent_id" text,
	"model" text NOT NULL,
	"status" "v2_chat_turn_status" NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric,
	"error" text,
	"idem_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2_chat_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"message_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb,
	"result" jsonb,
	"is_error" boolean DEFAULT false NOT NULL,
	"status" "v2_chat_tool_call_status" NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "v2_chat_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"status" "v2_chat_turn_status" NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"error" text,
	"idem_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_agent_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"agent_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"created_by" integer NOT NULL,
	"alias" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."credentials" (
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"cred_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "credentials_workspace_id_name_pk" PRIMARY KEY("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "workflow"."execution_states" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"context" text,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"pause_path" text,
	"pause_type" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"source_execution_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."folders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"metadata" text,
	"parent_id" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."resume_payloads" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"payload" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."static_data" (
	"workflow_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "static_data_workflow_id_key_pk" PRIMARY KEY("workflow_id","key")
);
--> statement-breakpoint
CREATE TABLE "workflow"."step_events" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"step_name" text NOT NULL,
	"type" text NOT NULL,
	"data" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."step_records" (
	"execution_id" text NOT NULL,
	"step_name" text NOT NULL,
	"status" text NOT NULL,
	"executor_type" text NOT NULL,
	"data" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "step_records_execution_id_step_name_pk" PRIMARY KEY("execution_id","step_name")
);
--> statement-breakpoint
CREATE TABLE "workflow"."webhooks" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_callbacks" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'INACTIVE' NOT NULL,
	"config" text,
	"metadata" text,
	"event_type" text DEFAULT '' NOT NULL,
	"summary" text,
	"folder_id" text DEFAULT 'default' NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_providers" ADD CONSTRAINT "oauth_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_providers" ADD CONSTRAINT "oauth_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_providers" ADD CONSTRAINT "oauth_providers_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_history" ADD CONSTRAINT "sync_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_agents" ADD CONSTRAINT "sub_agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_agents" ADD CONSTRAINT "sub_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_permissions" ADD CONSTRAINT "user_agent_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_permissions" ADD CONSTRAINT "user_agent_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdk_resource_permissions" ADD CONSTRAINT "sdk_resource_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_chats" ADD CONSTRAINT "shared_chats_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_chats" ADD CONSTRAINT "shared_chats_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_chats" ADD CONSTRAINT "shared_chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_chats" ADD CONSTRAINT "shared_chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_last_updated_by_id_users_id_fk" FOREIGN KEY ("last_updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_ls_projections" ADD CONSTRAINT "collection_ls_projections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_last_updated_by_id_users_id_fk" FOREIGN KEY ("last_updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docling_async_files" ADD CONSTRAINT "docling_async_files_file_id_collection_items_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."collection_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docling_async_parts" ADD CONSTRAINT "docling_async_parts_file_id_docling_async_files_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."docling_async_files"("file_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_external_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_external_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("external_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_execution" ADD CONSTRAINT "tool_execution_workflow_tool_id_workflow_tool_id_fk" FOREIGN KEY ("workflow_tool_id") REFERENCES "public"."workflow_tool"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution" ADD CONSTRAINT "workflow_execution_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution" ADD CONSTRAINT "workflow_execution_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution" ADD CONSTRAINT "workflow_execution_workflow_template_id_workflow_template_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_execution" ADD CONSTRAINT "workflow_step_execution_workflow_execution_id_workflow_execution_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_execution"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_execution" ADD CONSTRAINT "workflow_step_execution_workflow_step_template_id_workflow_step_template_id_fk" FOREIGN KEY ("workflow_step_template_id") REFERENCES "public"."workflow_step_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_template" ADD CONSTRAINT "workflow_step_template_workflow_template_id_workflow_template_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_template" ADD CONSTRAINT "workflow_template_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_template" ADD CONSTRAINT "workflow_template_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_tool" ADD CONSTRAINT "workflow_tool_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_tool" ADD CONSTRAINT "workflow_tool_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_invited_users" ADD CONSTRAINT "call_invited_users_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_invited_users" ADD CONSTRAINT "call_invited_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workflow_permissions" ADD CONSTRAINT "user_workflow_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workflow_permissions" ADD CONSTRAINT "user_workflow_permissions_workflow_id_workflow_template_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_sent_to_user_id_users_id_fk" FOREIGN KEY ("sent_to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_pinned_by_user_id_users_id_fk" FOREIGN KEY ("pinned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_replies" ADD CONSTRAINT "thread_replies_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_replies" ADD CONSTRAINT "thread_replies_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestions" ADD CONSTRAINT "ingestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_sync_state" ADD CONSTRAINT "database_sync_state_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_attachments" ADD CONSTRAINT "v2_chat_attachments_conversation_id_v2_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."v2_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_attachments" ADD CONSTRAINT "v2_chat_attachments_message_id_v2_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."v2_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_message_feedback" ADD CONSTRAINT "v2_chat_message_feedback_message_id_v2_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."v2_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_message_feedback" ADD CONSTRAINT "v2_chat_message_feedback_conversation_id_v2_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."v2_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_message_feedback" ADD CONSTRAINT "v2_chat_message_feedback_run_id_v2_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."v2_chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_messages" ADD CONSTRAINT "v2_chat_messages_conversation_id_v2_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."v2_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_messages" ADD CONSTRAINT "v2_chat_messages_turn_id_v2_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."v2_chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_messages" ADD CONSTRAINT "v2_chat_messages_run_id_v2_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."v2_chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_messages" ADD CONSTRAINT "v2_chat_messages_parent_message_id_v2_chat_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."v2_chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_runs" ADD CONSTRAINT "v2_chat_runs_conversation_id_v2_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."v2_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_runs" ADD CONSTRAINT "v2_chat_runs_turn_id_v2_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."v2_chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_runs" ADD CONSTRAINT "v2_chat_runs_parent_run_id_v2_chat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."v2_chat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_tool_calls" ADD CONSTRAINT "v2_chat_tool_calls_conversation_id_v2_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."v2_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_tool_calls" ADD CONSTRAINT "v2_chat_tool_calls_turn_id_v2_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."v2_chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_tool_calls" ADD CONSTRAINT "v2_chat_tool_calls_run_id_v2_chat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."v2_chat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_tool_calls" ADD CONSTRAINT "v2_chat_tool_calls_message_id_v2_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."v2_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "v2_chat_turns" ADD CONSTRAINT "v2_chat_turns_conversation_id_v2_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."v2_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_agent_mappings" ADD CONSTRAINT "skill_agent_mappings_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_agent_mappings" ADD CONSTRAINT "skill_agent_mappings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."execution_states" ADD CONSTRAINT "execution_states_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."executions" ADD CONSTRAINT "executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflow"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."executions" ADD CONSTRAINT "executions_source_execution_id_executions_id_fk" FOREIGN KEY ("source_execution_id") REFERENCES "workflow"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."resume_payloads" ADD CONSTRAINT "resume_payloads_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."static_data" ADD CONSTRAINT "static_data_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflow"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."step_events" ADD CONSTRAINT "step_events_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."step_records" ADD CONSTRAINT "step_records_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."webhooks" ADD CONSTRAINT "webhooks_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflow"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_callbacks" ADD CONSTRAINT "workflow_callbacks_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflow"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_unique_index" ON "users" USING btree (LOWER("email"));--> statement-breakpoint
CREATE INDEX "user_personalization_user_idx" ON "user_personalization" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_personalization_email_idx" ON "user_personalization" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_personalization_workspace_idx" ON "user_personalization" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "is_bookmarked_index" ON "chats" USING btree ("is_bookmarked");--> statement-breakpoint
CREATE INDEX "chat_id_index" ON "messages" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chat_trace_workspace_id_index" ON "chat_trace" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "chat_trace_user_id_index" ON "chat_trace" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_trace_chat_external_id_index" ON "chat_trace" USING btree ("chat_external_id");--> statement-breakpoint
CREATE INDEX "chat_trace_message_external_id_index" ON "chat_trace" USING btree ("message_external_id");--> statement-breakpoint
CREATE INDEX "agent_workspace_id_index" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_user_id_index" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_external_id_unique_index" ON "agents" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_default_per_workspace_unique" ON "agents" USING btree ("workspace_id") WHERE "agents"."is_default" = true;--> statement-breakpoint
CREATE INDEX "sub_agents_parent_idx" ON "sub_agents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_agents_name_per_parent_unique" ON "sub_agents" USING btree ("parent_agent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_agent_permission_unique_index" ON "user_agent_permissions" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX "user_agent_permissions_user_id_index" ON "user_agent_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_agent_permissions_agent_id_index" ON "user_agent_permissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "user_agent_permissions_role_index" ON "user_agent_permissions" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "sdk_resource_permission_unique_index" ON "sdk_resource_permissions" USING btree ("user_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "sdk_resource_permissions_resource_index" ON "sdk_resource_permissions" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "sdk_resource_permissions_user_id_index" ON "sdk_resource_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tools_connector_id_idx" ON "tools" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "tools_tool_name_idx" ON "tools" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX "shared_chats_share_token_index" ON "shared_chats" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "shared_chats_chat_id_index" ON "shared_chats" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "shared_chats_message_id_index" ON "shared_chats" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "shared_chats_user_id_index" ON "shared_chats" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shared_chats_deleted_at_index" ON "shared_chats" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_collection_parent_name_not_deleted" ON "collection_items" USING btree ("collection_id","parent_id","name") WHERE "collection_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_items_collection" ON "collection_items" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "idx_items_parent" ON "collection_items" USING btree ("parent_id","position");--> statement-breakpoint
CREATE INDEX "idx_items_collection_type" ON "collection_items" USING btree ("collection_id","type");--> statement-breakpoint
CREATE INDEX "idx_items_path" ON "collection_items" USING btree ("collection_id","path");--> statement-breakpoint
CREATE INDEX "idx_items_deleted_at" ON "collection_items" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_items_vespa_doc_id" ON "collection_items" USING btree ("vespa_doc_id");--> statement-breakpoint
CREATE INDEX "idx_items_storage_key" ON "collection_items" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_collection_items_folder_vespa_metadata_sync_due" ON "collection_items" USING btree ("vespa_metadata_sync_status","vespa_metadata_sync_next_attempt_at","vespa_metadata_sync_started_at") WHERE "collection_items"."type" = 'folder' AND "collection_items"."deleted_at" IS NULL AND "collection_items"."vespa_metadata_sync_status" IN ('pending', 'failed', 'processing');--> statement-breakpoint
CREATE INDEX "idx_collection_ls_projection_built_from_source_updated_at" ON "collection_ls_projections" USING btree ("built_from_source_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_owner_collection_name_not_deleted" ON "collections" USING btree ("owner_id","name") WHERE "collections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_owner_collections" ON "collections" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_collections" ON "collections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_collection_deleted_at" ON "collections" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_collection_privacy" ON "collections" USING btree ("is_private");--> statement-breakpoint
CREATE INDEX "idx_collection_vespa_doc_id" ON "collections" USING btree ("vespa_doc_id");--> statement-breakpoint
CREATE INDEX "idx_collections_vespa_metadata_sync_due" ON "collections" USING btree ("vespa_metadata_sync_status","vespa_metadata_sync_next_attempt_at","vespa_metadata_sync_started_at") WHERE "collections"."deleted_at" IS NULL AND "collections"."vespa_metadata_sync_status" IN ('pending', 'failed', 'processing');--> statement-breakpoint
CREATE INDEX "docling_async_files_status_priority_idx" ON "docling_async_files" USING btree ("status","available_at","base_priority","created_at");--> statement-breakpoint
CREATE INDEX "docling_async_files_status_effective_priority_idx" ON "docling_async_files" USING btree ("status",(COALESCE("priority_override", "base_priority")) DESC,"created_at","file_id");--> statement-breakpoint
CREATE INDEX "docling_async_files_active_status_idx" ON "docling_async_files" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "docling_async_parts_current_job_id_uidx" ON "docling_async_parts" USING btree ("current_job_id") WHERE "docling_async_parts"."current_job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "docling_async_parts_status_available_idx" ON "docling_async_parts" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "docling_async_parts_file_status_idx" ON "docling_async_parts" USING btree ("file_id","status");--> statement-breakpoint
CREATE INDEX "docling_async_parts_file_status_part_idx" ON "docling_async_parts" USING btree ("file_id","status","part_index");--> statement-breakpoint
CREATE INDEX "docling_async_parts_status_file_idx" ON "docling_async_parts" USING btree ("status","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_workflow_permissions_user_workflow_uq" ON "user_workflow_permissions" USING btree ("user_id","workflow_id");--> statement-breakpoint
CREATE INDEX "user_workflow_permissions_workflow_id_index" ON "user_workflow_permissions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "direct_messages_sent_by_idx" ON "direct_messages" USING btree ("sent_by_user_id");--> statement-breakpoint
CREATE INDEX "direct_messages_sent_to_idx" ON "direct_messages" USING btree ("sent_to_user_id");--> statement-breakpoint
CREATE INDEX "direct_messages_conversation_idx" ON "direct_messages" USING btree ("sent_by_user_id","sent_to_user_id");--> statement-breakpoint
CREATE INDEX "direct_messages_created_at_idx" ON "direct_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "channel_members_channel_id_idx" ON "channel_members" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "channel_members_user_id_idx" ON "channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_members_channel_user_unique" ON "channel_members" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "channel_messages_channel_id_idx" ON "channel_messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "channel_messages_sent_by_user_id_idx" ON "channel_messages" USING btree ("sent_by_user_id");--> statement-breakpoint
CREATE INDEX "channel_messages_created_at_idx" ON "channel_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "channel_messages_is_pinned_idx" ON "channel_messages" USING btree ("is_pinned");--> statement-breakpoint
CREATE INDEX "channels_channel_external_id_idx" ON "channels" USING btree ("channel_external_id");--> statement-breakpoint
CREATE INDEX "channels_workspace_id_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "channels_type_idx" ON "channels" USING btree ("type");--> statement-breakpoint
CREATE INDEX "channels_is_archived_idx" ON "channels" USING btree ("is_archived");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_workspace_name_unique" ON "channels" USING btree ("workspace_id",LOWER("name"));--> statement-breakpoint
CREATE INDEX "thread_replies_thread_id_idx" ON "thread_replies" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_replies_sender_id_idx" ON "thread_replies" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "thread_replies_created_at_idx" ON "thread_replies" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "threads_parent_message_type_idx" ON "threads" USING btree ("parent_message_id","message_type");--> statement-breakpoint
CREATE INDEX "threads_channel_id_idx" ON "threads" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "threads_last_reply_at_idx" ON "threads" USING btree ("last_reply_at");--> statement-breakpoint
CREATE INDEX "agent_doc_chat_id_index" ON "agent_documents" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "agent_doc_message_id_index" ON "agent_documents" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_doc_external_id_unique_index" ON "agent_documents" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "agent_doc_agent_id_index" ON "agent_documents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "v2_chat_attachment_conv_created_index" ON "v2_chat_attachments" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_chat_attachment_message_index" ON "v2_chat_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_chat_conv_idem_unique" ON "v2_chat_conversations" USING btree ("idem_key");--> statement-breakpoint
CREATE INDEX "v2_chat_conv_owner_created_index" ON "v2_chat_conversations" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "v2_chat_conv_origin_index" ON "v2_chat_conversations" USING btree ("origin_kind");--> statement-breakpoint
CREATE INDEX "v2_chat_conv_owner_starred_index" ON "v2_chat_conversations" USING btree ("owner_id","starred");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_chat_msg_feedback_user_msg_unique" ON "v2_chat_message_feedback" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "v2_chat_msg_feedback_conv_index" ON "v2_chat_message_feedback" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "v2_chat_msg_feedback_rating_created_index" ON "v2_chat_message_feedback" USING btree ("rating","created_at");--> statement-breakpoint
CREATE INDEX "v2_chat_msg_feedback_workspace_index" ON "v2_chat_message_feedback" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_chat_msg_idem_unique" ON "v2_chat_messages" USING btree ("idem_key");--> statement-breakpoint
CREATE INDEX "v2_chat_msg_conv_ord_index" ON "v2_chat_messages" USING btree ("conversation_id","ordinal");--> statement-breakpoint
CREATE INDEX "v2_chat_msg_turn_index" ON "v2_chat_messages" USING btree ("turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_chat_run_idem_unique" ON "v2_chat_runs" USING btree ("idem_key");--> statement-breakpoint
CREATE INDEX "v2_chat_run_turn_index" ON "v2_chat_runs" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "v2_chat_run_conv_index" ON "v2_chat_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "v2_chat_run_parent_index" ON "v2_chat_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "v2_chat_run_subagent_index" ON "v2_chat_runs" USING btree ("sub_agent_id");--> statement-breakpoint
CREATE INDEX "v2_chat_toolcall_conv_started_index" ON "v2_chat_tool_calls" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "v2_chat_toolcall_run_index" ON "v2_chat_tool_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "v2_chat_toolcall_name_index" ON "v2_chat_tool_calls" USING btree ("tool_name");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_chat_turn_idem_unique" ON "v2_chat_turns" USING btree ("idem_key");--> statement-breakpoint
CREATE INDEX "v2_chat_turn_conv_index" ON "v2_chat_turns" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_agent_unique_index" ON "skill_agent_mappings" USING btree ("skill_id","agent_id");--> statement-breakpoint
CREATE INDEX "skill_agent_skill_id_index" ON "skill_agent_mappings" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_agent_agent_id_index" ON "skill_agent_mappings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "skill_created_by_index" ON "skills" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_alias_unique_index" ON "skills" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "exec_workflow_status_idx" ON "workflow"."executions" USING btree ("workflow_id","status");--> statement-breakpoint
CREATE INDEX "exec_created_at_idx" ON "workflow"."executions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "folders_workspace_idx" ON "workflow"."folders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "step_events_exec_step_created_idx" ON "workflow"."step_events" USING btree ("execution_id","step_name","created_at");--> statement-breakpoint
CREATE INDEX "step_execution_idx" ON "workflow"."step_records" USING btree ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_path_unique" ON "workflow"."webhooks" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_callbacks_secret_unique" ON "workflow"."workflow_callbacks" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "wf_workspace_trigger_status_idx" ON "workflow"."workflows" USING btree ("workspace_id","event_type","status");