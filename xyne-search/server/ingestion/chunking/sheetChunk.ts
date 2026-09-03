import * as XLSX from "xlsx"

// Cell type-detection utilities, used by header-row inference.
function isTimestamp(value: any): boolean {
  if (typeof value === 'string') {
    const timestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/
    if (timestampRegex.test(value)) {
      return !isNaN(Date.parse(value))
    }

    const numValue = Number(value)
    if (!isNaN(numValue)) {
      // Accept Unix epoch values only within a sane 1970–2100 window.
      const minTimestamp = 0
      const maxTimestamp = 4102444800000 // 2100-01-01 in ms
      return numValue >= minTimestamp && numValue <= maxTimestamp
    }
  }

  if (value instanceof Date) {
    return !isNaN(value.getTime())
  }

  return false
}

function isDate(value: any): boolean {
  if (typeof value === 'string') {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{1,2}-\d{1,2}-\d{4}$/
    if (dateRegex.test(value)) {
      return !isNaN(Date.parse(value))
    }
  }
  
  if (value instanceof Date) {
    return !isNaN(value.getTime())
  }
  
  return false
}

function isTime(value: any): boolean {
  if (typeof value === 'string') {
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/
    return timeRegex.test(value)
  }
  
  return false
}

function isBoolean(value: any): boolean {
  if (typeof value === 'boolean') {
    return true
  }
  
  if (typeof value === 'string') {
    const lowerValue = value.toLowerCase().trim()
    return ['true', 'false', 'yes', 'no', 'y', 'n'].includes(lowerValue)
  }
  
  return false
}

interface ChunkConfig {
  maxChunkSize?: number
  maxRowsPerChunk?: number
  headerRows?: number
}

interface ChunkingState {
  headerRow: string
  maxRowsPerChunk: number
  maxChunkSize: number
  columnCount: number
}

interface ProcessedSheetData {
  headerRow: string[]
  dataRows: string[][]
}

// XLSX Processing Functions

function unmerge(sheet: XLSX.WorkSheet): void {
  (sheet['!merges'] ?? []).forEach((rng) => {
    const v = sheet[XLSX.utils.encode_cell({ r: rng.s.r, c: rng.s.c })]?.v
    for (let R = rng.s.r; R <= rng.e.r; R++) {
      for (let C = rng.s.c; C <= rng.e.c; C++) {
        sheet[XLSX.utils.encode_cell({ r: R, c: C })] = { t: "s", v }
      }
    }
  })
}

function buildHeaders(rows: any[][], headerRows = 1): { header: string[], dataRows: any[][] } {
  if (rows.length === 0) {
    return { header: [], dataRows: [] }
  }

  const header = rows.slice(0, headerRows)
    .reduce((acc, row) =>
      acc.map((prev, i) => `${prev}_${(row[i] ?? "").toString().trim()}`),
      new Array(rows[0]?.length ?? 0).fill("")
    )
    .map(h => h.replace(/_{2,}/g, "_").replace(/^_+|_+$/g, ""))

  return { 
    header, 
    dataRows: rows.slice(headerRows) 
  }
}

function guessHeaderRowsByDataTypes(rows: any[][], maxSearchRows = 3): number {
  const isHeterogeneousRow = (row: any[]) => {
    const types = row
      .filter(cell => cell !== null && cell !== undefined && cell.toString().trim() !== '')
      .map(cell => {
        if (typeof cell === 'number' || !isNaN(Number(cell)))
          return 'number'
        if (isDate(cell))
          return 'date'
        if (isTimestamp(cell))
          return 'timestamp'
        if (isTime(cell))
          return 'time'
        if (isBoolean(cell))
          return 'boolean'
        return 'string'
      })

    const uniqueTypes = new Set(types)
    return uniqueTypes.size >= 2
  }

  for (let i = 0; i < Math.min(maxSearchRows, rows.length); i++) {
    const row = rows[i]
    if (!row) continue
    // First heterogeneous row is data; everything above it is header.
    if (isHeterogeneousRow(row)) {
      return i
    }
  }

  return 1
}


