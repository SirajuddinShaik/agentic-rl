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
  module: "docxChunks",
})

interface ProcessingWarning {
  type:
    | "unsupported_element"
    | "symbol_conversion"
    | "field_processing"
    | "table_structure"
    | "general"
  message: string
  element?: string
  context?: any
}

class WarningCollector {
  private warnings: ProcessingWarning[] = []
  private stats = {
    elementsProcessed: 0,
    elementsSkipped: 0,
    symbolsConverted: 0,
    fieldsProcessed: 0,
    tablesProcessed: 0,
    unsupportedElements: new Set<string>(),
  }

  addWarning(warning: ProcessingWarning) {
    this.warnings.push(warning)
    if (warning.type === "unsupported_element" && warning.element) {
      this.stats.unsupportedElements.add(warning.element)
    }
  }

  incrementStat(stat: keyof typeof this.stats) {
    if (typeof this.stats[stat] === "number") {
      ;(this.stats[stat] as number)++
    }
  }

  getWarnings(): ProcessingWarning[] {
    return this.warnings
  }

  getStats() {
    return {
      ...this.stats,
      unsupportedElements: Array.from(this.stats.unsupportedElements),
    }
  }

  logSummary() {
    const stats = this.getStats()
    Logger.info("DOCX Processing Summary:", {
      elementsProcessed: stats.elementsProcessed,
      elementsSkipped: stats.elementsSkipped,
      symbolsConverted: stats.symbolsConverted,
      fieldsProcessed: stats.fieldsProcessed,
      tablesProcessed: stats.tablesProcessed,
      warningsCount: this.warnings.length,
      unsupportedElements: stats.unsupportedElements,
    })

    if (this.warnings.length > 0) {
      Logger.warn(`Found ${this.warnings.length} processing warnings:`)
      this.warnings.forEach((warning, index) => {
        Logger.warn(
          `Warning ${index + 1}: [${warning.type}] ${warning.message}`,
          warning.context,
        )
      })
    }
  }
}

// Symbol-font (Wingdings/Symbol) char-code → Unicode mappings
const SYMBOL_MAPPINGS: { [font: string]: { [char: string]: string } } = {
  Wingdings: {
    "21": "☎",
    "22": "✉",
    "23": "📁",
    "24": "📂",
    "25": "🗂",
    "26": "⌚",
    "27": "⏰",
    "28": "📞",
    "29": "📠",
    "2A": "💻",
    "2B": "🖱",
    "2C": "⌨",
    "2D": "🖨",
    "2E": "📧",
    "2F": "🌐",
    "30": "🔒",
    "31": "🔓",
    "32": "🔑",
    "33": "✂",
    "34": "✏",
    "35": "✒",
    "36": "📝",
    "37": "📋",
    "38": "📌",
    "39": "📎",
    "3A": "🔗",
    "3B": "⚡",
    "3C": "☀",
    "3D": "☁",
    "3E": "☂",
    "3F": "❄",
    "40": "⭐",
    "41": "🌙",
    "42": "🔥",
    "43": "💧",
    "44": "🌍",
    "45": "🌱",
    "46": "🌳",
    "47": "🌸",
    "48": "🌺",
    "49": "🍀",
    "4A": "🐝",
    "4B": "🦋",
    "4C": "🐛",
    "4D": "🐾",
    "4E": "👤",
    "4F": "👥",
    "50": "👨",
    "51": "👩",
    "52": "👶",
    "53": "👴",
    "54": "👵",
    "55": "💼",
    "56": "🎓",
    "57": "🏠",
    "58": "🏢",
    "59": "🏥",
    "5A": "🏫",
    "5B": "🏪",
    "5C": "🚗",
    "5D": "✈",
    "5E": "🚢",
    "5F": "🚂",
    "60": "🚲",
    "61": "⚽",
    "62": "🏀",
    "63": "🎾",
    "64": "⚾",
    "65": "🏈",
    "66": "🎯",
    "67": "🎮",
    "68": "🎲",
    "69": "🃏",
    "6A": "🎭",
    "6B": "🎨",
    "6C": "🎵",
    "6D": "🎶",
    "6E": "📻",
    "6F": "📺",
    "70": "📷",
    "71": "📹",
    "72": "💿",
    "73": "💾",
    "74": "💽",
    "75": "📀",
    "76": "🔊",
    "77": "🔇",
    "78": "📢",
    "79": "📣",
    "7A": "🔔",
    "7B": "🔕",
    "7C": "📯",
    "7D": "🎺",
    "7E": "🎸",
    "7F": "🎹",
    "80": "🥁",
    "81": "🎤",
    "82": "🎧",
    "83": "📱",
    "84": "☎",
    "85": "📞",
    "86": "📟",
    "87": "📠",
    "88": "💻",
    "89": "🖥",
    "8A": "⌨",
    "8B": "🖱",
    "8C": "🖨",
    "8D": "💾",
    "8E": "💿",
    "8F": "📀",
    "90": "💽",
    "91": "💾",
    "92": "🗃",
    "93": "🗂",
    "94": "📋",
    "95": "📊",
    "96": "📈",
    "97": "📉",
    "98": "📇",
    "99": "🗃",
    "9A": "🗄",
    "9B": "📁",
    "9C": "📂",
    "9D": "🗂",
    "9E": "📑",
    "9F": "📄",
    A0: "📃",
    A1: "📜",
    A2: "📰",
    A3: "🗞",
    A4: "📓",
    A5: "📔",
    A6: "📒",
    A7: "📕",
    A8: "📗",
    A9: "📘",
    AA: "📙",
    AB: "📚",
    AC: "📖",
    AD: "🔖",
    AE: "🏷",
    AF: "💰",
    B0: "💴",
    B1: "💵",
    B2: "💶",
    B3: "💷",
    B4: "💸",
    B5: "💳",
    B6: "💎",
    B7: "⚖",
    B8: "🔧",
    B9: "🔨",
    BA: "⚒",
    BB: "🛠",
    BC: "⛏",
    BD: "🔩",
    BE: "⚙",
    BF: "⚗",
    C0: "🔬",
    C1: "🔭",
    C2: "📡",
    C3: "💉",
    C4: "💊",
    C5: "🩹",
    C6: "🩺",
    C7: "🔬",
    C8: "🧪",
    C9: "🧬",
    CA: "🦠",
    CB: "💀",
    CC: "☠",
    CD: "👻",
    CE: "👽",
    CF: "🤖",
    D0: "🎃",
    D1: "😈",
    D2: "👿",
    D3: "👹",
    D4: "👺",
    D5: "💩",
    D6: "🤡",
    D7: "👻",
    D8: "💀",
    D9: "☠",
    DA: "👽",
    DB: "🤖",
    DC: "🎭",
    DD: "🎨",
    DE: "🎪",
    DF: "🎢",
    E0: "🎡",
    E1: "🎠",
    E2: "🎪",
    E3: "🎭",
    E4: "🎨",
    E5: "🎬",
    E6: "🎤",
    E7: "🎧",
    E8: "🎼",
    E9: "🎵",
    EA: "🎶",
    EB: "🎹",
    EC: "🥁",
    ED: "🎷",
    EE: "🎺",
    EF: "🎸",
    F0: "🎻",
    F1: "🎲",
    F2: "🎯",
    F3: "🎳",
    F4: "🎮",
    F5: "🕹",
    F6: "🎰",
    F7: "🃏",
    F8: "🀄",
    F9: "🎴",
    FA: "🎊",
    FB: "🎉",
    FC: "🎈",
    FD: "🎁",
    FE: "🎀",
    FF: "🎗",
  },
  Symbol: {
    "21": "!",
    "22": "∀",
    "23": "#",
    "24": "∃",
    "25": "%",
    "26": "&",
    "27": "∋",
    "28": "(",
    "29": ")",
    "2A": "∗",
    "2B": "+",
    "2C": ",",
    "2D": "−",
    "2E": ".",
    "2F": "/",
    "30": "0",
    "31": "1",
    "32": "2",
    "33": "3",
    "34": "4",
    "35": "5",
    "36": "6",
    "37": "7",
    "38": "8",
    "39": "9",
    "3A": ":",
    "3B": ";",
    "3C": "<",
    "3D": "=",
    "3E": ">",
    "3F": "?",
    "40": "≅",
    "41": "Α",
    "42": "Β",
    "43": "Χ",
    "44": "Δ",
    "45": "Ε",
    "46": "Φ",
    "47": "Γ",
    "48": "Η",
    "49": "Ι",
    "4A": "ϑ",
    "4B": "Κ",
    "4C": "Λ",
    "4D": "Μ",
    "4E": "Ν",
    "4F": "Ο",
    "50": "Π",
    "51": "Θ",
    "52": "Ρ",
    "53": "Σ",
    "54": "Τ",
    "55": "Υ",
    "56": "ς",
    "57": "Ω",
    "58": "Ξ",
    "59": "Ψ",
    "5A": "Ζ",
    "5B": "[",
    "5C": "∴",
    "5D": "]",
    "5E": "⊥",
    "5F": "_",
    "60": "‾",
    "61": "α",
    "62": "β",
    "63": "χ",
    "64": "δ",
    "65": "ε",
    "66": "φ",
    "67": "γ",
    "68": "η",
    "69": "ι",
    "6A": "ϕ",
    "6B": "κ",
    "6C": "λ",
    "6D": "μ",
    "6E": "ν",
    "6F": "ο",
    "70": "π",
    "71": "θ",
    "72": "ρ",
    "73": "σ",
    "74": "τ",
    "75": "υ",
    "76": "ϖ",
    "77": "ω",
    "78": "ξ",
    "79": "ψ",
    "7A": "ζ",
    "7B": "{",
    "7C": "|",
    "7D": "}",
    "7E": "∼",
    A0: "€",
    A1: "ϒ",
    A2: "′",
    A3: "≤",
    A4: "⁄",
    A5: "∞",
    A6: "ƒ",
    A7: "♣",
    A8: "♦",
    A9: "♥",
    AA: "♠",
    AB: "↔",
    AC: "←",
    AD: "↑",
    AE: "→",
    AF: "↓",
    B0: "°",
    B1: "±",
    B2: "″",
    B3: "≥",
    B4: "×",
    B5: "∝",
    B6: "∂",
    B7: "•",
    B8: "÷",
    B9: "≠",
    BA: "≡",
    BB: "≈",
    BC: "…",
    BD: "⏐",
    BE: "⏐",
    BF: "↵",
    C0: "ℵ",
    C1: "ℑ",
    C2: "ℜ",
    C3: "℘",
    C4: "⊗",
    C5: "⊕",
    C6: "∅",
    C7: "∩",
    C8: "∪",
    C9: "⊃",
    CA: "⊇",
    CB: "⊄",
    CC: "⊂",
    CD: "⊆",
    CE: "∈",
    CF: "∉",
    D0: "∠",
    D1: "∇",
    D2: "®",
    D3: "©",
    D4: "™",
    D5: "∏",
    D6: "√",
    D7: "⋅",
    D8: "¬",
    D9: "∧",
    DA: "∨",
    DB: "⇔",
    DC: "⇐",
    DD: "⇑",
    DE: "⇒",
    DF: "⇓",
    E0: "◊",
    E1: "〈",
    E2: "®",
    E3: "©",
    E4: "™",
    E5: "∑",
    E6: "⎛",
    E7: "⎜",
    E8: "⎝",
    E9: "⎡",
    EA: "⎢",
    EB: "⎣",
    EC: "⎧",
    ED: "⎨",
    EE: "⎩",
    EF: "⎪",
    F0: "⎫",
    F1: "⎬",
    F2: "⎭",
    F3: "⎤",
    F4: "⎥",
    F5: "⎦",
    F6: "⎞",
    F7: "⎟",
    F8: "⎠",
    F9: "〉",
    FA: "∫",
    FB: "⌠",
    FC: "⌡",
    FD: "⎮",
    FE: "⎯",
    FF: "⎰",
  },
}

