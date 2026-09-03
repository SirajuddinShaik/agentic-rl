// SEND_EMAIL step — send an email via the deployment Gmail sender.
//
// Credentials are deployment-level (env → GmailService in the ServiceRegistry),
// so this step takes no credentialSlots; it declares requiredServices: ["gmail"]
// and pulls the sender from ctx.services. The transport (Gmail SMTP via an App
// Password) and MIME building live behind GmailService (nodemailer), so this
// step just resolves config + attachment bytes and hands off structured params.
//
// Use the SDK's bundled zod (3.25) via the "zodsdk" alias — the root zod has a
// type-identity mismatch that blows up tsc (see web-search.tool.ts).

import { z } from "zodsdk"
import {
  BaseActionStep,
  StepKind,
  variableRef,
  markAttachmentFields,
  AttachmentSchema,
} from "@xyne/workflow-sdk"
import type { StepExecutionContext } from "@xyne/workflow-sdk"
import type { Attachment } from "@xyne/workflow-sdk/common"
import type { GmailAttachment, GmailService } from "../services/gmail.service"

// ── Config / output schemas ──────────────────────────────────────────────────

// Recipients accept either a single address string or an array — resolved
// {{refs}} can arrive as either shape. Normalized in execute().
const RecipientsSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)),
])

const SendEmailStepConfigSchema = z.object({
  to: variableRef(
    RecipientsSchema.describe("Recipient(s) — a single address or an array."),
  ),
  cc: variableRef(RecipientsSchema).optional(),
  bcc: variableRef(RecipientsSchema).optional(),
  subject: variableRef(z.string().describe("Email subject line.")),
  body: variableRef(z.string().describe("Email body (plain text or HTML).")),
  isHtml: z
    .boolean()
    .default(false)
    .describe("Treat body as HTML instead of plain text."),
  attachments: variableRef(
    z
      .array(AttachmentSchema)
      .describe("Files to attach, e.g. {{ocr_step.attachments}}"),
  ).optional(),
})

type SendEmailStepConfig = z.infer<typeof SendEmailStepConfigSchema>

// Echo the resolved input back in the output so executions are self-documenting
// and downstream steps can reference exactly what was sent.
const SendEmailInputEchoSchema = z.object({
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  isHtml: z.boolean(),
  attachments: z.array(
    z.object({ name: z.string(), mimeType: z.string() }),
  ),
})

const SendEmailStepOutputSchema = z.object({
  messageId: z.string(),
  to: z.array(z.string()),
  // SMTP delivery result from the transport.
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
  response: z.string(),
  input: SendEmailInputEchoSchema,
})

export interface SendEmailInputEcho {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  isHtml: boolean
  attachments: Array<{ name: string; mimeType: string }>
}

export interface SendEmailStepOutput extends Record<string, unknown> {
  messageId: string
  to: string[]
  accepted: string[]
  rejected: string[]
  response: string
  input: SendEmailInputEcho
}

// Normalize a string | string[] recipient field into a trimmed, non-empty list.
const toList = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return []
  const arr = Array.isArray(value) ? value : [value]
  return arr.map((v) => v.trim()).filter(Boolean)
}

// Lowercased domain of an address, tolerating the "Name <addr@domain>" form.
const emailDomain = (addr: string): string => {
  const m = addr.match(/<([^>]+)>/)
  const raw = (m ? m[1]! : addr).trim()
  const at = raw.lastIndexOf("@")
  return at === -1 ? "" : raw.slice(at + 1).toLowerCase()
}

// Comma-separated recipient-domain allowlist. When set, SEND_EMAIL may only
// reach these domains (plus the sender's own); unset keeps sending open so it
// isn't an authenticated open relay from the trusted deployment mailbox.
const allowedRecipientDomains = (): string[] =>
  (process.env["WORKFLOW_EMAIL_ALLOWED_DOMAINS"] ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)

// ── Step ─────────────────────────────────────────────────────────────────────

export class SendEmailStep extends BaseActionStep<
  typeof SendEmailStepConfigSchema,
  SendEmailStepOutput
