// Deployment-level Gmail sender for workflow steps.
//
// One fixed sender identity, configured via env. Uses Gmail SMTP with an App
// Password (nodemailer) — the simplest battle-tested transport: it needs only
// the mailbox address + a 16-char Google App Password (Google Account →
// Security → 2-Step Verification → App passwords), instead of the full OAuth2
// client/secret/refresh-token flow. nodemailer builds the MIME (HTML +
// attachments) for us.
//
// Built once in runtime.ts and registered in the SDK ServiceRegistry under
// "gmail"; the SEND_EMAIL step pulls it via ctx.services.get("gmail"). Keeping
// the transport behind this interface lets the step be unit-tested with a stub
// (no real SMTP calls).

import nodemailer from "nodemailer"
import type { Transporter } from "nodemailer"

export interface GmailAttachment {
  filename: string
  content: Buffer
  contentType: string
}

export interface GmailSendParams {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  /** Treat body as HTML instead of plain text. */
  isHtml: boolean
  attachments?: GmailAttachment[]
}

/** What we surface from nodemailer's SMTP send response. */
export interface GmailSendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
  response: string
}

export interface GmailService {
  /** The fixed sender address (From:) for every message. */
  readonly sender: string
  /** Build + send a message via Gmail SMTP. */
  sendMail(params: GmailSendParams): Promise<GmailSendResult>
}

export interface GmailServiceConfig {
  /** The Gmail/Workspace mailbox address — also the From: address. */
  user: string
  /** A Google App Password for that mailbox (NOT the account password). */
  appPassword: string
}

/**
 * Build a Gmail service backed by an SMTP transport authenticated with an App
 * Password. The transport is created once and reused (connection pooling is
 * handled by nodemailer).
 */
export function createGmailService(cfg: GmailServiceConfig): GmailService {
  const transport: Transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: cfg.user, pass: cfg.appPassword },
  })

  return {
    sender: cfg.user,
    async sendMail(params: GmailSendParams): Promise<GmailSendResult> {
      const info = await transport.sendMail({
        from: cfg.user,
        to: params.to,
        ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
        ...(params.bcc && params.bcc.length > 0 ? { bcc: params.bcc } : {}),
        subject: params.subject,
        ...(params.isHtml ? { html: params.body } : { text: params.body }),
        ...(params.attachments && params.attachments.length > 0
          ? { attachments: params.attachments }
          : {}),
      })
      return {
        messageId: info.messageId ?? "",
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        response: info.response ?? "",
      }
    },
  }
}