interface ComplexField {
  type: "begin" | "hyperlink" | "checkbox" | "unknown"
  fldChar?: any
  options?: any
  checked?: boolean
}

const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

// Normalizes whitespace/newlines; mirrors the Google Docs post-processing for consistency.
const postProcessText = (text: string): string => {
  const lines = text.split("\n")
  const processedLines: string[] = []
  let previousLine = ""
  let consecutiveNewlines = 0

  const isListItem = (line: string): boolean => /^[\s]*[-*+] /.test(line)

  lines.forEach((line, index) => {
    const trimmedLine = line.trim()

    if (trimmedLine === "") {
      consecutiveNewlines++
      if (consecutiveNewlines <= 2) {
        processedLines.push("")
      }
    } else {
      if (
        consecutiveNewlines >= 2 ||
        index === 0 ||
        trimmedLine.startsWith("#")
      ) {
        processedLines.push(trimmedLine)
      } else if (previousLine !== "" && !isListItem(previousLine)) {
        processedLines[processedLines.length - 1] += " " + trimmedLine
      } else {
        processedLines.push(trimmedLine)
      }
      consecutiveNewlines = 0
    }

    previousLine = trimmedLine
  })

  return processedLines.join("\n")
}

interface DocxContentItem {
  type: "text" | "image"
  content?: string
  relId?: string
  pos: number
}

interface DocxProcessingResult {
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}

// Maps a paragraph's Heading{N} style to a Markdown "#" prefix.
function getHeadingPrefix(paragraph: any): string {
  const pStyle = paragraph["w:pPr"]?.["w:pStyle"]?.["@_w:val"]
  if (pStyle) {
    const headingMatch = pStyle.match(/[Hh]eading(\d+)/)
    if (headingMatch) {
      const level = parseInt(headingMatch[1])
      return "#".repeat(level) + " "
    }
  }
  return ""
}

// Extracts Office Math (m:oMath/m:oMathPara) equations as [MATH: ...] placeholders.
function extractMathFromParagraph(paragraph: any): string {
  let mathTexts: string[] = []
  if (!paragraph) return ""

  function serializeMathBlock(mathBlock: any): string {
    let result = ""
    function traverse(node: any) {
      if (!node || typeof node !== "object") return
      if (typeof node["w:t"] === "string") {
        result += node["w:t"]
      }
      if (typeof node["#text"] === "string") {
        result += node["#text"]
      }
      for (const key of Object.keys(node)) {
        if (typeof node[key] === "object") {
          traverse(node[key])
        }
        if (Array.isArray(node[key])) {
          for (const child of node[key]) {
            traverse(child)
          }
        }
      }
    }
    traverse(mathBlock)
    return result.trim()
  }

  // Math blocks can sit directly on the paragraph or inside runs.
  if (paragraph["m:oMath"]) {
    const mathBlocks = Array.isArray(paragraph["m:oMath"])
      ? paragraph["m:oMath"]
      : [paragraph["m:oMath"]]
    for (const mathBlock of mathBlocks) {
      const mathString = serializeMathBlock(mathBlock)
      if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
    }
  }
  if (paragraph["m:oMathPara"]) {
    const mathParas = Array.isArray(paragraph["m:oMathPara"])
      ? paragraph["m:oMathPara"]
      : [paragraph["m:oMathPara"]]
    for (const mathPara of mathParas) {
      if (mathPara["m:oMath"]) {
        const mathBlocks = Array.isArray(mathPara["m:oMath"])
          ? mathPara["m:oMath"]
          : [mathPara["m:oMath"]]
        for (const mathBlock of mathBlocks) {
          const mathString = serializeMathBlock(mathBlock)
          if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
        }
      } else {
        const mathString = serializeMathBlock(mathPara)
        if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
      }
    }
  }
  const runs = paragraph["w:r"] || paragraph.r || []
  const runsArray = Array.isArray(runs) ? runs : [runs]
  for (const run of runsArray) {
    if (!run) continue
    if (run["m:oMath"]) {
      const mathBlocks = Array.isArray(run["m:oMath"])
        ? run["m:oMath"]
        : [run["m:oMath"]]
      for (const mathBlock of mathBlocks) {
        const mathString = serializeMathBlock(mathBlock)
        if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
      }
    }
    if (run["m:oMathPara"]) {
      const mathParas = Array.isArray(run["m:oMathPara"])
        ? run["m:oMathPara"]
        : [run["m:oMathPara"]]
      for (const mathPara of mathParas) {
        if (mathPara["m:oMath"]) {
          const mathBlocks = Array.isArray(mathPara["m:oMath"])
            ? mathPara["m:oMath"]
            : [mathPara["m:oMath"]]
          for (const mathBlock of mathBlocks) {
            const mathString = serializeMathBlock(mathBlock)
            if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
          }
        } else {
          const mathString = serializeMathBlock(mathPara)
          if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
        }
      }
    }
  }
  return mathTexts.join(" ")
}

