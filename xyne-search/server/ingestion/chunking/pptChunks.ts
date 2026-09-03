import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import JSZip from "jszip"
import { XMLParser } from "fast-xml-parser"
import { promises as fsPromises } from "fs"
import crypto from "crypto"
import path from "path"
import {
  DeferredImageDescriptionBatch,
  md5ImageBuffer,
} from "@/platform/lib/deferredImageDescription"
import { DATASOURCE_CONFIG } from "@/integrations/dataSource/config"
import { chunkTextByParagraph } from "./chunks"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "pptChunks",
})

// Clean text consistently with PDF and DOCX processing.
const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

interface PptxContentItem {
  type: "text" | "image" | "title" | "table" | "notes"
  content?: string
  relId?: string
  pos: number
  slideNumber: number
}

interface PptxProcessingResult {
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}

// Extract text from PowerPoint text elements.
function extractTextFromTextElements(element: any): string {
  if (!element) return ""

  // Prefer paragraph-aware extraction; fall back to recursive for non-standard structures.
  const paragraphText = extractTextFromParagraphs(element)
  if (paragraphText) return paragraphText

  return extractTextRecursively(element)
}

// Extract text with paragraph and line-break handling. Based on node-pptx-parser's approach.
function extractTextFromParagraphs(element: any): string {
  const paragraphs: string[] = []

  const searchForTextBodies = (obj: any): any[] => {
    const textBodies: any[] = []
    if (!obj || typeof obj !== "object") return textBodies

    if (obj["p:txBody"] || obj["a:txBody"]) {
      const txBodies = obj["p:txBody"] || obj["a:txBody"]
      const bodiesArray = Array.isArray(txBodies) ? txBodies : [txBodies]
      textBodies.push(...bodiesArray)
    }

    for (const key in obj) {
      if (typeof obj[key] === "object") {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            textBodies.push(...searchForTextBodies(item))
          }
        } else {
          textBodies.push(...searchForTextBodies(obj[key]))
        }
      }
    }

    return textBodies
  }

  const textBodies = searchForTextBodies(element)

  for (const textBody of textBodies) {
    if (textBody["a:p"]) {
      const paragraphElements = Array.isArray(textBody["a:p"])
        ? textBody["a:p"]
        : [textBody["a:p"]]

      for (const paragraph of paragraphElements) {
        const paragraphText = extractTextFromSingleParagraph(paragraph)
        if (paragraphText.trim()) {
          paragraphs.push(paragraphText)
        }
      }
    }
  }

  return paragraphs.length > 0 ? paragraphs.join("\n") : ""
}

// Extract text from a single paragraph, handling runs and line breaks.
function extractTextFromSingleParagraph(paragraph: any): string {
  if (!paragraph) return ""

  const textParts: string[] = []

  // Text runs (a:r elements)
  if (paragraph["a:r"]) {
    const runs = Array.isArray(paragraph["a:r"])
      ? paragraph["a:r"]
      : [paragraph["a:r"]]

    for (const run of runs) {
      if (run["a:t"]) {
        let textContent = ""
        if (typeof run["a:t"] === "string") {
          textContent = run["a:t"]
        } else if (Array.isArray(run["a:t"])) {
          textContent = run["a:t"].join("")
        } else if (run["a:t"]["#text"]) {
          textContent = run["a:t"]["#text"]
        } else if (typeof run["a:t"] === "object") {
          textContent = String(run["a:t"])
        }

        if (textContent) {
          textParts.push(textContent)
        }
      }
    }
  }

  // Explicit line breaks (a:br elements)
  if (paragraph["a:br"]) {
    textParts.push("\n")
  }

  // a:endParaRPr with no runs marks an empty paragraph -> emit a line break.
  if (paragraph["a:endParaRPr"]) {
    if (textParts.length === 0) {
      textParts.push("\n")
    }
  }

  // Fallback: direct text content on the paragraph.
  if (textParts.length === 0 && paragraph["a:t"]) {
    let textContent = ""
    if (typeof paragraph["a:t"] === "string") {
      textContent = paragraph["a:t"]
    } else if (paragraph["a:t"]["#text"]) {
      textContent = paragraph["a:t"]["#text"]
    }
    if (textContent) {
      textParts.push(textContent)
    }
  }

  return textParts.join("")
}