function guessHeaderRowsByKeywords(rows: any[][], maxSearchRows = 3): number {
  const headerKeywords = ['name', 'id', 'date', 'type', 'category', 'description', 'amount', 'total', 'value', 'region', 'country', 'state', 'city', 'zip', 'address', 'phone', 'email', 'website', 'url', 'link', 'title', 'subtitle', 'summary', 'description', 'notes', 'comments', 'remarks', 'details', 'information', 'data', 'statistics', 'metrics', 'measures']
  const lowerKeywords = headerKeywords.map(k => k.toLowerCase())
  
  for (let i = 0; i < Math.min(maxSearchRows, rows.length); i++) {
    const row = rows[i]
    if (!row) continue
    
    const rowText = row.map(cell => (cell ?? '').toString().toLowerCase())

    const keywordMatches = rowText.filter(cell =>
      lowerKeywords.some(kw => cell.includes(kw))
    ).length

    // Require most cells (>=60%) to match so a stray keyword in data isn't read as a header.
    const totalCells = rowText.filter(cell => cell.trim().length > 0).length
    if (totalCells > 0 && keywordMatches >= Math.ceil(totalCells * 0.6)) {
      return i + 1
    }
  }
  return 1
}

// Drop columns that are empty or sparse (under SPARSE_THRESHOLD non-empty cells).
function removeEmptyColumns(rows: any[][]): any[][] {
  if (rows.length === 0) return rows

  const maxColumns = Math.max(...rows.map(row => row.length), 0)
  if (maxColumns === 0) return rows

  const SPARSE_THRESHOLD = 0.05

  const columnsToRemove = new Set<number>()

  for (let colIndex = 0; colIndex < maxColumns; colIndex++) {
    let nonEmptyCount = 0
    let totalCells = rows.length

    for (const row of rows) {
      const cell = row[colIndex]

      if (cell !== undefined && cell !== null && cell !== "") {
        const cellStr = cell.toString().trim()
        if (cellStr.length > 0) {
          nonEmptyCount++
        }
      }
    }

    const nonEmptyRatio = nonEmptyCount / totalCells

    if (nonEmptyRatio < SPARSE_THRESHOLD) {
      columnsToRemove.add(colIndex)
    }
  }

  if (columnsToRemove.size === 0) {
    return rows
  }

  const filteredRows = rows.map(row =>
    row.filter((_, colIndex) => !columnsToRemove.has(colIndex))
  )

  return filteredRows
}

// Infer header-row count by combining merged-cell, data-type, and keyword heuristics.
function inferHeaderRows(input: XLSX.WorkSheet, rows: any[][], isDummyHeader = false): number {
  let mergedHeaderRows = 1

  // Merges starting in the header area (rows < 4) hint at how many header rows there are.
  const merges = input['!merges'] ?? []
  let maxHeaderMergeRow = -1

  merges.forEach(rng => {
    if (rng.s.r < 4 && rng.s.r > maxHeaderMergeRow) {
      maxHeaderMergeRow = rng.s.r
    }
  })
  mergedHeaderRows = maxHeaderMergeRow >= 0 ? maxHeaderMergeRow + 2 : 1
  mergedHeaderRows += isDummyHeader ? 1 : 0

  if (rows.length === 0) return 1

  const MAX_HEADER_ROWS = isDummyHeader ? 4 : 3

  const dataTypeHeaderRows = guessHeaderRowsByDataTypes(rows, MAX_HEADER_ROWS)
  const keywordHeaderRows = guessHeaderRowsByKeywords(rows, MAX_HEADER_ROWS)

  // Take the most aggressive heuristic, capped at MAX_HEADER_ROWS.
  const inferredRows = Math.max(mergedHeaderRows, dataTypeHeaderRows, keywordHeaderRows, 1)
  return Math.min(inferredRows, MAX_HEADER_ROWS)
}