function isCodeBlockStyle(paragraph: any): boolean {
  const pStyle = paragraph["w:pPr"]?.["w:pStyle"]?.["@_w:val"]
  if (!pStyle) return false

  const codeStylePatterns = [
    /code/i,
    /source/i,
    /program/i,
    /console/i,
    /terminal/i,
    /mono/i,
    /pre/i,
    /listing/i,
    /verbatim/i,
  ]

  return codeStylePatterns.some((pattern) => pattern.test(pStyle))
}

// Heuristic: shading, borders, or monospace runs suggest a code block.
function hasCodeFormatting(paragraph: any): boolean {
  const pPr = paragraph["w:pPr"]
  if (!pPr) return false

  const shading = pPr["w:shd"]
  if (shading && shading["@_w:fill"] && shading["@_w:fill"] !== "auto") {
    const codeColors = [
      "F5F5F5",
      "F0F0F0",
      "E8E8E8",
      "EEEEEE",
      "F8F8F8",
      "FAFAFA",
    ]
    const fill = shading["@_w:fill"].toUpperCase()
    if (codeColors.includes(fill)) return true
  }

  const borders = pPr["w:pBdr"]
  if (borders) return true

  const runs = paragraph["w:r"] || []
  const runsArray = Array.isArray(runs) ? runs : [runs]
  if (runsArray.length > 0) {
    const validRuns = runsArray.filter(
      (run) => run !== null && run !== undefined,
    )
    if (validRuns.length > 0) {
      const hasMonospaceRun = validRuns.some((run) => isCodeFormatting(run))
      if (hasMonospaceRun) return true
    }
  }

  return false
}

function isCodeFormatting(run: any): boolean {
  const rFonts = run["w:rPr"]?.["w:rFonts"]
  if (!rFonts) return false

  const fontNames = [
    rFonts["@_w:ascii"],
    rFonts["@_w:hAnsi"],
    rFonts["@_w:cs"],
    rFonts["@_w:eastAsia"],
  ].filter(Boolean)

  const monospaceFonts = [
    /consolas/i,
    /courier/i,
    /monaco/i,
    /monospace/i,
    /terminal/i,
    /fixed/i,
  ]

  return fontNames.some((font) =>
    monospaceFonts.some((pattern) => pattern.test(font)),
  )
}

function readSymbol(element: any, warningCollector?: WarningCollector): string {
  const font = element.attributes?.["@_w:font"] || element["@_w:font"]
  const char = element.attributes?.["@_w:char"] || element["@_w:char"]

  if (!font || !char) {
    warningCollector?.addWarning({
      type: "symbol_conversion",
      message: "Symbol element missing font or char attribute",
      context: { element },
    })
    return ""
  }

  // Symbol fonts encode chars in the F0xx private-use range; strip the F0 prefix.
  let normalizedChar = char.toUpperCase()
  if (normalizedChar.startsWith("F0") && normalizedChar.length === 4) {
    normalizedChar = normalizedChar.substring(2)
  }

  const fontMappings = SYMBOL_MAPPINGS[font]
  const mappedChar = fontMappings?.[normalizedChar]
  if (mappedChar) {
    warningCollector?.incrementStat("symbolsConverted")
    return mappedChar
  }

  const alternativeFonts = ["Wingdings", "Symbol"]
  for (const altFont of alternativeFonts) {
    const altMappedChar = SYMBOL_MAPPINGS[altFont]?.[normalizedChar]
    if (altFont !== font && altMappedChar) {
      warningCollector?.incrementStat("symbolsConverted")
      return altMappedChar
    }
  }

  // Fallback: treat the hex code as a Unicode code point.
  try {
    const codePoint = parseInt(normalizedChar, 16)
    if (codePoint > 0 && codePoint <= 0x10ffff) {
      const unicodeChar = String.fromCodePoint(codePoint)
      warningCollector?.incrementStat("symbolsConverted")
      return unicodeChar
    }
  } catch (error) {
    // Ignore conversion errors
  }

  warningCollector?.addWarning({
    type: "symbol_conversion",
    message: `Unsupported symbol character: char ${char} in font ${font}`,
    context: { font, char, normalizedChar },
  })

  return `[SYMBOL:${font}:${char}]`
}

// Walks the complex-field stack (begin/separate/end) emitting placeholders for form fields.
function readFldChar(
  element: any,
  complexFieldStack: ComplexField[],
  currentInstrText: string[],
  warningCollector?: WarningCollector,
): string {
  const type =
    element.attributes?.["@_w:fldCharType"] || element["@_w:fldCharType"]

  if (type === "begin") {
    complexFieldStack.push({ type: "begin", fldChar: element })
    currentInstrText.length = 0
    warningCollector?.incrementStat("fieldsProcessed")
  } else if (type === "end") {
    const complexFieldEnd = complexFieldStack.pop()
    if (complexFieldEnd?.type === "begin") {
      const parsedField = parseInstrText(
        currentInstrText.join(""),
        complexFieldEnd.fldChar || {},
      )
      if (parsedField.type === "checkbox") {
        return `[CHECKBOX:${parsedField.checked ? "CHECKED" : "UNCHECKED"}]`
      }
    }
    warningCollector?.incrementStat("fieldsProcessed")
  } else if (type === "separate") {
    const complexFieldSeparate = complexFieldStack.pop()
    if (complexFieldSeparate?.type === "begin") {
      const parsedField = parseInstrText(
        currentInstrText.join(""),
        complexFieldSeparate.fldChar || {},
      )
      complexFieldStack.push(parsedField)
    }
  }

  return ""
}

function parseInstrText(instrText: string, fldChar: any): ComplexField {
  const externalLinkResult = /\s*HYPERLINK\s+"([^"]*)"/.exec(instrText)
  if (externalLinkResult) {
    return { type: "hyperlink", options: { href: externalLinkResult[1] } }
  }

  const internalLinkResult = /\s*HYPERLINK\s+\\l\s+"([^"]*)"/.exec(instrText)
  if (internalLinkResult) {
    return { type: "hyperlink", options: { anchor: internalLinkResult[1] } }
  }

  const checkboxResult = /\s*FORMCHECKBOX\s*/.exec(instrText)
  if (checkboxResult) {
    const checkboxElement = fldChar?.["w:ffData"]?.["w:checkBox"]
    if (checkboxElement) {
      const checkedElement = checkboxElement["w:checked"]
      const defaultElement = checkboxElement["w:default"]

      let checked = false
      if (checkedElement) {
        const val =
          checkedElement.attributes?.["@_w:val"] || checkedElement["@_w:val"]
        checked = val !== "false" && val !== "0"
      } else if (defaultElement) {
        const val =
          defaultElement.attributes?.["@_w:val"] || defaultElement["@_w:val"]
        checked = val !== "false" && val !== "0"
      }

      return { type: "checkbox", checked }
    }
    return { type: "checkbox", checked: false }
  }

  const textFieldResult = /\s*FORMTEXT\s*/.exec(instrText)
  if (textFieldResult) {
    return { type: "unknown", options: { fieldType: "text" } }
  }

  const dropdownResult = /\s*FORMDROPDOWN\s*/.exec(instrText)
  if (dropdownResult) {
    return { type: "unknown", options: { fieldType: "dropdown" } }
  }

  return { type: "unknown" }
}

/**
 * Renders a table to tab/newline-separated text, resolving horizontal (gridSpan)
 * and vertical (vMerge) cell merges so continuation cells are dropped.
 */
