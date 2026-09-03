/**
 * Chunk text by paragraphs. `overlap` carries trailing bytes from each chunk
 * into the next so context isn't lost at boundaries.
 */
export const chunkTextByParagraph = (
  text: string,
  maxChunkSize = 512,
  overlap = 128,
): string[] => {
  const getByteLength = (str: string) => Buffer.byteLength(str, "utf8")

  // Strip illegal UTF-8 code points (e.g. 0xF, 0x2) that Vespa rejects on ingest.
  const cleanText = (str: string) => {
    const normalized = str.replace(/\r\n|\r/g, "\n")
    return normalized.replace(
      /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
      "",
    )
  }

  const cleanedText = cleanText(text)
  const paragraphs = cleanedText.split(/\n+/).filter((p) => p.length > 0)

  let chunks: string[] = []
  let currentChunk: string[] = []
  let currentLength = 0

  const addChunk = (chunkArr: string[]) => {
    const chunkStr = chunkArr.join("\n").trim()
    if (!chunkStr || chunkStr.length < 20) return
    chunks.push(chunkStr)

    if (overlap > 0) {
      // Carry trailing paragraphs (by byte budget) into the next chunk.
      let overlapBytes = 0
      let overlapChunk: string[] = []

      for (let i = chunkArr.length - 1; i >= 0; i--) {
        const para = chunkArr[i]
        if (para === undefined) continue
        const paraByteLength = getByteLength(para) + 1 // +1 for newline character
        if (overlapBytes + paraByteLength > overlap) {
          break
        }
        overlapChunk.unshift(para)
        overlapBytes += paraByteLength
      }
      currentChunk = overlapChunk
      currentLength = overlapBytes
    } else {
      currentChunk = []
      currentLength = 0
    }
  }

  for (let paragraph of paragraphs) {
    const paragraphByteLength = getByteLength(paragraph) + 1 // +1 for newline character

    if (paragraphByteLength > maxChunkSize) {
      // Paragraph alone exceeds the budget: flush, then split it by sentence.
      if (currentLength > 0) {
        addChunk(currentChunk)
      }
      let sentences = paragraph.split(/(?<=[.!?])\s+/)
      let subChunk: string[] = []
      let subChunkLength = 0
      for (let sentence of sentences) {
        const sentenceByteLength = getByteLength(sentence) + 1 // +1 for space or newline
        if (subChunkLength + sentenceByteLength > maxChunkSize) {
          addChunk(subChunk)
          subChunk = []
          subChunkLength = 0
        }
        subChunk.push(sentence)
        subChunkLength += sentenceByteLength
      }
      if (subChunk.length > 0) {
        addChunk(subChunk)
      }
    } else if (currentLength + paragraphByteLength > maxChunkSize) {
      addChunk(currentChunk)
      currentChunk = [paragraph]
      currentLength = paragraphByteLength
    } else {
      currentChunk.push(paragraph)
      currentLength += paragraphByteLength
    }
  }

  if (currentChunk.length > 0) {
    addChunk(currentChunk)
  }

  return chunks
}

interface Chunk {
  chunk: string
  chunkIndex: number
}

export const chunkDocument = (body: string): Chunk[] => {
  let out: Chunk[] = []
  let chunks = chunkTextByParagraph(body, 512, 0)
  for (const [index, chunk] of chunks.entries()) {
    out.push({
      chunk,
      chunkIndex: index,
    })
  }
  return out
}
