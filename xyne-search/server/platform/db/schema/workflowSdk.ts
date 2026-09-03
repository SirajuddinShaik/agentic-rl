// DB schema for @xyne/workflow-sdk persistence layer.
// Tables live in the `workflow` postgres schema to keep them isolated from
// the main public schema. IDs are text (cuid2/nanoid), timestamps are bigint ms.
// workspace_id is denormalised externalId for tenant isolation — no FK to workspaces.

import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

export const workflowSchema = pgSchema("workflow")

// ─── Folders (nested via parent_id) ──────────────────────────────────────────

export const sdkFolders = workflowSchema.table(
  "folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),          // for tenant scoping
    name: text("name").notNull(),
    metadata: text("metadata"),                           // JSON: host metadata
    parentId: text("parent_id"),                          // null = top-level folder
    isPublic: boolean("is_public").notNull().default(false), // workspace-wide visibility
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    workspaceIdx: index("folders_workspace_idx").on(t.workspaceId),
  }),
)

// ─── Workflows ───────────────────────────────────────────────────────────────

export const sdkWorkflows = workflowSchema.table(
  "workflows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    status: text("status").notNull().default("INACTIVE"), // ACTIVE | INACTIVE
    config: text("config"),                               // JSON: WorkflowConfig
    metadata: text("metadata"),                           // JSON: { name, description, ... }
    eventType: text("event_type").notNull().default(""),  // trigger type for event routing
    summary: text("summary"),                             // human-facing readme/summary
    folderId: text("folder_id").notNull().default("default"), // soft ref to sdkFolders.id
    isPublic: boolean("is_public").notNull().default(false), // workspace-wide visibility
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    workspaceTriggerStatusIdx: index("wf_workspace_trigger_status_idx").on(
      t.workspaceId,
      t.eventType,
      t.status,
    ),
  }),
)

// ─── Executions ──────────────────────────────────────────────────────────────

export const sdkExecutions = workflowSchema.table(
  "executions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => sdkWorkflows.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("PENDING"),
    sourceExecutionId: text("source_execution_id").references(
      (): AnyPgColumn => sdkExecutions.id,
    ),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    workflowStatusIdx: index("exec_workflow_status_idx").on(
      t.workflowId,
      t.status,
    ),
    createdAtIdx: index("exec_created_at_idx").on(t.createdAt),
  }),
)

// ─── Execution state (one row per execution, upserted by engine) ─────────────

export const sdkExecutionStates = workflowSchema.table("execution_states", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => sdkExecutions.id, { onDelete: "cascade" }),
  context: text("context"),
  currentStepIndex: integer("current_step_index").notNull().default(0),
  pausePath: text("pause_path"),
  pauseType: text("pause_type"),
  updatedAt: bigint("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
})

// ─── Step records (one row per step per execution, upserted) ─────────────────

export const sdkStepRecords = workflowSchema.table(
  "step_records",
  {
    executionId: text("execution_id")
      .notNull()
      .references(() => sdkExecutions.id, { onDelete: "cascade" }),
    stepName: text("step_name").notNull(),
    status: text("status").notNull(),
    executorType: text("executor_type").notNull(),
    data: text("data"),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.executionId, t.stepName] }),
    executionIdx: index("step_execution_idx").on(t.executionId),
  }),
)

// ─── Step events (append-only SSE event log) ─────────────────────────────────

export const sdkStepEvents = workflowSchema.table(
  "step_events",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => sdkExecutions.id, { onDelete: "cascade" }),
    stepName: text("step_name").notNull(),
    type: text("type").notNull(),
    data: text("data").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    executionStepCreatedIdx: index("step_events_exec_step_created_idx").on(
      t.executionId,
      t.stepName,
      t.createdAt,
    ),
  }),
)

// ─── Static data (persistent KV per workflow definition) ─────────────────────

export const sdkStaticData = workflowSchema.table(
  "static_data",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => sdkWorkflows.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value"),
    updatedAt: bigint("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workflowId, t.key] }),
  }),
)

// ─── Credentials (tenant-scoped secrets) ─────────────────────────────────────

export const sdkCredentials = workflowSchema.table(
  "credentials",
  {
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    credType: text("cred_type").notNull(),
    data: jsonb("data").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.name] }),
  }),
)

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export const sdkWebhooks = workflowSchema.table(
  "webhooks",
  {
    workflowId: text("workflow_id")
      .primaryKey()
      .references(() => sdkWorkflows.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    secret: text("secret").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    pathUnique: uniqueIndex("webhooks_path_unique").on(t.path),
  }),
)

// ─── Resume payloads (pause-resume inbox, read-then-delete) ──────────────────

export const sdkResumePayloads = workflowSchema.table("resume_payloads", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => sdkExecutions.id, { onDelete: "cascade" }),
  payload: text("payload").notNull(),
  createdAt: bigint("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
})

// ─── Workflow callbacks (wait-webhook secrets) ────────────────────────────────

export const sdkWorkflowCallbacks = workflowSchema.table(
  "workflow_callbacks",
  {
    workflowId: text("workflow_id")
      .primaryKey()
      .references(() => sdkWorkflows.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    secretUnique: uniqueIndex("workflow_callbacks_secret_unique").on(t.secret),
  }),
)