function extractTextFromTableWithMerging(
  table: any,
  documentData?: any,
  warningCollector?: WarningCollector,
): string {
  if (!table) return ""

  const rows = table["w:tr"] || []
  const rowsArray = Array.isArray(rows) ? rows : [rows]

  // Pass 1: collect cells with their span/merge properties.
  const tableData: Array<
    Array<{
      content: string
      colSpan: number
      vMerge: boolean | null
      rowSpan?: number
    }>
  > = []

  for (const row of rowsArray) {
    const cells = row["w:tc"] || []
    const cellsArray = Array.isArray(cells) ? cells : [cells]

    const rowData = cellsArray.map((cell) => {
      const paragraphs = cell["w:p"] || []
      const paragraphsArray = Array.isArray(paragraphs)
        ? paragraphs
        : [paragraphs]

      const content = paragraphsArray
        .map((p) => extractTextFromParagraph(p, documentData))
        .join("\n")

      const properties = cell["w:tcPr"] || {}
      const gridSpan =
        properties["w:gridSpan"]?.["@_w:val"] ||
        properties["w:gridSpan"]?.attributes?.["@_w:val"]
      const colSpan = gridSpan ? parseInt(gridSpan, 10) : 1

      const vMergeElement = properties["w:vMerge"]
      let vMerge: boolean | null = null
      if (vMergeElement) {
        const val =
          vMergeElement.attributes?.["@_w:val"] || vMergeElement["@_w:val"]
        // OOXML: vMerge with no/absent val starts a merge; "continue" marks a continuation cell.
        vMerge = val === "continue" || !val
      }

      return { content, colSpan, vMerge }
    })

    tableData.push(rowData)
  }

  // Pass 2: resolve row spans.
  const processedTable = calculateRowSpans(tableData, warningCollector)

  // Pass 3: render, dropping continuation cells (rowSpan 0).
  const result =
    processedTable
      .map((row) => {
        return row
          .filter((cell) => cell.rowSpan !== 0)
          .map((cell) => cell.content)
          .join("\t")
      })
      .join("\n") + "\n\n"

  warningCollector?.incrementStat("tablesProcessed")
  return result
}

// Assigns rowSpan to each cell from vMerge flags; continuation cells get rowSpan 0.
function calculateRowSpans(
  tableData: Array<
    Array<{
      content: string
      colSpan: number
      vMerge: boolean | null
      rowSpan?: number
    }>
  >,
  _warningCollector?: WarningCollector,
): Array<
  Array<{
    content: string
    colSpan: number
    vMerge: boolean | null
    rowSpan: number
  }>
> {
  // Per-column countdown of remaining merged rows, so we skip columns already spanned.
  const columnMergeState: {
    [colIndex: number]: { rowSpan: number; sourceRow: number }
  } = {}

  const processedTable = tableData.map((row, rowIndex) => {
    let colIndex = 0

    return row.map((cell) => {
      let mergeState = columnMergeState[colIndex]
      while (mergeState && mergeState.rowSpan > 0) {
        mergeState.rowSpan--
        if (mergeState.rowSpan === 0) {
          delete columnMergeState[colIndex]
        }
        colIndex++
        mergeState = columnMergeState[colIndex]
      }

      const currentColIndex = colIndex
      let rowSpan = 1

      if (cell.vMerge === true) {
        // Continuation cell — hidden.
        rowSpan = 0
      } else if (cell.vMerge === false || cell.vMerge === null) {
        // Merge origin (or standalone): count following continuation cells in this column.
        let lookAheadRow = rowIndex + 1
        while (lookAheadRow < tableData.length) {
          const nextRowCell = tableData[lookAheadRow]?.[currentColIndex]
          if (nextRowCell && nextRowCell.vMerge === true) {
            rowSpan++
            lookAheadRow++
          } else {
            break
          }
        }

        if (rowSpan > 1) {
          columnMergeState[currentColIndex] = {
            rowSpan: rowSpan - 1,
            sourceRow: rowIndex,
          }
        }
      }

      colIndex += cell.colSpan

      return {
        ...cell,
        rowSpan,
      }
    })
  })

  return processedTable
}

function readInstrText(element: any, currentInstrText: string[]): string {
  const text = element.text?.() || element["#text"] || ""
  currentInstrText.push(text)
  return ""
}

// w:t can be a bare string or an object with #text.
function extractTextFromElement(textElement: any): string {
  if (!textElement) return ""

  if (typeof textElement === "string") {
    return textElement
  } else if (textElement["#text"]) {
    return textElement["#text"]
  }

  return ""
}

