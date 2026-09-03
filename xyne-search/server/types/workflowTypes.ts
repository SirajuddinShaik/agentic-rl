export const WorkflowStatus = {
  DRAFT: "draft",
  ACTIVE: "active",
  PROCESSING: "processing",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
} as const
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus]

export const StepType = {
  MANUAL: "manual",
  AUTOMATED: "automated",
} as const
export type StepType = (typeof StepType)[keyof typeof StepType]

export const ToolType = {
  DELAY: "delay",
  SLACK: "slack",
  GMAIL: "gmail",
  AGENT: "agent",
  MERGED_NODE: "merged_node",
  FORM: "form",
  EMAIL: "email",
  AI_AGENT: "ai_agent",
  QNA_AGENT: "qna_agent",
  WEBHOOK: "webhook",
  HTTP_REQUEST: "http_request",
  JIRA: "jira",
} as const
export type ToolType = (typeof ToolType)[keyof typeof ToolType]

export const ToolExecutionStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const
export type ToolExecutionStatus =
  (typeof ToolExecutionStatus)[keyof typeof ToolExecutionStatus]