> {
  override readonly kind = StepKind.ACTION
  override readonly type = "SEND_EMAIL"
  override readonly name = "Send Email"
  override readonly description =
    "Send an email via the configured deployment mailbox (Gmail). Supports HTML bodies and attachments."
  override readonly category = "action" as const
  override readonly icon = "mail"
  override readonly configSchema = SendEmailStepConfigSchema
  override readonly outputSchema = SendEmailStepOutputSchema
  override readonly requiredServices = ["gmail"] as const

  override decorateConfigSchema(
    jsonSchema: Record<string, unknown>,
  ): Record<string, unknown> {
    return markAttachmentFields(jsonSchema, ["attachments"])
  }

  override async execute(
    config: SendEmailStepConfig,
    ctx: StepExecutionContext,
  ): Promise<SendEmailStepOutput> {
    // Report #18: a run started by an UNAUTHENTICATED public trigger (webhook)
    // must not drive the trusted deployment mailbox. The SDK marks such executions
    // on runtime.metadata (server-set, never from attacker-controlled trigger data).
    if (ctx.runtime.metadata["publicTrigger"] === true) {
      throw new Error(
        "SEND_EMAIL: blocked for a publicly-triggered (unauthenticated) workflow run.",
      )
    }

    const gmail = ctx.services.get("gmail") as GmailService

    const to = toList(config.to as string | string[])
    const cc = toList(config.cc as string | string[] | undefined)
    const bcc = toList(config.bcc as string | string[] | undefined)

    if (to.length === 0) {
      throw new Error(
        "SEND_EMAIL: no recipients — set 'to' to an address or a {{ref}} resolving to one.",
      )
    }

    // Recipient-domain guard: every message is sent from the fixed, trusted
    // deployment mailbox, so unrestricted to/cc/bcc is an authenticated open relay
    // (external phishing with a trusted From). Secure by default: recipients are
    // limited to the sender's own domain plus any domains explicitly allowlisted
    // via WORKFLOW_EMAIL_ALLOWED_DOMAINS. With no allowlist configured, only the
    // sender domain is permitted — never an open relay.
    const recipients = [...to, ...cc, ...bcc]
    const senderDomain = emailDomain(gmail.sender)
    const allowed = new Set(
      [...allowedRecipientDomains(), senderDomain].filter(Boolean),
    )
    const blocked = recipients.filter((r) => !allowed.has(emailDomain(r)))
    if (blocked.length > 0) {
      throw new Error(
        `SEND_EMAIL: recipient domain not allowed: ${blocked.join(", ")}. ` +
          `Allowed: ${[...allowed].join(", ")} — add domains via WORKFLOW_EMAIL_ALLOWED_DOMAINS.`,
      )
    }

    // Resolve attachment bytes through the storage adapter (same pattern as OCR).
    const attachmentRefs: Attachment[] = Array.isArray(config.attachments)
      ? (config.attachments as Attachment[])
      : []
    let mailAttachments: GmailAttachment[] | undefined
    if (attachmentRefs.length > 0) {
      if (!ctx.storage) {
        throw new Error(
          "SEND_EMAIL: attachments provided but no storage adapter is configured.",
        )
      }
      mailAttachments = []
      for (const att of attachmentRefs) {
        const bytes = await ctx.storage.read(att)
        mailAttachments.push({
          filename: att.name,
          contentType: att.mimeType || "application/octet-stream",
          content: Buffer.from(bytes),
        })
      }
    }

    ctx.log.info(
      `SEND_EMAIL: sending to ${to.join(", ")}${
        mailAttachments ? ` with ${mailAttachments.length} attachment(s)` : ""
      }`,
    )

    const result = await gmail.sendMail({
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      subject: config.subject as string,
      body: config.body as string,
      isHtml: config.isHtml ?? false,
      ...(mailAttachments ? { attachments: mailAttachments } : {}),
    })

    ctx.log.info(`SEND_EMAIL: sent (messageId ${result.messageId || "?"})`)
    return {
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      response: result.response,
      to,
      input: {
        to,
        cc,
        bcc,
        subject: config.subject as string,
        body: config.body as string,
        isHtml: config.isHtml ?? false,
        attachments: attachmentRefs.map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
        })),
      },
    }
  }
}
