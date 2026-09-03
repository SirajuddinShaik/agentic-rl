import { chunkDocument } from "@/ingestion/chunking/chunks"
import type { ChunkMetadata } from "@/types"

const TEXT_VIRTUAL_PAGE_MAX_CHARS =
  Number.parseInt(process.env.TEXT_VIRTUAL_PAGE_MAX_CHARS || "", 10) || 4000
const TEXT_VIRTUAL_PAGE_MAX_WORDS =
  Number.parseInt(process.env.TEXT_VIRTUAL_PAGE_MAX_WORDS || "", 10) || 800
const TEXT_VIRTUAL_PAGE_MAX_LINES =
  Number.parseInt(process.env.TEXT_VIRTUAL_PAGE_MAX_LINES || "", 10) || 80

export type TextProcessingResult = {
  chunks: string[]
  chunks_pos: number[]
  chunks_map: ChunkMetadata[]
}

const countWords = (value: string): number => {
  const matches = value.trim().match(/\S+/g)
  return matches?.length || 0
}

const splitLongTextLine = (line: string): string[] => {
  if (line.length <= TEXT_VIRTUAL_PAGE_MAX_CHARS) return [line]
  const pieces: string[] = []
  for (let start = 0; start < line.length; start += TEXT_VIRTUAL_PAGE_MAX_CHARS) {
    pieces.push(line.slice(start, start + TEXT_VIRTUAL_PAGE_MAX_CHARS))
  }
  return pieces
}

export const virtualTextPages = (content: string): string[] => {
  const pages: string[] = []
  let pageLines: string[] = []
  let pageChars = 0
  let pageWords = 0

  const flush = (): void => {
    const page = pageLines.join("\n").trim()
    if (page) pages.push(page)
    pageLines = []
    pageChars = 0
    pageWords = 0
  }

  for (const rawLine of content.replace(/\r\n|\r/g, "\n").split("\n")) {
    for (const line of splitLongTextLine(rawLine)) {
      const lineChars = line.length + 1
      const lineWords = countWords(line)
      const wouldOverflow =
        pageLines.length > 0 &&
        (pageChars + lineChars > TEXT_VIRTUAL_PAGE_MAX_CHARS ||
          pageWords + lineWords > TEXT_VIRTUAL_PAGE_MAX_WORDS ||
          pageLines.length + 1 > TEXT_VIRTUAL_PAGE_MAX_LINES)
      if (wouldOverflow) flush()
      pageLines.push(line)
      pageChars += lineChars
      pageWords += lineWords
    }
  }
  flush()
  return pages
}

export const processTextPageContent = (
  content: string,
  pageNumber: number,
): TextProcessingResult => {
  const pageChunks = chunkDocument(content)
  const chunks = pageChunks.map((c) => c.chunk)
  const chunks_map: ChunkMetadata[] = pageChunks.map((_, index) => ({
    chunk_index: index,
    page_numbers: [pageNumber],
    block_labels: ["text"],
  }))

  return {
    chunks,
    chunks_pos: chunks.map((_, index) => index),
    chunks_map,
  }
}

export const processTextContentWithVirtualPages = (
  content: string,
  options: {
    pageNumberBase?: number
    trim?: boolean
  } = {},
): TextProcessingResult => {
  const source = options.trim === false ? content : content.trim()
  // Keep indexed metadata zero-based, matching PDF.js and Docling. Convert to
  // user-facing one-based numbers only at API/tool presentation boundaries.
  const pageNumberBase = options.pageNumberBase ?? 0
  const chunks: string[] = []
  const chunks_map: ChunkMetadata[] = []

  for (const [pageIndex, page] of virtualTextPages(source).entries()) {
    const pageResult = processTextPageContent(
      page,
      pageNumberBase + pageIndex,
    )
    const chunkOffset = chunks.length
    chunks.push(...pageResult.chunks)
    chunks_map.push(
      ...pageResult.chunks_map.map((meta, index) => ({
        ...meta,
        chunk_index: chunkOffset + index,
      })),
    )
  }

  return {
    chunks,
    chunks_pos: chunks.map((_, index) => index),
    chunks_map,
  }
}