// Fallback recursive text extraction for non-standard structures.
function extractTextRecursively(element: any): string {
  const searchForText = (obj: any): string[] => {
    const textElements: string[] = []
    if (!obj || typeof obj !== "object") return textElements

    if (obj["a:t"]) {
      const textContent = obj["a:t"]
      if (typeof textContent === "string") {
        textElements.push(textContent)
      } else if (Array.isArray(textContent)) {
        textElements.push(...textContent.map(String))
      } else if (textContent["#text"]) {
        textElements.push(textContent["#text"])
      }
    }

    for (const key in obj) {
      if (typeof obj[key] === "object") {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            textElements.push(...searchForText(item))
          }
        } else {
          textElements.push(...searchForText(obj[key]))
        }
      }
    }

    return textElements
  }

  const textElements = searchForText(element)
  return textElements.join(" ")
}

// Extract slide title from title placeholders.
function extractSlideTitle(slideData: any): string {
  if (!slideData?.["p:sld"]?.["p:cSld"]?.["p:spTree"]) return ""

  const spTree = slideData["p:sld"]["p:cSld"]["p:spTree"]
  const shapes = []

  if (spTree["p:sp"]) {
    const textShapes = Array.isArray(spTree["p:sp"])
      ? spTree["p:sp"]
      : [spTree["p:sp"]]
    shapes.push(...textShapes)
  }

  for (const shape of shapes) {
    if (!shape) continue

    const nvSpPr = shape["p:nvSpPr"]
    const ph = nvSpPr?.["p:nvPr"]?.["p:ph"]

    if (ph && (ph["@_type"] === "title" || ph["@_type"] === "ctrTitle")) {
      const titleText = extractTextFromTextElements(shape)
      if (titleText.trim()) {
        return titleText.trim()
      }
    }
  }

  return ""
}

// Extract table content from PowerPoint table elements.
function extractTableContent(element: any): string {
  if (!element || !element["a:tbl"]) return ""

  const table = element["a:tbl"]
  const rows: string[] = []

  const tableRows = table["a:tr"] || []
  const rowsArray = Array.isArray(tableRows) ? tableRows : [tableRows]

  for (const row of rowsArray) {
    if (!row) continue

    const cells: string[] = []
    const tableCells = row["a:tc"] || []
    const cellsArray = Array.isArray(tableCells) ? tableCells : [tableCells]

    for (const cell of cellsArray) {
      if (!cell) continue
      const cellText = extractTextFromTextElements(cell)
      cells.push(cellText.trim() || "")
    }

    if (cells.some((cell) => cell.length > 0)) {
      rows.push(cells.join(" | "))
    }
  }

  return rows.length > 0 ? `\n**Table:**\n${rows.join("\n")}\n` : ""
}

// Extract basic text elements (title, axis labels) from charts.
function extractChartContent(element: any): string {
  if (!element) return ""

  const chartTexts: string[] = []

  const searchForChartText = (obj: any): void => {
    if (!obj || typeof obj !== "object") return

    if (obj["c:tx"] || obj["c:rich"] || obj["c:strRef"]) {
      const textContent = extractTextFromTextElements(obj)
      if (textContent.trim()) {
        chartTexts.push(textContent.trim())
      }
    }

    for (const key in obj) {
      if (typeof obj[key] === "object") {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            searchForChartText(item)
          }
        } else {
          searchForChartText(obj[key])
        }
      }
    }
  }

  searchForChartText(element)

  return chartTexts.length > 0 ? `\n**Chart:** ${chartTexts.join(", ")}\n` : ""
}

