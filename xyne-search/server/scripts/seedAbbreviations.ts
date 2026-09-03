/**
 * Seed script for abbreviation table.
 * Run with: bun run scripts/seedAbbreviations.ts
 *
 * Reads abbreviation_with_full_forms.csv from the project root and inserts
 * records into the abbreviation table.
 */

import { db } from "@/platform/db/client"
import { abbreviations } from "@/platform/db/schema/abbreviation"
import { sql } from "drizzle-orm"
import * as fs from "fs"
import * as path from "path"

const CSV_PATH = path.join(process.cwd(), "..", "abbreviation_with_full_forms.csv")

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found at ${CSV_PATH}`)
    process.exit(1)
  }

  const content = fs.readFileSync(CSV_PATH, "utf-8")
  const lines = content.split("\n").filter((l) => l.trim())
  const dataLines = lines.slice(1)

  console.log(`Seeding ${dataLines.length} abbreviations…`)

  // Clear existing data
  await db.execute(sql`TRUNCATE TABLE abbreviation RESTART IDENTITY`)

  const BATCH = 500
  let inserted = 0

  for (let i = 0; i < dataLines.length; i += BATCH) {
    const batch = dataLines.slice(i, i + BATCH)
    const rows = batch
      .map((line) => {
        const cols = parseCSVLine(line)
        if (cols.length < 7) return null
        const word = cols[0]?.trim() ?? ""
        const fullForm = cols[1]?.trim() ?? ""
        const votes = parseInt(cols[2] ?? "0", 10) || 0
        const totalDefs = parseInt(cols[3] ?? "0", 10) || 0
        const altCount = parseInt(cols[4] ?? "0", 10) || 0
        const exampleDocId = cols[5]?.trim() || null
        const allFullForms = cols[6]?.trim() || null
        if (!word || !fullForm) return null
        return { word, fullForm, votes, totalDefs, altCount, exampleDocId, allFullForms }
      })
      .filter(Boolean) as {
      word: string
      fullForm: string
      votes: number
      totalDefs: number
      altCount: number
      exampleDocId: string | null
      allFullForms: string | null
    }[]

    if (rows.length > 0) {
      await db.insert(abbreviations).values(rows)
      inserted += rows.length
    }
  }

  console.log(`✓ Inserted ${inserted} abbreviation records`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