function processSheetData(input: XLSX.WorkSheet, headerRowsParam?: number): ProcessedSheetData {
  const MAX_COLUMNS = 100
  let rows: any[][] = []
  try {
    rows = XLSX.utils.sheet_to_json<any[]>(input, {
      header: 1,        // array-of-arrays output
      raw: false,       // formatted strings, not raw values
      defval: "",       // empty string for null/undefined cells
      blankrows: false,
    })
  } catch (error) {
    console.error("Error converting sheet to JSON:", error)
    return { headerRow: [], dataRows: [] }
  }

  // Strip empty columns first so header inference sees a clean grid.
  rows = removeEmptyColumns(rows)

  const maxColumns = Math.max(...rows.map(row => row.length), 0)
  if (maxColumns > MAX_COLUMNS) {
    console.warn(`[processSheetData] Sheet has ${maxColumns} columns, exceeding maximum of ${MAX_COLUMNS}. Truncating to first ${MAX_COLUMNS} columns.`)
    rows = rows.map(row => row.slice(0, MAX_COLUMNS))
  }
  
  let headerRows = headerRowsParam ?? inferHeaderRows(input, rows)
  
  if (rows.length === 0) {
    return { headerRow: [], dataRows: [] }
  }

  // No usable header detected: synthesize C1, C2, ... and re-infer with the dummy row.
  const isHeaderValid = rows.slice(0, headerRows).every(row => isHeaderRowValid(row))
  if (!isHeaderValid) {
    const maxColumns = Math.max(...rows.map(row => row.length))
    const header = Array.from({ length: maxColumns }, (_, i) => `C${i + 1}`)
    rows = [header, ...rows]
    headerRows = inferHeaderRows(input, rows, true)
  }

  const result = buildHeaders(rows, headerRows)
  const header = result.header
  const dataRows = result.dataRows

  // Filter empty rows before assigning row_ids so IDs stay contiguous.
  const validDataRows = dataRows.filter(isRowValid)

  const fullHeader = ["row_id", ...header]
  const rowsWithId = validDataRows.map((row, index) => [
    (index + 1).toString(),
    ...row.map(cell => (cell ?? "").toString())
  ])

  rows = []

  return {
    headerRow: fullHeader,
    dataRows: rowsWithId
  }
}

// Helper Functions

const getByteLength = (str: string): number => Buffer.byteLength(str, "utf8")

// Strip illegal control chars and normalize line endings.
const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

// Pad/truncate a row to columnCount and clean each cell, tab-joined.
function normalizeRow(row: string[], columnCount: number): string {
  const normalizedCells: string[] = []

  for (let i = 0; i < columnCount; i++) {
    const cell = row[i]
    if (cell === undefined || cell === null) {
      normalizedCells.push("")
    } else {
      const cellStr = cell.toString()
      const cleanedCell = cleanText(cellStr)
      normalizedCells.push(cleanedCell)
    }
  }
  
  return normalizedCells.join("\t")
}

// True if the row has at least one non-empty cell.
function isRowValid(row: string[]): boolean {
  if (!Array.isArray(row) || row.length === 0) return false

  return row.some(cell => {
    if (cell === undefined || cell === null || cell === "") return false
    const cellStr = cell.toString().trim()
    return cellStr.length > 0
  })
}

// True only if every cell is filled (a header must have no gaps).
function isHeaderRowValid(row: any[]): boolean {
  if (!Array.isArray(row) || row.length === 0) return false

  return row.every(cell => {
    if (cell === undefined || cell === null) return false
    const cellStr = cell.toString().trim()
    return cellStr.length > 0
  })
}