// Extract image relationship IDs from slide elements (<a:blip r:embed="rIdX">).
function extractImageRelIds(element: any): string[] {
  const relIds: string[] = []
  if (!element) return relIds

  const searchForImages = (obj: any): string[] => {
    const imageRels: string[] = []
    if (!obj || typeof obj !== "object") return imageRels

    if (obj["a:blip"]) {
      const blip = obj["a:blip"]
      if (blip["@_r:embed"]) {
        imageRels.push(blip["@_r:embed"])
      } else if (blip["r:embed"]) {
        imageRels.push(blip["r:embed"])
      }
    }

    if (obj["pic:blipFill"]) {
      const blipFill = obj["pic:blipFill"]
      const result = searchForImages(blipFill)
      imageRels.push(...result)
    }

    for (const key in obj) {
      if (typeof obj[key] === "object") {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            imageRels.push(...searchForImages(item))
          }
        } else {
          imageRels.push(...searchForImages(obj[key]))
        }
      }
    }

    return imageRels
  }

  return searchForImages(element)
}

// Extract speaker notes from the notes slide.
async function extractSpeakerNotes(
  zip: JSZip,
  parser: XMLParser,
  slideNumber: number,
): Promise<string> {
  try {
    const notesFile = `ppt/notesSlides/notesSlide${slideNumber}.xml`
    const notesXml = await zip.file(notesFile)?.async("text")

    if (!notesXml) return ""

    const notesData = parser.parse(notesXml)

    if (!notesData?.["p:notes"]?.["p:cSld"]?.["p:spTree"]) return ""

    const spTree = notesData["p:notes"]["p:cSld"]["p:spTree"]
    const shapes = []

    if (spTree["p:sp"]) {
      const textShapes = Array.isArray(spTree["p:sp"])
        ? spTree["p:sp"]
        : [spTree["p:sp"]]
      shapes.push(...textShapes)
    }

    const notesTexts: string[] = []

    for (const shape of shapes) {
      if (!shape) continue

      const nvSpPr = shape["p:nvSpPr"]
      const ph = nvSpPr?.["p:nvPr"]?.["p:ph"]

      // Keep body/notes placeholders; skip the slide-thumbnail placeholder.
      if (
        ph &&
        (ph["@_type"] === "body" || ph["@_type"] === "obj" || !ph["@_type"])
      ) {
        const notesText = extractTextFromTextElements(shape)
        if (notesText.trim()) {
          notesTexts.push(notesText.trim())
        }
      }
    }

    return notesTexts.length > 0 ? notesTexts.join("\n") : ""
  } catch (error) {
    Logger.debug(
      `Could not extract speaker notes for slide ${slideNumber}: ${error instanceof Error ? error.message : error}`,
    )
    return ""
  }
}

// Parse the slide relationships file, mapping relationship IDs to image paths.
function parseSlideRelationships(relsData: any): Map<string, string> {
  const relationships = new Map<string, string>()

  if (!relsData?.Relationships?.Relationship) {
    return relationships
  }

  const rels = relsData.Relationships.Relationship
  const relsArray = Array.isArray(rels) ? rels : [rels]

  for (const rel of relsArray) {
    if (rel["@_Id"] && rel["@_Target"]) {
      // Targets are relative to ppt/slides; strip the leading ../ to anchor at ppt/.
      let target = rel["@_Target"]
      if (target.startsWith("../")) {
        target = target.substring(3)
      }
      relationships.set(rel["@_Id"], target)
    }
  }

  return relationships
}