// Paragraph text plus any text-box content from embedded VML shapes, appended after it.
function extractCompleteTextFromParagraph(
  paragraph: any,
  documentData?: any,
): string {
  if (!paragraph) return ""

  const paragraphText = extractTextFromParagraph(paragraph, documentData)

  const contentParts: { text: string }[] = []

  if (paragraphText.trim()) {
    contentParts.push({ text: paragraphText })
  }

  // VML text boxes live in w:pict as v:shape / v:rect / v:roundrect.
  if (paragraph["w:pict"]) {
    const pict = paragraph["w:pict"]

    if (pict["v:shape"]) {
      const shapes = Array.isArray(pict["v:shape"])
        ? pict["v:shape"]
        : [pict["v:shape"]]
      for (const shape of shapes) {
        if (shape["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(shape, documentData)
          if (textBoxContent) {
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }

    if (pict["v:rect"]) {
      const rects = Array.isArray(pict["v:rect"])
        ? pict["v:rect"]
        : [pict["v:rect"]]
      for (const rect of rects) {
        if (rect["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(rect, documentData)
          if (textBoxContent) {
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }

    if (pict["v:roundrect"]) {
      const roundrects = Array.isArray(pict["v:roundrect"])
        ? pict["v:roundrect"]
        : [pict["v:roundrect"]]
      for (const roundrect of roundrects) {
        if (roundrect["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(roundrect, documentData)
          if (textBoxContent) {
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }
  }

  // AlternateContent fallback may carry the same VML text boxes.
  if (paragraph["mc:AlternateContent"]) {
    const altContent = paragraph["mc:AlternateContent"]
    const fallback = altContent["mc:Fallback"]
    if (fallback && fallback["w:pict"]) {
      const pict = fallback["w:pict"]
      const shapes = []
      if (pict["v:shape"])
        shapes.push(
          ...(Array.isArray(pict["v:shape"])
            ? pict["v:shape"]
            : [pict["v:shape"]]),
        )
      if (pict["v:rect"])
        shapes.push(
          ...(Array.isArray(pict["v:rect"])
            ? pict["v:rect"]
            : [pict["v:rect"]]),
        )
      if (pict["v:roundrect"])
        shapes.push(
          ...(Array.isArray(pict["v:roundrect"])
            ? pict["v:roundrect"]
            : [pict["v:roundrect"]]),
        )

      for (const shape of shapes) {
        if (shape["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(shape, documentData)
          if (textBoxContent) {
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }
  }

  return contentParts.map((part) => part.text).join("\n\n")
}

/**
 * Renders a paragraph to Markdown-ish text: runs, breaks, symbols, form fields,
 * footnote/endnote/comment refs, math placeholders, plus list/heading/code formatting.
 */
function extractTextFromParagraph(
  paragraph: any,
  documentData?: any,
  warningCollector?: WarningCollector,
): string {
  let text = ""
  if (!paragraph) return text

  const complexFieldStack: ComplexField[] = []
  const currentInstrText: string[] = []

  const isCodeBlock =
    isCodeBlockStyle(paragraph) || hasCodeFormatting(paragraph)

  if (paragraph["w:hyperlink"]) {
    const hyperlinks = Array.isArray(paragraph["w:hyperlink"])
      ? paragraph["w:hyperlink"]
      : [paragraph["w:hyperlink"]]
    return hyperlinks
      .map((hl) => {
        const relId = hl["@_r:id"]
        const hyperlinkRuns = hl["w:r"] || []
        const hyperlinkRunsArray = Array.isArray(hyperlinkRuns)
          ? hyperlinkRuns
          : [hyperlinkRuns]
        const hyperlinkText = hyperlinkRunsArray
          .map((r) => {
            const textEl = r["w:t"]
            const text =
              typeof textEl === "string" ? textEl : textEl?.["#text"] || ""
            return text
          })
          .join("") // No separator: runs already carry the document's exact spacing.
        if (
          relId &&
          documentData?.__rels &&
          typeof documentData.__rels.get === "function" &&
          documentData.__rels.has(relId)
        ) {
          const href = documentData.__rels.get(relId)
          return `[${hyperlinkText}](${href})`
        }
        return hyperlinkText
      })
      .join(" ")
  }

  const numPr = paragraph["w:pPr"]?.["w:numPr"]
  let isListItem = false
  let listLevel = 0

  if (numPr) {
    isListItem = true
    listLevel = parseInt(numPr["w:ilvl"]?.["@_w:val"] || "0")
  }

  let codeFragments: string[] = []
  let contentParts: string[] = []

  const runs = paragraph["w:r"] || paragraph.r || []
  const runsArray = Array.isArray(runs) ? runs : [runs]

  const breaks = paragraph["w:br"] || []
  const breaksArray = Array.isArray(breaks) ? breaks : [breaks]

  for (const run of runsArray) {
    if (!run) continue

    const isCode = isCodeFormatting(run)

    // A run may hold several w:t with w:br between them.
    const runParts: string[] = []

    const textElements = run["w:t"] || run.t || []
    const textElementsArray = Array.isArray(textElements)
      ? textElements
      : [textElements]

    const breakElements = run["w:br"] || run.br || []
    const breakElementsArray = Array.isArray(breakElements)
      ? breakElements
      : [breakElements]

    for (const textElement of textElementsArray) {
      if (!textElement) continue

      const runText = extractTextFromElement(textElement)

      if (runText) {
        runParts.push(runText)
      }
    }

    const symbolElement = run["w:sym"]
    if (symbolElement) {
      const symbolText = readSymbol(symbolElement, warningCollector)
      if (symbolText) {
        runParts.push(symbolText)
      }
    }

    const fldCharElement = run["w:fldChar"]
    if (fldCharElement) {
      const fieldText = readFldChar(
        fldCharElement,
        complexFieldStack,
        currentInstrText,
        warningCollector,
      )
      if (fieldText) {
        runParts.push(fieldText)
      }
    }

    const instrTextElement = run["w:instrText"]
    if (instrTextElement) {
      readInstrText(instrTextElement, currentInstrText)
    }

    // Multiple w:t with interspersed w:br: rebuild inserting a newline between them.
    if (textElementsArray.length > 1 && breakElementsArray.length > 0) {
      const reconstructed: string[] = []

      for (let i = 0; i < textElementsArray.length; i++) {
        const textElement = textElementsArray[i]
        if (!textElement) continue

        const runText = extractTextFromElement(textElement)

        if (runText) {
          reconstructed.push(runText)
          if (i < textElementsArray.length - 1) {
            reconstructed.push("\n")
          }
        }
      }

      const fullRunText = reconstructed.join("")
      if (isCode && !isCodeBlock) {
        codeFragments.push("`" + fullRunText + "`")
      } else {
        contentParts.push(fullRunText)
      }
    } else if (runParts.length > 0) {
      const fullRunText = runParts.join("")
      if (isCode && !isCodeBlock) {
        codeFragments.push("`" + fullRunText + "`")
      } else {
        contentParts.push(fullRunText)
      }
    }

    const footnoteRef = run["w:footnoteReference"]
    if (footnoteRef) {
      const footnoteId = footnoteRef["@_w:id"]
      if (footnoteId) {
        contentParts.push(`[^${footnoteId}]`)
      }
    }

    const endnoteRef = run["w:endnoteReference"]
    if (endnoteRef) {
      const endnoteId = endnoteRef["@_w:id"]
      if (endnoteId) {
        contentParts.push(`[^endnote-${endnoteId}]`)
      }
    }

    const commentRef = run["w:commentReference"]
    if (commentRef) {
      const commentId = commentRef["@_w:id"]
      if (commentId && documentData?.__comments?.has(commentId)) {
        contentParts.push(` [^comment-${commentId}]`)
      }
    }

    // Tabs only; run-level breaks are handled alongside text elements above.
    if (run["w:tab"] || run.tab) {
      contentParts.push("\t")
    }

    warningCollector?.incrementStat("elementsProcessed")
  }

  // Paragraph-level breaks (e.g. text-wrapping) become newlines between runs.
  if (breaksArray.length > 0 && breaksArray[0]) {
    for (const br of breaksArray) {
      if (br && typeof br === "object") {
        contentParts.push("\n")
      }
    }
  }

  text = contentParts.join("")

  if (codeFragments.length > 0) {
    text += " " + codeFragments.join(" ")
  }

  const mathText = extractMathFromParagraph(paragraph)
  if (mathText) {
    if (text.trim()) {
      text += " " + mathText
    } else {
      text = mathText
    }
  }

  if (isCodeBlock && text.trim()) {
    text = "```\n" + text.trim() + "\n```"
  }

  if (isListItem && text.trim() && !isCodeBlock) {
    const indent = "  ".repeat(listLevel)
    text = indent + "- " + text.trim()
  }

  if (!isListItem && !isCodeBlock && text.trim()) {
    const headingPrefix = getHeadingPrefix(paragraph)
    text = headingPrefix + text.trim()
  }

  return text
}

function extractTextFromTable(
  table: any,
  documentData?: any,
  warningCollector?: WarningCollector,
): string {
  if (!table) return ""

  return extractTextFromTableWithMerging(table, documentData, warningCollector)
}

// Pulls text from VML/DrawingML text boxes (modern txbxContent and legacy v:textbox).
function extractTextFromTextBox(textBox: any, documentData?: any): string {
  if (!textBox) return ""

  Logger.debug("Processing textBox:", JSON.stringify(textBox, null, 2))

  let text = ""

  const txbxContent =
    textBox["w:txbxContent"] || textBox["v:textbox"]?.["w:txbxContent"]
  if (txbxContent) {
    Logger.debug("Found w:txbxContent:", JSON.stringify(txbxContent, null, 2))

    const paragraphs = txbxContent["w:p"] || []
    const paragraphsArray = Array.isArray(paragraphs)
      ? paragraphs
      : [paragraphs]

    Logger.debug(`Processing ${paragraphsArray.length} paragraphs in textbox`)

    text = paragraphsArray
      .map((p, index) => {
        const paragraphText = extractTextFromParagraph(p, documentData)
        Logger.debug(`Paragraph ${index} text:`, paragraphText)
        return paragraphText
      })
      .join("\n")
  }

  if (!text && textBox["v:textbox"]) {
    const vTextbox = textBox["v:textbox"]
    Logger.debug("Found v:textbox:", JSON.stringify(vTextbox, null, 2))

    if (vTextbox["w:p"]) {
      const paragraphs = Array.isArray(vTextbox["w:p"])
        ? vTextbox["w:p"]
        : [vTextbox["w:p"]]
      text = paragraphs
        .map((p) => extractTextFromParagraph(p, documentData))
        .join("\n")
    } else if (vTextbox["#text"]) {
      text = vTextbox["#text"]
    } else if (vTextbox["w:txbxContent"]) {
      const nestedTxbxContent = vTextbox["w:txbxContent"]
      const nestedParagraphs = nestedTxbxContent["w:p"] || []
      const nestedParagraphsArray = Array.isArray(nestedParagraphs)
        ? nestedParagraphs
        : [nestedParagraphs]

      text = nestedParagraphsArray
        .map((p) => extractTextFromParagraph(p, documentData))
        .join("\n")
    }
  }

  if (!text && textBox["v:textpath"]) {
    const textPath = textBox["v:textpath"]
    if (textPath["@_string"]) {
      text = textPath["@_string"]
    }
  }

  if (!text) {
    text = extractTextRecursively(textBox)
  }

  Logger.debug("Final extracted text from textbox:", text)

  // Heuristic code detection (covers JS/TS, generic XML/HTML, and Maven POM snippets).
  if (text.trim()) {
    const codeIndicators = [
      /^\/\//m,
      /import\s+/,
      /\bclass\s+/,
      /\bfunction\s+/,
      /\bconst\s+/,
      /\blet\s+/,
      /\bvar\s+/,
      /[{};]/,
      /\(\s*\)/,
      /=\s*new\s+/,
      /<[^>]+>/,
      /<\/[^>]+>/,
      /<dependency[\s>]/i,
      /<groupId>/i,
      /<artifactId>/i,
      /<version>/i,
      /<scope>/i,
      /<systemPath>/i,
      /\$\{[^}]+\}/,
      /xmlns:/,
      /\w+:\w+/,
      /<dependency[\s\S]*?<\/dependency>/i,
      /<pre[\s>]/i,
      /<\/pre>/i,
    ]

    const isLikelyCode = codeIndicators.some((pattern) => pattern.test(text))

    Logger.debug("Is likely code:", isLikelyCode)

    if (isLikelyCode) {
      return "```\n" + text.trim() + "\n```"
    }

    return `[TEXTBOX: ${text}]`
  }

  return ""
}

function extractTextRecursively(obj: any): string {
  if (!obj || typeof obj !== "object") return ""

  let texts: string[] = []

  if (typeof obj["w:t"] === "string") {
    texts.push(obj["w:t"])
  } else if (obj["w:t"] && obj["w:t"]["#text"]) {
    texts.push(obj["w:t"]["#text"])
  }

  if (typeof obj["#text"] === "string") {
    texts.push(obj["#text"])
  }

  for (const key in obj) {
    if (typeof obj[key] === "object") {
      const nestedText = extractTextRecursively(obj[key])
      if (nestedText) texts.push(nestedText)
    } else if (Array.isArray(obj[key])) {
      for (const item of obj[key]) {
        const nestedText = extractTextRecursively(item)
        if (nestedText) texts.push(nestedText)
      }
    }
  }

  return texts.join(" ")
}

// Extracts DrawingML shape text (e.g. SmartArt) by walking a:t / a:p nodes.
function extractTextFromShape(shape: any, _documentData?: any): string {
  if (!shape) return ""

  let texts: string[] = []

  function findTextInShape(obj: any) {
    if (!obj || typeof obj !== "object") return

    if (obj["a:t"] || obj["w:t"]) {
      const text = obj["a:t"] || obj["w:t"]
      if (typeof text === "string") {
        texts.push(text)
      } else if (text["#text"]) {
        texts.push(text["#text"])
      }
    }

    if (obj["a:p"]) {
      const paragraphs = Array.isArray(obj["a:p"]) ? obj["a:p"] : [obj["a:p"]]
      for (const p of paragraphs) {
        findTextInShape(p)
      }
    }

    for (const key in obj) {
      if (typeof obj[key] === "object") {
        findTextInShape(obj[key])
      }
    }
  }

  findTextInShape(shape)

  return texts.length > 0 ? `[SHAPE: ${texts.join(" ")}]` : ""
}

// Finds the r:embed relationship id of an embedded image (w:drawing or legacy w:pict).
function extractImageRelId(element: any): string | null {
  // Namespace-agnostic walk for a blip's r:embed.
  const searchForEmbed = (obj: any): string | null => {
    if (!obj || typeof obj !== "object") return null

    if (obj["r:embed"]) return obj["r:embed"]
    if (obj["@_r:embed"]) return obj["@_r:embed"]
    if (obj.embed) return obj.embed

    for (const key in obj) {
      if (
        key.includes("blip") ||
        key.includes("Blip") ||
        key === "a:blip" ||
        key === "pic:blipFill"
      ) {
        const blip = obj[key]
        if (blip) {
          if (blip["r:embed"]) return blip["r:embed"]
          if (blip["@_r:embed"]) return blip["@_r:embed"]
          if (blip.embed) return blip.embed

          const result = searchForEmbed(blip)
          if (result) return result
        }
      }

      if (typeof obj[key] === "object") {
        const result = searchForEmbed(obj[key])
        if (result) return result
      }
    }

    return null
  }

  if (element["w:drawing"] || element.drawing) {
    const drawing = element["w:drawing"] || element.drawing
    return searchForEmbed(drawing)
  }

  if (element["w:pict"] || element.pict) {
    const pict = element["w:pict"] || element.pict
    return searchForEmbed(pict)
  }

  const runs = element["w:r"] || []
  const runsArray = Array.isArray(runs) ? runs : [runs]

  for (const run of runsArray) {
    if (!run) continue

    if (run["w:drawing"] || run.drawing) {
      const drawing = run["w:drawing"] || run.drawing
      const result = searchForEmbed(drawing)
      if (result) return result
    }

    if (run["w:pict"] || run.pict) {
      const pict = run["w:pict"] || run.pict
      const result = searchForEmbed(pict)
      if (result) return result
    }
  }

  return null
}

// Flattens the document body into ordered text/image items, recursing into SDTs.
function processDocumentContent(
  documentData: any,
  _warningCollector?: WarningCollector,
): DocxContentItem[] {
  const items: DocxContentItem[] = []

  if (!documentData?.["w:document"]?.["w:body"]) {
    Logger.warn("No document body found in DOCX")
    return items
  }

  const body = documentData["w:document"]["w:body"]
  const bodyXml = documentData.__bodyXml

  const processBodyElement = (
    elementType: string,
    element: any,
    position: number,
  ) => {
    if (!element) return

    switch (elementType) {
      case "w:p":
        // A paragraph that wraps an image is emitted as an image item, not text.
        const imageRelId = extractImageRelId(element)
        if (imageRelId) {
          Logger.debug(`Found image with relationship ID: ${imageRelId}`)
          items.push({
            type: "image",
            relId: imageRelId,
            pos: position,
          })
          return
        }

        const paragraphContent = extractCompleteTextFromParagraph(
          element,
          documentData,
        )

        if (paragraphContent.trim()) {
          items.push({
            type: "text",
            content: cleanText(paragraphContent),
            pos: position,
          })
        }
        break

      case "w:tbl":
        const tableText = extractTextFromTable(element, documentData)
        if (tableText.trim()) {
          items.push({
            type: "text",
            content: cleanText(tableText),
            pos: position,
          })
        }
        break

      case "w:sdt": // Structured Document Tag
        const sdtContent = element["w:sdtContent"]
        if (sdtContent) {
          const sdtItems = processDocumentContent({
            "w:document": { "w:body": sdtContent },
          })
          for (const item of sdtItems) {
            item.pos = position
            items.push(item)
          }
        }
        break

      case "mc:AlternateContent":
        const choice = element["mc:Choice"]
        const fallback = element["mc:Fallback"]

        const content = choice || fallback
        if (content) {
          const drawing = content["w:drawing"]
          if (drawing) {
            const imageId = extractImageRelId({ "w:drawing": drawing })
            if (imageId) {
              items.push({
                type: "image",
                relId: imageId,
                pos: position,
              })
            } else {
              const shapeText = extractTextFromShape(drawing, documentData)
              if (shapeText) {
                items.push({
                  type: "text",
                  content: cleanText(shapeText),
                  pos: position,
                })
              }
            }
          }
        }
        break

      case "w:txbxContent": // Standalone text box content
        const paragraphs = element["w:p"] || []
        const paragraphsArray = Array.isArray(paragraphs)
          ? paragraphs
          : [paragraphs]

        const textBoxText = paragraphsArray
          .map((p: any) => extractTextFromParagraph(p, documentData))
          .filter((text: string) => text.trim())
          .join("\n")

        if (textBoxText) {
          const codeIndicators = [
            /^\/\//m,
            /import\s+/,
            /\bclass\s+/,
            /\bfunction\s+/,
            /\bconst\s+/,
            /\blet\s+/,
            /\bvar\s+/,
            /[{};]/,
            /\(\s*\)/,
            /=\s*new\s+/,
            /<[^>]+>/,
            /<\/[^>]+>/,
            /<dependency>/i,
            /<groupId>/i,
            /<artifactId>/i,
            /<version>/i,
            /<scope>/i,
            /<systemPath>/i,
            /\$\{[^}]+\}/,
            /xmlns:/,
            /\w+:\w+/,
            /<dependency[\s\S]*?<\/dependency>/i,
            /<pre[\s>]/i,
            /<\/pre>/i,
          ]

          const isLikelyCode = codeIndicators.some((pattern) =>
            pattern.test(textBoxText),
          )

          const formattedText = isLikelyCode
            ? "```\n" + textBoxText.trim() + "\n```"
            : `[TEXTBOX: ${textBoxText}]`

          items.push({
            type: "text",
            content: cleanText(formattedText),
            pos: position,
          })
        }
        break
    }
  }

  // The parser drops sibling ordering across element types, so we recover document
  // order by locating each element's byte offset in the raw body XML and sorting.
  if (bodyXml) {
    const contentElements: Array<{
      type: string
      position: number
      element: any
    }> = []

    const paragraphRegex = /<w:p[\s>]/g
    let match
    let pIndex = 0
    const paragraphs = body["w:p"]
      ? Array.isArray(body["w:p"])
        ? body["w:p"]
        : [body["w:p"]]
      : []

    while ((match = paragraphRegex.exec(bodyXml)) !== null) {
      if (pIndex < paragraphs.length) {
        contentElements.push({
          type: "w:p",
          position: match.index,
          element: paragraphs[pIndex++],
        })
      }
    }

    const tableRegex = /<w:tbl[\s>]/g
    let tblIndex = 0
    const tables = body["w:tbl"]
      ? Array.isArray(body["w:tbl"])
        ? body["w:tbl"]
        : [body["w:tbl"]]
      : []

    while ((match = tableRegex.exec(bodyXml)) !== null) {
      if (tblIndex < tables.length) {
        contentElements.push({
          type: "w:tbl",
          position: match.index,
          element: tables[tblIndex++],
        })
      }
    }

    const sdtRegex = /<w:sdt[\s>]/g
    let sdtIndex = 0
    const sdts = body["w:sdt"]
      ? Array.isArray(body["w:sdt"])
        ? body["w:sdt"]
        : [body["w:sdt"]]
      : []

    while ((match = sdtRegex.exec(bodyXml)) !== null) {
      if (sdtIndex < sdts.length) {
        contentElements.push({
          type: "w:sdt",
          position: match.index,
          element: sdts[sdtIndex++],
        })
      }
    }

    const altContentRegex = /<mc:AlternateContent[\s>]/g
    let altIndex = 0
    const altContents = body["mc:AlternateContent"]
      ? Array.isArray(body["mc:AlternateContent"])
        ? body["mc:AlternateContent"]
        : [body["mc:AlternateContent"]]
      : []

    while ((match = altContentRegex.exec(bodyXml)) !== null) {
      if (altIndex < altContents.length) {
        contentElements.push({
          type: "mc:AlternateContent",
          position: match.index,
          element: altContents[altIndex++],
        })
      }
    }

    const txbxContentRegex = /<w:txbxContent[\s>]/g
    let txbxIndex = 0
    const txbxContents = body["w:txbxContent"]
      ? Array.isArray(body["w:txbxContent"])
        ? body["w:txbxContent"]
        : [body["w:txbxContent"]]
      : []

    while ((match = txbxContentRegex.exec(bodyXml)) !== null) {
      if (txbxIndex < txbxContents.length) {
        contentElements.push({
          type: "w:txbxContent",
          position: match.index,
          element: txbxContents[txbxIndex++],
        })
      }
    }

    contentElements.sort((a, b) => a.position - b.position)

    Logger.debug(`Processing ${contentElements.length} elements in XML order`)

    contentElements.forEach((item, index) => {
      Logger.debug(
        `Processing element ${index}: type=${item.type}, position=${item.position}`,
      )
      processBodyElement(item.type, item.element, index)
    })
  } else {
    // No raw XML: fall back to grouping by type (cross-type ordering is lost).
    const elementsByType: { [key: string]: any[] } = {
      "w:p": body["w:p"]
        ? Array.isArray(body["w:p"])
          ? body["w:p"]
          : [body["w:p"]]
        : [],
      "w:tbl": body["w:tbl"]
        ? Array.isArray(body["w:tbl"])
          ? body["w:tbl"]
          : [body["w:tbl"]]
        : [],
      "w:sdt": body["w:sdt"]
        ? Array.isArray(body["w:sdt"])
          ? body["w:sdt"]
          : [body["w:sdt"]]
        : [],
      "mc:AlternateContent": body["mc:AlternateContent"]
        ? Array.isArray(body["mc:AlternateContent"])
          ? body["mc:AlternateContent"]
          : [body["mc:AlternateContent"]]
        : [],
    }

    let position = 0

    for (const type in elementsByType) {
      const elements = elementsByType[type]
      elements?.forEach((element: any) => {
        processBodyElement(type, element, position++)
      })
    }
  }

  items.sort((a, b) => a.pos - b.pos)

  // Renumber to dense sequential positions.
  items.forEach((item, index) => {
    item.pos = index
  })

  Logger.debug(
    `Processed ${items.length} content items, ${items.filter((i) => i.type === "image").length} images`,
  )
  return items
}

async function extractFootnotes(
  zip: JSZip,
  parser: XMLParser,
): Promise<string> {
  try {
    const footnotesXml = zip.file("word/footnotes.xml")
    if (!footnotesXml) return ""

    const footnotesText = await footnotesXml.async("text")
    const footnotesData = parser.parse(footnotesText)
    if (!footnotesData?.["w:footnotes"]?.["w:footnote"]) return ""

    const footnotes = footnotesData["w:footnotes"]["w:footnote"]
    const footnotesArray = Array.isArray(footnotes) ? footnotes : [footnotes]

    return footnotesArray
      .map((footnote) => {
        const id = footnote["@_w:id"]
        if (!id || id === "-1" || id === "0") return "" // Skip separator and continuation footnotes

        const paragraphs = footnote["w:p"] || []
        const paragraphsArray = Array.isArray(paragraphs)
          ? paragraphs
          : [paragraphs]

        const content = paragraphsArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()

        return content ? `[^${id}]: ${content}` : ""
      })
      .filter((f) => f)
      .join("\n")
  } catch (error) {
    Logger.warn(
      `Could not extract footnotes: ${error instanceof Error ? error.message : error}`,
    )
    return ""
  }
}

async function extractEndnotes(zip: JSZip, parser: XMLParser): Promise<string> {
  try {
    const endnotesXml = zip.file("word/endnotes.xml")
    if (!endnotesXml) return ""

    const endnotesText = await endnotesXml.async("text")
    const endnotesData = parser.parse(endnotesText)
    if (!endnotesData?.["w:endnotes"]?.["w:endnote"]) return ""

    const endnotes = endnotesData["w:endnotes"]["w:endnote"]
    const endnotesArray = Array.isArray(endnotes) ? endnotes : [endnotes]

    return endnotesArray
      .map((endnote) => {
        const id = endnote["@_w:id"]
        if (!id || id === "-1" || id === "0") return "" // Skip separator and continuation endnotes

        const paragraphs = endnote["w:p"] || []
        const paragraphsArray = Array.isArray(paragraphs)
          ? paragraphs
          : [paragraphs]

        const content = paragraphsArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()

        return content ? `[^endnote-${id}]: ${content}` : ""
      })
      .filter((f) => f)
      .join("\n")
  } catch (error) {
    Logger.warn(
      `Could not extract endnotes: ${error instanceof Error ? error.message : error}`,
    )
    return ""
  }
}

async function extractHeadersAndFooters(
  zip: JSZip,
  parser: XMLParser,
): Promise<string> {
  let headerFooter = ""

  try {
    // header1..3 / footer1..3 cover default, even, and first-page variants.
    for (let i = 1; i <= 3; i++) {
      const headerFile = zip.file(`word/header${i}.xml`)
      if (headerFile) {
        const headerText = await headerFile.async("text")
        const headerData = parser.parse(headerText)
        if (headerData?.["w:hdr"]) {
          const hdr = headerData["w:hdr"]

          const headerContent: string[] = []

          if (hdr["w:p"]) {
            const paragraphs = Array.isArray(hdr["w:p"])
              ? hdr["w:p"]
              : [hdr["w:p"]]
            for (const p of paragraphs) {
              const text = extractTextFromParagraph(p)
              if (text.trim()) headerContent.push(text)
            }
          }

          if (hdr["w:tbl"]) {
            const tables = Array.isArray(hdr["w:tbl"])
              ? hdr["w:tbl"]
              : [hdr["w:tbl"]]
            for (const tbl of tables) {
              const text = extractTextFromTable(tbl)
              if (text.trim()) headerContent.push(text)
            }
          }

          if (headerContent.length > 0) {
            headerFooter += `Header (${i}):\n${headerContent.join("\n")}\n\n`
          }
        }
      }
    }

    for (let i = 1; i <= 3; i++) {
      const footerFile = zip.file(`word/footer${i}.xml`)
      if (footerFile) {
        const footerText = await footerFile.async("text")
        const footerData = parser.parse(footerText)
        if (footerData?.["w:ftr"]) {
          const ftr = footerData["w:ftr"]

          const footerContent: string[] = []

          if (ftr["w:p"]) {
            const paragraphs = Array.isArray(ftr["w:p"])
              ? ftr["w:p"]
              : [ftr["w:p"]]
            for (const p of paragraphs) {
              const text = extractTextFromParagraph(p)
              if (text.trim()) footerContent.push(text)
            }
          }

          if (ftr["w:tbl"]) {
            const tables = Array.isArray(ftr["w:tbl"])
              ? ftr["w:tbl"]
              : [ftr["w:tbl"]]
            for (const tbl of tables) {
              const text = extractTextFromTable(tbl)
              if (text.trim()) footerContent.push(text)
            }
          }

          if (footerContent.length > 0) {
            headerFooter += `Footer (${i}):\n${footerContent.join("\n")}\n\n`
          }
        }
      }
    }
  } catch (error) {
    Logger.warn(
      `Could not extract headers/footers: ${error instanceof Error ? error.message : error}`,
    )
  }

  return headerFooter
}

// Maps relationship Id → target path (normalized to be relative to word/).
function parseRelationships(relsData: any): Map<string, string> {
  const relationships = new Map<string, string>()

  if (!relsData?.Relationships?.Relationship) {
    return relationships
  }

  const rels = relsData.Relationships.Relationship
  const relsArray = Array.isArray(rels) ? rels : [rels]

  for (const rel of relsArray) {
    if (rel["@_Id"] && rel["@_Target"]) {
      let target = rel["@_Target"]
      if (target.startsWith("/")) target = target.substring(1)
      if (target.startsWith("word/")) target = target.substring(5)

      relationships.set(rel["@_Id"], target)
    }
  }

  return relationships
}

// Chunks text items, appending to the result arrays, and returns trailing overlap text.
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

  // Take the last overlapBytes of text so chunks stay continuous across images.
  let overlapText = ""
  let overlapLen = 0
  for (let i = cleanedText.length - 1; i >= 0; i--) {
    const char = cleanedText[i]
    if (char === undefined) continue
    const charBytes = Buffer.byteLength(char, "utf8")
    if (overlapLen + charBytes > overlapBytes) break
    overlapText = char + overlapText
    overlapLen += charBytes
  }

  return { nextPos: currentPos, overlapText }
}

export async function extractTextAndImagesWithChunksFromDocx(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = false,
  describeImages: boolean = true,
  logWarnings: boolean = false,
): Promise<DocxProcessingResult> {
  Logger.info(`Starting DOCX processing for document: ${docid}`)

  const warningCollector = new WarningCollector()

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected DOCX, skipping")
      warningCollector.addWarning({
        type: "general",
        message: "Password protected DOCX file",
        context: { error: message },
      })
    } else {
      Logger.error(error, `DOCX load error: ${error}`)
      warningCollector.addWarning({
        type: "general",
        message: "Failed to load DOCX file",
        context: { error: message },
      })
    }
    warningCollector.logSummary()
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
    const documentXml = await zip.file("word/document.xml")?.async("text")
    if (!documentXml) {
      throw new Error("Could not find word/document.xml in DOCX file")
    }

    // Capture raw body XML up front; processDocumentContent uses it to recover order.
    const bodyMatch = documentXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/)
    const bodyXml = bodyMatch ? bodyMatch[1] : ""

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      trimValues: false, // Preserve significant whitespace in text nodes.
    })

    const documentData = parser.parse(documentXml)
    documentData.__bodyXml = bodyXml

    let relationships: Map<string, string> | null = null
    const relsXml = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("text")
    if (relsXml) {
      const relsData = parser.parse(relsXml)
      relationships = parseRelationships(relsData)
      // Stashed on documentData so hyperlink extraction can resolve r:id → href.
      documentData.__rels = relationships
    }

    let commentsMap: Map<string, string> = new Map()
    const commentsXml = await zip.file("word/comments.xml")?.async("text")
    if (commentsXml) {
      const commentsData = parser.parse(commentsXml)
      const comments = commentsData?.["w:comments"]?.["w:comment"]
      const commentsArray = Array.isArray(comments) ? comments : [comments]
      for (const comment of commentsArray) {
        const id = comment["@_w:id"]
        const commentParas = comment["w:p"] || []
        const commentParasArray = Array.isArray(commentParas)
          ? commentParas
          : [commentParas]
        const text = commentParasArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()
        if (id && text) {
          commentsMap.set(id, text)
        }
      }
    }
    documentData.__comments = commentsMap

    const contentItems = processDocumentContent(documentData, warningCollector)

    const footnotes = await extractFootnotes(zip, parser)
    const endnotes = await extractEndnotes(zip, parser)
    const headerFooter = await extractHeadersAndFooters(zip, parser)

    let text_chunks: string[] = []
    let image_chunks: string[] = []
    let text_chunk_pos: number[] = []
    let image_chunk_pos: number[] = []

    let globalSeq = 0
    let crossImageOverlap = ""

    const imageSeqToHash = new Map<number, string>()
    imageDescribeBatch = new DeferredImageDescriptionBatch()

    let textBuffer: string[] = []
    let textStartPos = globalSeq

    const flushTextBuffer = () => {
      if (textBuffer.length > 0) {
        // Prepend the previous chunk's tail so text reads continuously across an image.
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
      if (item.type === "text" && item.content) {
        textBuffer.push(item.content)
      } else if (
        item.type === "image" &&
        item.relId &&
        extractImages &&
        relationships
      ) {
        flushTextBuffer()

        const imagePath = relationships.get(item.relId)
        if (imagePath) {
          try {
            const fullImagePath = `word/${imagePath}`
            const imageFile = zip.file(fullImagePath)

            if (imageFile) {
              const imageBuffer = await imageFile.async("nodebuffer")

              // Skip tiny images (icons, bullets, spacers).
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
              textStartPos = globalSeq

              Logger.debug(`Successfully processed image: ${imagePath}`)
            } else {
              Logger.warn(`Could not find image file: ${fullImagePath}`)
            }
          } catch (error) {
            Logger.warn(
              `Failed to process image ${imagePath}: ${error instanceof Error ? error.message : error}`,
            )
          }
        } else {
          Logger.warn(`Could not resolve relationship ID: ${item.relId}`)
        }
      }
    }

    // Flush trailing text plus any leftover cross-image overlap.
    if (textBuffer.length > 0 || crossImageOverlap) {
      const textContent = textBuffer.length > 0 ? textBuffer.join("\n") : ""
      const combinedText = crossImageOverlap
        ? crossImageOverlap + " " + textContent
        : textContent

      if (combinedText.trim()) {
        const { nextPos } = processTextItems(
          [combinedText],
          text_chunks,
          text_chunk_pos,
          textStartPos,
        )
        globalSeq = nextPos
        crossImageOverlap = ""
      }
    }

    // Footnotes/endnotes/headers/footers are appended after the body.
    const additionalContent = [footnotes, endnotes, headerFooter]
      .filter(Boolean)
      .join("\n\n")

    if (additionalContent.trim()) {
      const postProcessedContent = postProcessText(additionalContent)
      const finalContent = crossImageOverlap
        ? crossImageOverlap + " " + postProcessedContent
        : postProcessedContent
      const { nextPos } = processTextItems(
        [finalContent],
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )
      globalSeq = nextPos
      crossImageOverlap = ""
    }

    if (commentsMap.size > 0) {
      const commentFootnotes = Array.from(commentsMap.entries()).map(
        ([id, text]) => `[^comment-${id}]: ${text}`,
      )
      const postProcessed = postProcessText(commentFootnotes.join("\n"))
      const finalContent = crossImageOverlap
        ? crossImageOverlap + " " + postProcessed
        : postProcessed
      const { nextPos } = processTextItems(
        [finalContent],
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )
      globalSeq = nextPos
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
      `DOCX processing completed. Total text chunks: ${text_chunks.length}, Total image chunks: ${image_chunks.length}`,
    )

    if (logWarnings) {
      warningCollector.logSummary()
    }

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
    // @ts-ignore
    zip = null
  }
}