// Truncate to a byte limit without splitting a multi-byte character.
function truncateToByteLength(str: string, limit: number): string {
  let bytes = 0
  let result = ''
  
  for (const char of str) {
    const charBytes = getByteLength(char)
    if (bytes + charBytes > limit) break
    result += char
    bytes += charBytes
  }
  
  return result
}

// Pack rows into chunks bounded by both row count and byte size.
function createChunks(dataRows: string[][], state: ChunkingState): string[] {
  const chunks: string[] = []
  let currentBatch: string[] = []

  for (const row of dataRows) {
    const normalizedRow = normalizeRow(row, state.columnCount)
    
    const potentialChunk = createChunkFromBatch(
      [...currentBatch, normalizedRow],
      state.headerRow
    )

    const wouldExceedRowLimit = currentBatch.length >= state.maxRowsPerChunk
    const wouldExceedSizeLimit = getByteLength(potentialChunk) > state.maxChunkSize

    if ((wouldExceedRowLimit || wouldExceedSizeLimit) && currentBatch.length > 0) {
      chunks.push(createChunkFromBatch(currentBatch, state.headerRow))

      // A single oversized row can't fit with the header, so truncate it to its own chunk.
      if (getByteLength(normalizedRow) > state.maxChunkSize) {
        const truncatedRow = truncateToByteLength(
          normalizedRow,
          state.maxChunkSize - getByteLength(state.headerRow) - 1
        )
        chunks.push(createChunkFromBatch([truncatedRow], state.headerRow))
        currentBatch = []
      } else {
        currentBatch = [normalizedRow]
      }
    } else {
      currentBatch.push(normalizedRow)
    }
  }

  if (currentBatch.length > 0) {
    chunks.push(createChunkFromBatch(currentBatch, state.headerRow))
  }

  return chunks
}

function createChunkFromBatch(batch: string[], headerRow: string): string {
  if (batch.length === 0) return headerRow
  return [headerRow, ...batch].join("\n")
}

function normalizeToWorksheet(input: string[][] | XLSX.WorkSheet): XLSX.WorkSheet {
  if (Array.isArray(input)) {
    return XLSX.utils.aoa_to_sheet(input)
  }
  return input
}

// Main Export Functions

/**
 * Chunk spreadsheet data (XLSX WorkSheet or string[][]) with the header repeated per chunk.
 * Handles multi-row/merged headers, adds a row_id column, and chunks adaptively for wide sheets.
 */
export function chunkSheetWithHeaders(
  input: string[][] | XLSX.WorkSheet,
  config?: ChunkConfig,
): string[] {
  let worksheet: XLSX.WorkSheet | null = null
  let processedData: ProcessedSheetData | null = null
  
  try {
    worksheet = normalizeToWorksheet(input)
    unmerge(worksheet)
    processedData = processSheetData(worksheet, config?.headerRows)
    const { headerRow, dataRows } = processedData

    if (headerRow.length === 0) {
      return []
    }

    const maxChunkSize = config?.maxChunkSize ?? 1024
    const maxRowsPerChunk = config?.maxRowsPerChunk ?? 10

    const columnCount = headerRow.length

    // Wide sheets cost more bytes per row, so pack fewer rows per chunk.
    const adaptiveMaxRowsPerChunk = columnCount > 15
      ? Math.max(3, Math.floor(maxRowsPerChunk * 0.6))
      : maxRowsPerChunk

    const state: ChunkingState = {
      headerRow: normalizeRow(headerRow, columnCount),
      maxRowsPerChunk: adaptiveMaxRowsPerChunk,
      maxChunkSize,
      columnCount,
    }

    if (dataRows.length === 0) {
      return [state.headerRow]
    }

    const chunks = createChunks(dataRows, state)

    processedData = null

    return chunks
  } finally {
    // Only tear down worksheets we created here (from an array input).
    if (Array.isArray(input) && worksheet) {
      const keys = Object.keys(worksheet)
      for (const key of keys) {
        delete worksheet[key]
      }
      worksheet = null
    }
  }
}