// Extract text/image content items from a slide, in document order.
function processSlideContent(
  slideData: any,
  slideNumber: number,
): PptxContentItem[] {
  const items: PptxContentItem[] = []
  let globalSeq = 0

  if (!slideData?.["p:sld"]?.["p:cSld"]?.["p:spTree"]) {
    Logger.warn(`No slide content found in slide ${slideNumber}`)
    return items
  }

  const slideTitle = extractSlideTitle(slideData)
  if (slideTitle) {
    items.push({
      type: "title",
      content: `## ${slideTitle}`,
      pos: globalSeq++,
      slideNumber: slideNumber,
    })
  }

  const spTree = slideData["p:sld"]["p:cSld"]["p:spTree"]

  const shapes = []

  if (spTree["p:sp"]) {
    const textShapes = Array.isArray(spTree["p:sp"])
      ? spTree["p:sp"]
      : [spTree["p:sp"]]
    shapes.push(...textShapes)
  }

  if (spTree["p:pic"]) {
    const pictures = Array.isArray(spTree["p:pic"])
      ? spTree["p:pic"]
      : [spTree["p:pic"]]
    shapes.push(...pictures)
  }

  if (spTree["p:grpSp"]) {
    const groupShapes = Array.isArray(spTree["p:grpSp"])
      ? spTree["p:grpSp"]
      : [spTree["p:grpSp"]]
    for (const grpSp of groupShapes) {
      // Flatten shapes nested within groups.
      if (grpSp["p:sp"]) {
        const groupTextShapes = Array.isArray(grpSp["p:sp"])
          ? grpSp["p:sp"]
          : [grpSp["p:sp"]]
        shapes.push(...groupTextShapes)
      }
      if (grpSp["p:pic"]) {
        const groupPictures = Array.isArray(grpSp["p:pic"])
          ? grpSp["p:pic"]
          : [grpSp["p:pic"]]
        shapes.push(...groupPictures)
      }
    }
  }

  // Graphic frames hold tables and charts.
  if (spTree["p:graphicFrame"]) {
    const graphicFrames = Array.isArray(spTree["p:graphicFrame"])
      ? spTree["p:graphicFrame"]
      : [spTree["p:graphicFrame"]]
    shapes.push(...graphicFrames)
  }

  Logger.debug(`Found ${shapes.length} shapes in slide ${slideNumber}`)

  for (const shape of shapes) {
    if (!shape) continue

    const tableContent = extractTableContent(shape)
    if (tableContent) {
      items.push({
        type: "table",
        content: cleanText(tableContent),
        pos: globalSeq++,
        slideNumber: slideNumber,
      })
    }

    const chartContent = extractChartContent(shape)
    if (chartContent) {
      items.push({
        type: "text",
        content: cleanText(chartContent),
        pos: globalSeq++,
        slideNumber: slideNumber,
      })
    }

    const imageRelIds = extractImageRelIds(shape)
    for (const relId of imageRelIds) {
      Logger.debug(
        `Found image with relationship ID: ${relId} in slide ${slideNumber}`,
      )
      items.push({
        type: "image",
        relId: relId,
        pos: globalSeq++,
        slideNumber: slideNumber,
      })
    }

    // Title is already emitted above; skip it here to avoid duplication.
    const nvSpPr = shape["p:nvSpPr"]
    const ph = nvSpPr?.["p:nvPr"]?.["p:ph"]
    const isTitle =
      ph && (ph["@_type"] === "title" || ph["@_type"] === "ctrTitle")

    if (!isTitle && !tableContent && !chartContent) {
      const textContent = extractTextFromTextElements(shape)
      if (textContent.trim()) {
        items.push({
          type: "text",
          content: cleanText(textContent),
          pos: globalSeq++,
          slideNumber: slideNumber,
        })
      }
    }
  }

  Logger.debug(
    `Processed ${items.length} content items from slide ${slideNumber}`,
  )
  return items
}

// Chunk text items into results. Returns trailing overlap text to keep continuity across images.
function processTextItems(
  textItems: string[],
  text_chunks: string[],
  text_chunk_pos: number[],
  startPos: number,
  overlapBytes: number = 32,
): { nextPos: number; overlapText: string } {
  if (textItems.length === 0) return { nextPos: startPos, overlapText: "" }

  const cleanedText = textItems.join("\n")
  const chunks = chunkTextByParagraph(cleanedText, 512, 128)

  let currentPos = startPos
  for (const chunk of chunks) {
    text_chunks.push(chunk)
    text_chunk_pos.push(currentPos++)
  }

  // Overlap = last ~overlapBytes of text, snapped to word boundaries.
  let overlapText = ""
  if (cleanedText.trim()) {
    const words = cleanedText.trim().split(/\s+/)
    let overlapLen = 0

    for (let i = words.length - 1; i >= 0; i--) {
      const word = words[i]
      const wordBytes = Buffer.byteLength(word + " ", "utf8")

      if (overlapLen + wordBytes > overlapBytes && overlapText) break

      overlapText = word + (overlapText ? " " + overlapText : "")
      overlapLen += wordBytes
    }
  }

  return { nextPos: currentPos, overlapText }
}

