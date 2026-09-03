import { randomUUID } from "crypto"
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
import { PdfProcessor } from "@/platform/common/pdf/pdfProcessor"

const OcrDocumentStepConfigSchema = z.object({
  attachments: variableRef(
    z.array(AttachmentSchema).describe(
      "Document(s) to OCR. Bind to an attachment ref, e.g. {{trigger.attachments}}",
    ),
  ),
})

type OcrDocumentStepConfig = z.infer<typeof OcrDocumentStepConfigSchema>

const OcrDocumentStepOutputSchema = z.object({
  results: z.array(
    z.object({
      // The document this text came from, carried beside the data it produced.
      // Downstream citations resolve their source document by walking up to the
      // nearest attachment in the same output — so provenance is a lookup, never
      // a guess. Emitting only `name` would leave nothing openable.
      source: AttachmentSchema,
      name: z.string(),
      // Text is only ever exposed per page. A flat whole-document field would be
      // a byte-for-byte duplicate of these joined, doubling the persisted output,
      // and — since the inline "[Page N]" labels are stripped below — it would
      // carry no page information at all. Anything reading it could name a value's
      // page only by guessing, which is exactly what citations must not do.
      pages: z.array(
        z.object({
          page: z.number(),
          text: z.string(),
        }),
      ),
    }),
  ),
})

export interface OcrDocumentPage {
  page: number
  text: string
}

export interface OcrDocumentResult {
  /** The document this text was extracted from — the citation target. */
  source: Attachment
  name: string
  /** Extracted text, per page. The only form the text is exposed in. */
  pages: OcrDocumentPage[]
}

export interface OcrDocumentStepOutput extends Record<string, unknown> {
  results: OcrDocumentResult[]
}

export class OcrDocumentStep extends BaseActionStep<
  typeof OcrDocumentStepConfigSchema,
  OcrDocumentStepOutput
> {
  override readonly kind = StepKind.ACTION
  override readonly type = "OCR_DOCUMENT"
  override readonly name = "OCR Document"
  override readonly description =
    "Extract text from one or more uploaded documents using the full OCR pipeline (Docling → Gemini → PDF.js fallback)."
  override readonly category = "action" as const
  override readonly configSchema = OcrDocumentStepConfigSchema
  override readonly outputSchema = OcrDocumentStepOutputSchema
  override decorateConfigSchema(
    jsonSchema: Record<string, unknown>,
  ): Record<string, unknown> {
    return markAttachmentFields(jsonSchema, ["attachments"])
  }

  override async execute(
    config: OcrDocumentStepConfig,
    ctx: StepExecutionContext,
  ): Promise<OcrDocumentStepOutput> {
    if (!ctx.storage) {
      throw new Error("OCR_DOCUMENT step requires a storage adapter")
    }

    const items: Attachment[] = Array.isArray(config.attachments)
      ? config.attachments
      : []

    if (items.length === 0) {
      throw new Error(
        "OCR_DOCUMENT: no attachments bound — set 'attachments' to an attachment ref like {{trigger.attachments}}",
      )
    }

    ctx.log.info(`OCR_DOCUMENT: processing ${items.length} attachment(s)`)

    const results: OcrDocumentResult[] = []

    for (const attachment of items) {
      ctx.log.info(`OCR_DOCUMENT: reading "${attachment.name}"`)
      const bytes = await ctx.storage.read(attachment)
      const buffer = Buffer.from(bytes)

      const vespaDocId = `ocr-wf-${randomUUID()}`
      const processingResult = await PdfProcessor.processWithFallback(
        buffer,
        attachment.name,
        vespaDocId,
        false,
        false,
        true,
        false,
      )

      // PDF.js prepends an inline "[Page N]" / "[Page N-M]" label to each chunk;
      // strip it since page numbers are surfaced structurally in `pages[]`.
      const stripPageLabel = (s: string) =>
        (s ?? "").replace(/\[Page\s+[\d\s-]+\]\s*/gi, "").trim()

      // Page provenance comes from chunk metadata (Docling and PDF.js both
      // emit 0-based page_numbers; +1 for human numbering). Chunks without
      // page info (Gemini fallback, single images) land on page 1.
      const byPage = new Map<number, string[]>()
      const collect = (
        chunks: string[],
        map: { page_numbers?: number[] }[],
      ) => {
        chunks.forEach((chunk, i) => {
          const trimmed = stripPageLabel(chunk)
          if (!trimmed) return
          const page = (map[i]?.page_numbers?.[0] ?? 0) + 1
          const bucket = byPage.get(page)
          if (bucket) bucket.push(trimmed)
          else byPage.set(page, [trimmed])
        })
      }
      collect(processingResult.chunks, processingResult.chunks_map)
      collect(processingResult.image_chunks, processingResult.image_chunks_map)
      const pages = [...byPage.entries()]
        .sort(([a], [b]) => a - b)
        .map(([page, texts]) => ({ page, text: texts.join("\n\n") }))

      if (pages.length === 0) {
        throw new Error(`OCR_DOCUMENT: no text extracted from "${attachment.name}"`)
      }

      const chars = pages.reduce((n, p) => n + p.text.length, 0)
      ctx.log.info(
        `OCR_DOCUMENT: extracted ${chars} chars across ${pages.length} page(s) from "${attachment.name}" via ${processingResult.processingMethod ?? "unknown"}`,
      )
      results.push({ source: attachment, name: attachment.name, pages })
    }

    return { results }
  }
}