export async function extractTextAndImagesWithChunksFromPptx(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = false,
  describeImages: boolean = true,
): Promise<PptxProcessingResult> {
  Logger.info(`Starting PPTX processing for document: ${docid}`)
  let totalTextLength = 0
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected PPTX, skipping")
    } else {
      Logger.error(error, `PPTX load error: ${error}`)
    }
    return {
      text_chunks: [],
      image_chunks: [],
      text_chunk_pos: [],
      image_chunk_pos: [],
    }
  }

  let imageDescribeBatch: DeferredImageDescriptionBatch | undefined
  let extractionSucceeded = false
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
    })

    let text_chunks: string[] = []
    let image_chunks: string[] = []
    let text_chunk_pos: number[] = []
    let image_chunk_pos: number[] = []

    let globalSeq = 0
    let crossImageOverlap = ""

    const imageSeqToHash = new Map<number, string>()
    imageDescribeBatch = new DeferredImageDescriptionBatch()

    const slideFiles = Object.keys(zip.files).filter(
      (filename) =>
        filename.startsWith("ppt/slides/slide") && filename.endsWith(".xml"),
    )

    Logger.info(`Found ${slideFiles.length} slides to process`)

    // Process slides in numeric order (slide2 before slide10).
    slideFiles.sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || "0")
      const numB = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || "0")
      return numA - numB
    })

    for (const slideFile of slideFiles) {
      if (totalTextLength >= DATASOURCE_CONFIG.MAX_PPTX_TEXT_LEN) {
        Logger.info(
          `Text length limit reached (${totalTextLength}/${DATASOURCE_CONFIG.MAX_PPTX_TEXT_LEN}) for ${docid}, stopping slide processing`,
        )
        break
      }

      const slideNumber = parseInt(
        slideFile.match(/slide(\d+)\.xml$/)?.[1] || "0",
      )
      Logger.debug(`Processing slide ${slideNumber}`)

      const slideXml = await zip.file(slideFile)?.async("text")
      if (!slideXml) {
        Logger.warn(`Could not read slide file: ${slideFile}`)
        continue
      }

      const slideData = parser.parse(slideXml)

      const relsFile = slideFile
        .replace(".xml", ".xml.rels")
        .replace("ppt/slides/", "ppt/slides/_rels/")
      let relationships: Map<string, string> = new Map()

      const relsXml = await zip.file(relsFile)?.async("text")
      if (relsXml) {
        const relsData = parser.parse(relsXml)
        relationships = parseSlideRelationships(relsData)
      }

      const contentItems = processSlideContent(slideData, slideNumber)

      const speakerNotes = await extractSpeakerNotes(zip, parser, slideNumber)
      if (speakerNotes) {
        contentItems.push({
          type: "notes",
          content: `\n**Speaker Notes:**\n${speakerNotes}`,
          pos: contentItems.length,
          slideNumber: slideNumber,
        })
      }

      let textBuffer: string[] = []
      let textStartPos = globalSeq
      let textLimitReached = false

      const flushTextBuffer = () => {
        if (textBuffer.length > 0) {
          // Cross-image overlap only matters when images interleave the text.
          let textToProcess = textBuffer
          if (crossImageOverlap && extractImages) {
            textToProcess = [crossImageOverlap + " " + textBuffer.join("\n")]
            crossImageOverlap = ""
          }

          const { nextPos, overlapText } = processTextItems(
            textToProcess,
            text_chunks,
            text_chunk_pos,
            textStartPos,
          )
          textBuffer = []
          textStartPos = nextPos
          globalSeq = nextPos
          if (extractImages) {
            crossImageOverlap = overlapText
          }
        }
      }

      for (const item of contentItems) {
        if (
          (item.type === "text" ||
            item.type === "title" ||
            item.type === "table" ||
            item.type === "notes") &&
          item.content
        ) {
          if (
            totalTextLength + item.content.length <=
            DATASOURCE_CONFIG.MAX_PPTX_TEXT_LEN
          ) {
            textBuffer.push(item.content)
            totalTextLength += item.content.length
          } else {
            Logger.info(
              `Text Length exceeded for ${docid}, indexing with incomplete content`,
            )
            textLimitReached = true
            break
          }
        } else if (item.type === "image" && item.relId && extractImages) {
          // Flush pending text so chunk ordering stays correct relative to the image.
          flushTextBuffer()

          const imagePath = relationships.get(item.relId)
          if (imagePath) {
            try {
              const fullImagePath = `ppt/${imagePath}`
              const imageFile = zip.file(fullImagePath)

              if (imageFile) {
                const imageBuffer = await imageFile.async("nodebuffer")

                // Skip tiny images (icons, bullets, decorations).
                if (imageBuffer.length < 10000) {
                  Logger.debug(`Skipping small image: ${imagePath}`)
                  continue
                }

                if (
                  imageBuffer.length >
                  DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                ) {
                  Logger.warn(
                    `Skipping large image (${(imageBuffer.length / (1024 * 1024)).toFixed(2)} MB): ${imagePath}`,
                  )
                  continue
                }

                const imageExtension = path.extname(imagePath).toLowerCase()
                if (
                  !DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(
                    `image/${imageExtension.slice(1)}`,
                  )
                ) {
                  Logger.warn(
                    `Unsupported image format: ${imageExtension}. Skipping image: ${imagePath}`,
                  )
                  continue
                }

                const imageHash = md5ImageBuffer(imageBuffer)
                let outputPath: string
                try {
                  const baseDir = path.resolve(
                    process.env.IMAGE_DIR || "downloads/xyne_images_db",
                  )
                  const outputDir = path.join(baseDir, docid)
                  await fsPromises.mkdir(outputDir, { recursive: true })

                  const saveExtension = path.extname(imagePath) || ".png"
                  const imageFilename = `${globalSeq}${saveExtension}`
                  outputPath = path.join(outputDir, imageFilename)

                  await fsPromises.writeFile(
                    outputPath,
                    new Uint8Array(imageBuffer),
                  )
                  Logger.info(`Saved image to: ${outputPath}`)
                } catch (saveError) {
                  Logger.error(
                    `Failed to save image ${imagePath}: ${saveError instanceof Error ? saveError.message : saveError}`,
                  )
                  continue
                }

                const description =
                  imageDescribeBatch.registerImagePathForLaterDescribe(
                    imageHash,
                    path.resolve(outputPath),
                    describeImages,
                  )

                image_chunks.push(description)
                image_chunk_pos.push(globalSeq)
                imageSeqToHash.set(globalSeq, imageHash)
                globalSeq++

                Logger.debug(
                  `Successfully processed image: ${imagePath} from slide ${slideNumber}`,
                )
              } else {
                Logger.warn(`Could not find image file: ${fullImagePath}`)
              }
            } catch (error) {
              Logger.warn(
                `Failed to process image ${imagePath} from slide ${slideNumber}: ${error instanceof Error ? error.message : error}`,
              )
            }
          } else {
            Logger.warn(
              `Could not resolve relationship ID: ${item.relId} in slide ${slideNumber}`,
            )
          }
        }
      }

      flushTextBuffer()

      if (textLimitReached) {
        break
      }
    }

    // Flush trailing cross-image overlap as its own chunk.
    if (crossImageOverlap && extractImages) {
      const { nextPos } = processTextItems(
        [crossImageOverlap],
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )
      globalSeq = nextPos
      crossImageOverlap = ""
    }

    await imageDescribeBatch.flushDescribeQueue(describeImages)
    imageDescribeBatch.stripRejectedImageRows(
      image_chunks,
      image_chunk_pos,
      imageSeqToHash,
    )
    imageDescribeBatch.applyResolvedDescriptions(
      image_chunks,
      image_chunk_pos,
      imageSeqToHash,
    )

    Logger.info(
      `PPTX processing completed. Total text chunks: ${text_chunks.length}, Total image chunks: ${image_chunks.length}`,
    )

    extractionSucceeded = true
    return {
      text_chunks,
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
    }
  } finally {
    if (imageDescribeBatch && extractImages) {
      await imageDescribeBatch.disposeTrackedImageFiles({
        unlinkFiles: !extractionSucceeded,
      })
    }
    //@ts-ignore
    zip = null
  }
}
