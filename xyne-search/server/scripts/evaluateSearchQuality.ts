import { searchVespa, GetRandomDocument } from "@/platform/search/vespa"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import {
  fileSchema,
  mailSchema,
  userSchema,
  eventSchema,
  mailAttachmentSchema,
} from "@xyne/vespa-ts/types"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { SearchModes } from "@xyne/vespa-ts/types"

const Logger = getLogger(Subsystem.Eval)

const USER_EMAIL_FOR_SEARCH = process.env.EVALUATION_USER_EMAIL

if (!USER_EMAIL_FOR_SEARCH) {
  Logger.error("Error: Environment variable EVALUATION_USER_EMAIL is not set.")
  Logger.error("This email is required for permission-aware search evaluation.")
  Logger.error(
    "Please set it and run the script again. Example: EVALUATION_USER_EMAIL='user@example.com' bun run ...",
  )
  process.exit(1)
}

Logger.info(`Using email for search evaluation: ${USER_EMAIL_FOR_SEARCH}`)

const NUM_SAMPLES = parseInt(process.env.NUM_SAMPLES || "100", 10)
const NUM_RUNS = parseInt(process.env.EVALUATION_NUM_RUNS || "3", 10)
const MAX_RANK_TO_CHECK = parseInt(process.env.MAX_RANK_TO_CHECK || "100", 10)
const HITS_PER_PAGE = 10
const VESPA_NAMESPACE = "namespace" // TODO: Replace with your actual Vespa namespace
const VESPA_CLUSTER_NAME = "my_content" // TODO: Replace with your actual cluster name
const DELAY_MS = parseInt(process.env.EVALUATION_DELAY_MS || "15", 10)
const ENABLE_TRACE = process.env.ENABLE_TRACE === "true"
const DEBUG_POOR_RANKINGS = process.env.DEBUG_POOR_RANKINGS === "true"
const POOR_RANK_THRESHOLD = parseInt(
  process.env.POOR_RANK_THRESHOLD || "10",
  10,
)

const OUTPUT_DIR = path.join(__dirname, "..", "eval-results", "search-quality")

function ensureDirectoryExists(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    Logger.info(`Creating output directory: ${dirPath}`)
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

// sddocname -> id/title/body field names per schema
const schemaFieldMap: Record<
  string,
  { idField: string; titleField: string; bodyField?: string }
> = {
  [fileSchema]: { idField: "docId", titleField: "title", bodyField: "chunks" },
  [mailSchema]: {
    idField: "docId",
    titleField: "subject",
    bodyField: "chunks",
  },
  [userSchema]: { idField: "docId", titleField: "name" },
  [eventSchema]: {
    idField: "docId",
    titleField: "name",
    bodyField: "description",
  },
  [mailAttachmentSchema]: {
    idField: "docId",
    titleField: "filename",
    bodyField: "chunks",
  },
}

interface VespaFields extends Record<string, any> {
  sddocname?: string
}

interface Document {
  id: string
  fields: VespaFields
}

interface SampleResult {
  docId: string
  schema: string
  title: string
  rank: number | null
  query: string
}

interface DebugFailureInfo {
  docId: string
  query: string
  foundAtRank: number | null
  debugInfo: {
    query: string
    docIdToFind: string
    topResults: Array<{
      rank: number | null
      schema: string
      title: string
      docId: string
      matchDetails: Record<string, any>
    }>
    trace: any
  }
}

interface SchemaAnalysis {
  schema: string
  totalDocuments: number
  notFoundCount: number
  poorRankingCount: number
  commonIssues: Record<string, number>
  examples: Array<{
    query: string
    docId: string
    foundAtRank: number | null
    likelyIssue: string
    topResults: Array<any>
  }>
}

export const EvaluationStrategy = {
  ExactTitle: "ExactTitle",
  BodyPhrase: "BodyPhrase",
  RandomTitleWords: "RandomTitleWords",
} as const
export type EvaluationStrategy =
  (typeof EvaluationStrategy)[keyof typeof EvaluationStrategy]

const CURRENT_STRATEGY: EvaluationStrategy =
  (process.env.EVALUATION_STRATEGY as EvaluationStrategy) ||
  EvaluationStrategy.ExactTitle

function generateSearchQuery(
  document: Document,
  strategy: EvaluationStrategy,
): string | null {
  const fields = document.fields as VespaFields
  const sddocname = fields.sddocname

  if (!sddocname || !schemaFieldMap[sddocname]) {
    Logger.warn(
      { docId: document.id, sddocname },
      "Cannot generate query: Unknown schema",
    )
    return null
  }

  const { titleField, bodyField } = schemaFieldMap[sddocname]
  const title = fields[titleField] as string | undefined

  switch (strategy) {
    case EvaluationStrategy.ExactTitle: {
      if (typeof title !== "string" || title.trim() === "") {
        Logger.warn(
          { docId: document.id, sddocname, titleField },
          `Cannot generate ExactTitle query: Missing or invalid title field ('${titleField}')`,
        )
        return null
      }
      return title
    }

    case EvaluationStrategy.BodyPhrase: {
      if (!bodyField) {
        Logger.warn(
          { docId: document.id, sddocname },
          `Cannot generate BodyPhrase query: No bodyField defined for schema '${sddocname}'`,
        )
        return null
      }
      const bodyFieldValue = fields[bodyField]
      let bodyText: string | undefined

      if (bodyField === "chunks") {
        if (Array.isArray(bodyFieldValue) && bodyFieldValue.length > 0) {
          bodyText = bodyFieldValue.map(String).join("\\n")
        } else {
          Logger.warn(
            { docId: document.id, sddocname, bodyField },
            `Cannot generate BodyPhrase query: Field '${bodyField}' is not a non-empty array or is empty.`,
          )
          return null
        }
      } else {
        bodyText = bodyFieldValue as string | undefined
      }

      if (typeof bodyText !== "string" || bodyText.trim() === "") {
        Logger.warn(
          { docId: document.id, sddocname, bodyField },
          `Cannot generate BodyPhrase query: Missing or invalid body content after processing field ('${bodyField}')`,
        )
        return null
      }
      const words = bodyText
        .trim()
        .split(/\\s+/)
        .filter((w) => w.length > 0)
      const phrase = words.slice(0, 6).join(" ")
      if (phrase.length < 5) {
        Logger.warn(
          { docId: document.id, sddocname, bodyField, phrase },
          `Cannot generate BodyPhrase query: Extracted phrase too short ('${phrase}')`,
        )
        return null
      }
      return phrase
    }

    case EvaluationStrategy.RandomTitleWords: {
      if (typeof title !== "string" || title.trim() === "") {
        Logger.warn(
          { docId: document.id, sddocname, titleField },
          `Cannot generate RandomTitleWords query: Missing or invalid title field ('${titleField}')`,
        )
        return null
      }
      const words = title
        .trim()
        .split(/\\s+/)
        .filter((w) => w.length > 0)
      const minWords = 3

      if (words.length < minWords) {
        Logger.warn(
          { docId: document.id, sddocname, title, wordCount: words.length },
          `Cannot generate RandomTitleWords query: Title has fewer than ${minWords} words.`,
        )
        return null
      }

      const numWordsToSelect = minWords
      // Fisher-Yates shuffle, then take first N as a random sample without replacement
      for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const wi = words[i]
        const wj = words[j]
        if (wi === undefined || wj === undefined) {
          continue
        }
        words[i] = wj
        words[j] = wi
      }
      const selectedWords = words.slice(0, numWordsToSelect)

      return selectedWords.join(" ")
    }

    default:
      const exhaustiveCheck: never = strategy
      Logger.warn(
        { strategy: exhaustiveCheck },
        "Unsupported evaluation strategy encountered in generateSearchQuery",
      )
      return null
  }
}

async function getRandomDocument(): Promise<Document | null> {
  const schemas = Object.keys(schemaFieldMap)
  const targetSchema = schemas[Math.floor(Math.random() * schemas.length)]
  if (!targetSchema) {
    Logger.warn("No schemas available to fetch a random document")
    return null
  }
  Logger.debug(`Fetching random document from schema: ${targetSchema}...`)

  try {
    const doc = await GetRandomDocument(
      VESPA_NAMESPACE,
      targetSchema,
      VESPA_CLUSTER_NAME,
    )

    if (!doc || !doc.id || !doc.fields) {
      Logger.warn(
        { responseData: doc },
        "Received unexpected data structure from GetRandomDocument",
      )
      return null
    }

    // Vespa id format: "id:namespace:schema::user_id"
    const idParts = doc.id.split("::")
    const userId = idParts[1] || doc.fields.docId || doc.id
    const sddocname = doc.id.split(":")[2] || targetSchema

    return {
      id: userId,
      fields: {
        ...(doc.fields as Record<string, any>),
        sddocname,
      },
    }
  } catch (error) {
    Logger.error(
      { error, schema: targetSchema },
      "Failed to get random document",
    )
    return null
  }
}

async function findDocumentRank(
  docIdToFind: string,
  query: string,
): Promise<{ rank: number | null; debugPayload: DebugFailureInfo | null }> {
  Logger.debug({ docIdToFind, query }, "findDocumentRank called with:")

  let rank: number | null = null
  let offset = 0
  let totalCount = 0
  let response: any
  let collectedDebugInfo: DebugFailureInfo | null = null

  try {
    while (offset < MAX_RANK_TO_CHECK) {
      const searchOptions = {
        limit: HITS_PER_PAGE,
        offset: offset,
        rankProfile: SearchModes.NativeRank,
        ...(ENABLE_TRACE || DEBUG_POOR_RANKINGS ? { tracelevel: 5 } : {}),
      }
      response = await searchVespa(
        query,
        USER_EMAIL_FOR_SEARCH!,
        null,
        null,
        searchOptions,
      )

      const hits = response.root.children || []
      if (offset === 0 && response.root.fields?.totalCount) {
        totalCount = response.root.fields.totalCount
      }

      if (hits.length === 0) {
        break
      }

      // Capture debug info only on the first page for efficiency
      if (DEBUG_POOR_RANKINGS && offset === 0) {
        collectedDebugInfo = {
          docId: docIdToFind,
          query: query,
          foundAtRank: null,
          debugInfo: {
            query: query,
            docIdToFind: docIdToFind,
            topResults: hits.slice(0, 10).map((hit: any, index: number) => {
              const fields = hit.fields as VespaFields
              const sddocname = fields.sddocname
              const fieldMapping = sddocname
                ? schemaFieldMap[sddocname]
                : undefined
              const resultRank = offset + index + 1
              return {
                rank: resultRank,
                schema: sddocname || "unknown",
                title:
                  fieldMapping && fields[fieldMapping.titleField] !== undefined
                    ? String(fields[fieldMapping.titleField])
                    : "unknown",
                docId:
                  fieldMapping && fields[fieldMapping.idField] !== undefined
                    ? String(fields[fieldMapping.idField])
                    : "unknown",
                matchDetails: hit.matchfeatures || {},
              }
            }),
            trace: response.root.trace,
          },
        }
      }

      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]
        const currentRank = offset + i + 1
        const sddocname = (hit.fields as VespaFields)?.sddocname
        const fieldMapping = sddocname ? schemaFieldMap[sddocname] : undefined
        const idField = fieldMapping?.idField

        if (!idField) {
          continue
        }

        const hitId = (hit.fields as VespaFields)?.[idField]
        Logger.debug(
          {
            sampleRank: currentRank,
            hitSchema: sddocname,
            hitIdField: idField,
            hitIdValue: hitId,
            docIdToFind,
          },
          "Comparing document IDs",
        )

        if (hitId !== undefined && hitId === docIdToFind) {
          Logger.info(
            `---> Match found at rank ${currentRank}! Comparing ${hitId} === ${docIdToFind}`,
          )
          rank = currentRank
          if (collectedDebugInfo) {
            collectedDebugInfo.foundAtRank = rank
          }
          break
        }
      }

      if (rank !== null) {
        break
      }

      offset += HITS_PER_PAGE
      if (totalCount > 0 && offset >= totalCount) {
        break
      }
    }

    if (
      DEBUG_POOR_RANKINGS &&
      collectedDebugInfo &&
      (rank === null || rank > POOR_RANK_THRESHOLD)
    ) {
      ensureDirectoryExists(OUTPUT_DIR)

      // Hash docId to avoid overly long filenames
      const docIdHash = crypto
        .createHash("sha256")
        .update(docIdToFind)
        .digest("hex")
      const debugFilename = path.join(
        OUTPUT_DIR,
        `debug_${docIdHash}_${new Date().getTime()}.json`,
      )
      try {
        collectedDebugInfo.foundAtRank = rank
        fs.writeFileSync(
          debugFilename,
          JSON.stringify(collectedDebugInfo, null, 2),
        )
        Logger.info(
          `Debug info for poorly ranked document saved to ${debugFilename}`,
        )
      } catch (error) {
        Logger.error({ error, docId: docIdToFind }, "Failed to save debug info")
      }
    } else if (
      DEBUG_POOR_RANKINGS &&
      !collectedDebugInfo &&
      (rank === null || rank > POOR_RANK_THRESHOLD)
    ) {
      Logger.warn(
        { docId: docIdToFind, rank },
        "Poor rank detected but no debug info collected, possibly due to search error on first page.",
      )
    }
  } catch (error) {
    Logger.error(
      { error, docId: docIdToFind, query },
      "Failed to search for document rank",
    )
    return { rank: null, debugPayload: collectedDebugInfo }
  }

  return {
    rank,
    debugPayload:
      DEBUG_POOR_RANKINGS && (rank === null || rank > POOR_RANK_THRESHOLD)
        ? collectedDebugInfo
        : null,
  }
}

// Failure analysis

function performFailureAnalysis(
  debugData: DebugFailureInfo[],
  outputDir: string,
) {
  if (!DEBUG_POOR_RANKINGS || debugData.length === 0) {
    Logger.info(
      "Skipping failure analysis: Debugging not enabled or no poor rankings found across all runs.",
    )
    return
  }

  Logger.info(`--- Starting Failure Analysis (${debugData.length} entries) ---`)

  const schemaGroups: Record<string, DebugFailureInfo[]> = {}

  debugData.forEach((info) => {
    let schema = "unknown"
    const topResults = info.debugInfo?.topResults || []
    const matchingResult = topResults.find((r) => r.docId === info.docId)

    if (matchingResult && matchingResult.schema) {
      schema = matchingResult.schema
    } else {
      // Fall back to inferring schema from docId format
      if (info.docId.includes("@") || info.docId.match(/^[0-9a-f]{16}$/)) {
        schema = mailSchema
      } else if (info.docId.match(/^[0-9A-Za-z_-]{33,}$/)) {
        schema = mailAttachmentSchema
      } else if (info.docId.match(/^[0-9A-Za-z_-]{20,32}$/)) {
        schema = fileSchema
      } else if (info.docId.match(/^u:/)) {
        schema = userSchema
      } else if (info.docId.match(/^ev:/)) {
        schema = eventSchema
      }
    }

    const group = schemaGroups[schema] ?? (schemaGroups[schema] = [])
    group.push(info)
  })

  const schemaAnalyses: SchemaAnalysis[] = []

  for (const [schema, groupDebugInfos] of Object.entries(schemaGroups)) {
    Logger.info(
      `Analyzing ${groupDebugInfos.length} failures for schema: ${schema}`,
    )

    const analysis: SchemaAnalysis = {
      schema,
      totalDocuments: groupDebugInfos.length,
      notFoundCount: groupDebugInfos.filter((info) => info.foundAtRank === null)
        .length,
      poorRankingCount: groupDebugInfos.filter(
        (info) => info.foundAtRank !== null,
      ).length,
      commonIssues: {},
      examples: [],
    }

    for (const info of groupDebugInfos) {
      try {
        let likelyIssue = "Unknown"

        if (info.foundAtRank === null) {
          if (info.query.length < 3) {
            likelyIssue = "Query too short"
          } else if (info.query.includes(".") && schema === fileSchema) {
            likelyIssue = "File extension handling"
          } else if (
            /[^\w\s]/.test(info.query) &&
            info.debugInfo?.topResults?.length === 0
          ) {
            likelyIssue = "Special characters in query"
          } else if (
            schema === mailAttachmentSchema &&
            info.query.includes(".pdf")
          ) {
            likelyIssue = "PDF filename matching"
          } else {
            likelyIssue = "Document not indexed or permissions issue"
          }
        } else {
          // Found but ranked poorly (already filtered by POOR_RANK_THRESHOLD)
          const topTitles =
            info.debugInfo?.topResults?.map(
              (r) => (r.title || "").toLowerCase(),
            ) || []
          const queryTokens = info.query.toLowerCase().split(/\s+/)

          if (
            topTitles.some((title) =>
              queryTokens.every((token) => title && title.includes(token)),
            )
          ) {
            likelyIssue = "Term weighting issues"
          } else if (schema === mailAttachmentSchema) {
            likelyIssue = "Attachment filename tokenization"
          } else {
            likelyIssue = "Ranking algorithm prioritization"
          }
        }

        analysis.commonIssues[likelyIssue] =
          (analysis.commonIssues[likelyIssue] || 0) + 1

        if (analysis.examples.length < 5) {
          analysis.examples.push({
            query: info.query,
            docId: info.docId,
            foundAtRank: info.foundAtRank,
            likelyIssue,
            topResults: info.debugInfo?.topResults || [],
          })
        }
      } catch (error) {
        Logger.error(
          {
            errorMessage:
              error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            docId: info?.docId,
            query: info?.query,
          },
          "Error analyzing single debug info entry during report generation. Skipping this entry.",
        )
        analysis.commonIssues["Analysis Error"] =
          (analysis.commonIssues["Analysis Error"] || 0) + 1
      }
    }
    schemaAnalyses.push(analysis)
  }

  const recommendations = generateFailureRecommendations(schemaAnalyses)
  writeFailureAnalysisReport(schemaAnalyses, recommendations, outputDir)

  Logger.info(`--- Failure Analysis Complete ---`)
}

function generateFailureRecommendations(
  analyses: SchemaAnalysis[],
): Record<string, string[]> {
  const recommendations: Record<string, string[]> = {}

  analyses.forEach((analysis) => {
    const schema = analysis.schema
    const schemaRecs: string[] = []
    recommendations[schema] = schemaRecs

    if (analysis.notFoundCount > analysis.poorRankingCount) {
      schemaRecs.push(
        "Review document indexing/permissions to ensure all target documents are searchable.",
      )
      if (schema === mailAttachmentSchema)
        schemaRecs.push(
          "Improve attachment filename tokenization for better matching.",
        )
      if (schema === fileSchema)
        schemaRecs.push(
          "Ensure file metadata (esp. extensions) is normalized/handled correctly.",
        )
    } else if (analysis.poorRankingCount > 0) {
      schemaRecs.push(
        "Review ranking weights/profiles to prioritize matches in primary fields (title/subject/name/filename).",
      )
      if (schema === mailSchema)
        schemaRecs.push(
          "Increase boost for subject matches over body content.",
        )
      if (schema === eventSchema)
        schemaRecs.push(
          "Prioritize exact name matches over description matches.",
        )
    }

    const sortedIssues = Object.entries(analysis.commonIssues)
      .filter(([issue]) => issue !== "Analysis Error")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)

    sortedIssues.forEach(([issue, count]) => {
      const percentage = Math.round((count / analysis.totalDocuments) * 100)
      const issueText = `(${percentage}% of failures)`
      switch (issue) {
        case "Query too short":
          schemaRecs.push(
            `Improve handling of short queries ${issueText}.`,
          )
          break
        case "Special characters in query":
          schemaRecs.push(
            `Enhance tokenization for special characters ${issueText}.`,
          )
          break
        case "File extension handling":
          schemaRecs.push(
            `Implement special handling for file extensions ${issueText}.`,
          )
          break
        case "PDF filename matching":
          schemaRecs.push(
            `Add specific rules/tokenization for PDF filenames ${issueText}.`,
          )
          break
        case "Term weighting issues":
          schemaRecs.push(
            `Adjust term weighting to prioritize primary field matches ${issueText}.`,
          )
          break
        case "Attachment filename tokenization":
          schemaRecs.push(
            `Improve tokenization/matching for attachment filenames ${issueText}.`,
          )
          break
        case "Ranking algorithm prioritization":
          schemaRecs.push(
            `Review ranking signals/profile for relevance ${issueText}.`,
          )
          break
      }
    })
    if ((analysis.commonIssues["Analysis Error"] ?? 0) > 0) {
      schemaRecs.push(
        `Investigate ${analysis.commonIssues["Analysis Error"]} analysis errors (check logs).`,
      )
    }
  })

  return recommendations
}

function writeFailureAnalysisReport(
  analyses: SchemaAnalysis[],
  recommendations: Record<string, string[]>,
  outputDir: string,
) {
  const reportFilename = path.join(outputDir, "search_failure_analysis.md")
  let report = `# Search Quality Failure Analysis Report\nGenerated: ${new Date().toISOString()}\n\n## Overview\nThis report analyzes search failures based on runs with DEBUG_POOR_RANKINGS=true to identify patterns and recommend improvements.\n\n`

  report += `## Summary Metrics\n\n| Schema | Total Failures | Not Found | Poorly Ranked | Top Issues |\n`
  report += `|--------|---------------|-----------|---------------|------------|\n`
  analyses.forEach((analysis) => {
    const topIssues = Object.entries(analysis.commonIssues)
      .filter(([issue]) => issue !== "Analysis Error")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([issue, count]) => `${issue} (${count})`)
      .join(", ")
    report += `| ${analysis.schema} | ${analysis.totalDocuments} | ${analysis.notFoundCount} | ${analysis.poorRankingCount} | ${topIssues || "N/A"} |\n`
  })

  report += `\n## Recommendations by Schema\n\n`
  Object.entries(recommendations).forEach(([schema, schemaRecommendations]) => {
    if (schemaRecommendations.length > 0) {
      report += `### ${schema}\n\n`
      schemaRecommendations.forEach((rec) => {
        report += `- ${rec}\n`
      })
      report += `\n`
    }
  })

  report += `## Detailed Analysis\n\n`
  analyses.forEach((analysis) => {
    report += `### ${analysis.schema}\n\n`
    report += `- Total failures analyzed: ${analysis.totalDocuments}\n`
    report += `- Documents not found: ${analysis.notFoundCount}\n`
    report += `- Documents ranked poorly (Rank > ${POOR_RANK_THRESHOLD}): ${analysis.poorRankingCount}\n\n`

    report += `#### Common Issues\n\n`
    Object.entries(analysis.commonIssues)
      .sort((a, b) => b[1] - a[1])
      .forEach(([issue, count]) => {
        const percentage = Math.round((count / analysis.totalDocuments) * 100)
        report += `- ${issue}: ${count} occurrences (${percentage}%)\n`
      })

    if (analysis.examples.length > 0) {
      report += `\n#### Example Failures (up to 5)\n\n`
      analysis.examples.forEach((example, index) => {
        report += `**Example ${index + 1}:**\n`
        report += `- Query: \`${example.query}\`\n`
        report += `- Document ID: \`${example.docId}\`\n`
        report += `- Found at rank: ${example.foundAtRank === null ? "Not found" : example.foundAtRank}\n`
        report += `- Likely issue: ${example.likelyIssue}\n`
        if (example.topResults.length > 0) {
          report += `- Top results instead:\n`
          example.topResults.slice(0, 3).forEach((result, i) => {
            report += `  ${i + 1}. "${result.title || "N/A"}" (${result.schema || "unknown"}) - DocID: \`${result.docId || "unknown"}\`\n`
          })
        }
        report += `\n`
      })
    }
    report += `\n`
  })

  try {
    fs.writeFileSync(reportFilename, report)
    Logger.info(`Failure analysis report saved to ${reportFilename}`)
  } catch (error) {
    Logger.error(
      { error, reportFilename },
      "Failed to write failure analysis report.",
    )
  }
}

interface SingleRunMetrics {
  results: SampleResult[]
  reciprocalRanks: number[]
  collectedDebugData: DebugFailureInfo[]
  evaluatedSamples: number
}

interface AveragedMetrics {
  mrr: number
  meanRank: number
  medianRank: number
  successAt3: number
  successAt5: number
  successAt10: number
  successRate: number // fraction found within MAX_RANK_TO_CHECK
  rankDistribution: {
    "1": number
    "2-3": number
    "4-5": number
    "6-10": number
    "11-20": number
    "21-50": number
    "51-100": number
    not_found: number
  }
  metricsBySchema: Record<
    string,
    {
      mrrSum: number
      ranks: number[]
      successAt3Count: number
      successAt5Count: number
      successAt10Count: number
      successRateCount: number
      count: number
    }
  >
}

async function runSingleEvaluation(
  runNumber: number,
): Promise<SingleRunMetrics> {
  Logger.info(
    `--- Starting Evaluation Run #${runNumber}/${NUM_RUNS} (Samples: ${NUM_SAMPLES}) ---`,
  )

  const results: SampleResult[] = []
  const reciprocalRanks: number[] = []
  const collectedDebugData: DebugFailureInfo[] = []
  let evaluatedSamples = 0
  const MAX_FETCH_RETRIES_PER_SAMPLE = 5

  while (evaluatedSamples < NUM_SAMPLES) {
    Logger.debug(
      `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Starting processing...`,
    )
    let currentDocument: Document | null = null
    let query: string | null = null
    let docToEvaluate: Document | null = null
    let docId: string | undefined = undefined
    let originalTitle: string | undefined = undefined
    let sddocname: string | undefined = undefined
    let foundSuitableDocument = false

    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES_PER_SAMPLE; attempt++) {
      Logger.debug(
        `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Fetch attempt ${attempt}/${MAX_FETCH_RETRIES_PER_SAMPLE}...`,
      )
      currentDocument = await getRandomDocument()

      if (!currentDocument) {
        Logger.warn(
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Failed to fetch document. Retrying...`,
        )
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 2))
        continue
      }

      const tempDoc = currentDocument
      const fields = tempDoc.fields as VespaFields
      const tempSddocname = fields.sddocname

      if (!tempSddocname || !schemaFieldMap[tempSddocname] || !fields) {
        Logger.debug(
          { docId: tempDoc.id, sddocname: tempSddocname, attempt },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Document schema '${tempSddocname}' not in mapping or fields missing. Trying next attempt.`,
        )
        continue
      }

      const { idField, titleField } = schemaFieldMap[tempSddocname]
      const tempDocId = fields[idField] as string | undefined
      const tempOriginalTitle = fields[titleField] as string | undefined

      if (!tempDocId || typeof tempOriginalTitle !== "string") {
        Logger.debug(
          {
            fetchedDocId: tempDoc.id,
            sddocname: tempSddocname,
            attempt,
            hasDocId: !!tempDocId,
            titleType: typeof tempOriginalTitle,
          },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Document missing mapped ID or valid Title field. Trying next attempt.`,
        )
        continue
      }

      // BodyPhrase strategy needs a body field to sample from
      if (
        CURRENT_STRATEGY === EvaluationStrategy.BodyPhrase &&
        !schemaFieldMap[tempSddocname].bodyField
      ) {
        Logger.debug(
          {
            docId: tempDoc.id,
            sddocname: tempSddocname,
            strategy: CURRENT_STRATEGY,
            attempt,
          },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Schema '${tempSddocname}' has no bodyField for BodyPhrase strategy. Trying next attempt.`,
        )
        continue
      }

      const tempQuery = generateSearchQuery(tempDoc, CURRENT_STRATEGY)

      if (!tempQuery) {
        Logger.debug(
          {
            docId: tempDoc.id,
            sddocname: tempSddocname,
            strategy: CURRENT_STRATEGY,
            attempt,
          },
          `Run #${runNumber}, Sample #${evaluatedSamples + 1}, Attempt ${attempt}: Failed to generate query for document using strategy ${CURRENT_STRATEGY}. Trying next attempt.`,
        )
        continue
      }

      Logger.info(
        `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Found suitable document (ID: ${tempDocId}) on attempt ${attempt}.`,
      )
      docToEvaluate = tempDoc
      query = tempQuery
      docId = tempDocId
      originalTitle = tempOriginalTitle
      sddocname = tempSddocname
      foundSuitableDocument = true
      break
    }

    if (foundSuitableDocument && docToEvaluate && query && docId && sddocname) {
      Logger.info(
        `[Run ${runNumber}/${NUM_RUNS}, Sample ${evaluatedSamples + 1}/${NUM_SAMPLES}] Evaluating Schema: ${sddocname}, ID: ${docId}, Query (${CURRENT_STRATEGY}): "${query.substring(0, 100)}${query.length > 100 ? "..." : ""}"`,
      )
      Logger.debug(
        {},
        "Preparing to call findDocumentRank",
      )

      const { rank, debugPayload } = await findDocumentRank(docId, query)

      results.push({
        docId,
        schema: sddocname,
        title: originalTitle || "N/A",
        rank,
        query,
      })

      if (debugPayload) {
        collectedDebugData.push(debugPayload)
      }

      if (rank !== null && rank <= MAX_RANK_TO_CHECK) {
        reciprocalRanks.push(1 / rank)
        Logger.info(` -> Found at Rank: ${rank}`)
      } else {
        reciprocalRanks.push(0)
        Logger.info(` -> Not found within top ${MAX_RANK_TO_CHECK}`)
      }

      evaluatedSamples++
    } else {
      Logger.error(
        `Run #${runNumber}, Sample #${evaluatedSamples + 1}: Failed to find a suitable document after ${MAX_FETCH_RETRIES_PER_SAMPLE} attempts. Skipping this sample number for this run.`,
      )
      evaluatedSamples++ // Increment anyway so the loop terminates
      Logger.warn(
        `Run #${runNumber}, Sample #${evaluatedSamples}: Incrementing evaluated count despite failure to find suitable doc, to ensure loop termination.`,
      )
    }

    if (evaluatedSamples < NUM_SAMPLES) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  }

  Logger.info(`--- Evaluation Run #${runNumber}/${NUM_RUNS} Finished ---`)
  if (evaluatedSamples < NUM_SAMPLES) {
    Logger.warn(
      `Target was ${NUM_SAMPLES} samples for Run #${runNumber}, but loop finished after processing ${evaluatedSamples}. This might happen if finding suitable documents consistently failed in this run.`,
    )
  }

  return {
    results,
    reciprocalRanks,
    collectedDebugData,
    evaluatedSamples,
  }
}

function calculateAverages(
  runMetrics: SingleRunMetrics[],
  _totalEvaluatedSamples: number,
): AveragedMetrics {
  const allResults = runMetrics.flatMap((run) => run.results)
  const allReciprocalRanks = runMetrics.flatMap((run) => run.reciprocalRanks)

  const numEvaluated = allResults.length

  const mrr =
    numEvaluated > 0
      ? allReciprocalRanks.reduce((sum, r) => sum + r, 0) / numEvaluated
      : 0

  const foundDocuments = allResults.filter((r) => r.rank !== null)
  const meanRank =
    foundDocuments.length > 0
      ? foundDocuments.reduce((sum, r) => sum + (r.rank || 0), 0) /
        foundDocuments.length
      : 0

  let medianRank = 0
  if (foundDocuments.length > 0) {
    const sortedRanks = foundDocuments
      .map((r) => r.rank || 0)
      .sort((a, b) => a - b)
    const midIndex = Math.floor(sortedRanks.length / 2)
    medianRank =
      sortedRanks.length % 2 === 0
        ? ((sortedRanks[midIndex - 1] ?? 0) + (sortedRanks[midIndex] ?? 0)) / 2
        : (sortedRanks[midIndex] ?? 0)
  }

  const successAt3 =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= 3).length /
        numEvaluated
      : 0
  const successAt5 =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= 5).length /
        numEvaluated
      : 0
  const successAt10 =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= 10).length /
        numEvaluated
      : 0
  const successRate =
    numEvaluated > 0
      ? allResults.filter((r) => r.rank !== null && r.rank <= MAX_RANK_TO_CHECK)
          .length / numEvaluated
      : 0

  const rankDistributionCounts = {
    "1": 0,
    "2-3": 0,
    "4-5": 0,
    "6-10": 0,
    "11-20": 0,
    "21-50": 0,
    "51-100": 0,
    not_found: 0,
  }
  allResults.forEach((r) => {
    if (r.rank === null) {
      rankDistributionCounts.not_found++
    } else if (r.rank === 1) {
      rankDistributionCounts["1"]++
    } else if (r.rank <= 3) {
      rankDistributionCounts["2-3"]++
    } else if (r.rank <= 5) {
      rankDistributionCounts["4-5"]++
    } else if (r.rank <= 10) {
      rankDistributionCounts["6-10"]++
    } else if (r.rank <= 20) {
      rankDistributionCounts["11-20"]++
    } else if (r.rank <= 50) {
      rankDistributionCounts["21-50"]++
    } else if (r.rank <= MAX_RANK_TO_CHECK) {
      rankDistributionCounts["51-100"]++
    } else {
      // Ranks beyond MAX_RANK_TO_CHECK count as not found
      rankDistributionCounts.not_found++
    }
  })

  const metricsBySchema: Record<
    string,
    {
      mrrSum: number
      ranks: number[]
      successAt3Count: number
      successAt5Count: number
      successAt10Count: number
      successRateCount: number
      count: number
    }
  > = {}

  allResults.forEach((r) => {
    const schema = r.schema || "unknown"
    if (!metricsBySchema[schema]) {
      metricsBySchema[schema] = {
        mrrSum: 0,
        ranks: [],
        successAt3Count: 0,
        successAt5Count: 0,
        successAt10Count: 0,
        successRateCount: 0,
        count: 0,
      }
    }
    metricsBySchema[schema].mrrSum += r.rank ? 1 / r.rank : 0
    if (r.rank !== null) {
      metricsBySchema[schema].ranks.push(r.rank)
      if (r.rank <= 3) metricsBySchema[schema].successAt3Count++
      if (r.rank <= 5) metricsBySchema[schema].successAt5Count++
      if (r.rank <= 10) metricsBySchema[schema].successAt10Count++
      if (r.rank <= MAX_RANK_TO_CHECK)
        metricsBySchema[schema].successRateCount++
    }
    metricsBySchema[schema].count += 1
  })

  return {
    mrr,
    meanRank,
    medianRank,
    successAt3,
    successAt5,
    successAt10,
    successRate,
    rankDistribution: rankDistributionCounts,
    metricsBySchema,
  }
}

function generateSummaryReportContent(
  averagedMetrics: AveragedMetrics,
  totalEvaluatedSamples: number,
): string {
  const {
    mrr,
    meanRank,
    medianRank,
    successAt3,
    successAt5,
    successAt10,
    successRate,
    rankDistribution,
    metricsBySchema,
  } = averagedMetrics

  let content = `
===========================================
SEARCH PERFORMANCE SUMMARY (${CURRENT_STRATEGY})
===========================================
Generated: ${new Date().toISOString()}
Strategy: ${CURRENT_STRATEGY}
Number of Runs: ${NUM_RUNS}
Samples Per Run: ${NUM_SAMPLES}
Total Samples Successfully Evaluated Across All Runs: ${totalEvaluatedSamples}

OVERALL AVERAGED METRICS:
- Mean Reciprocal Rank (MRR): ${mrr.toFixed(4)}
- Mean Rank (found docs only): ${meanRank.toFixed(2)}
- Median Rank (found docs only): ${medianRank.toFixed(2)}
- Success@3: ${(successAt3 * 100).toFixed(2)}%
- Success@5: ${(successAt5 * 100).toFixed(2)}%
- Success@10: ${(successAt10 * 100).toFixed(2)}%
- Success@${MAX_RANK_TO_CHECK}: ${(successRate * 100).toFixed(2)}%

AVERAGED DISTRIBUTION OF RANKS (Total samples: ${totalEvaluatedSamples}):
- Rank 1: ${rankDistribution["1"]} docs (${((rankDistribution["1"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 2-3: ${rankDistribution["2-3"]} docs (${((rankDistribution["2-3"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 4-5: ${rankDistribution["4-5"]} docs (${((rankDistribution["4-5"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 6-10: ${rankDistribution["6-10"]} docs (${((rankDistribution["6-10"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 11-20: ${rankDistribution["11-20"]} docs (${((rankDistribution["11-20"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 21-50: ${rankDistribution["21-50"]} docs (${((rankDistribution["21-50"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Rank 51-100: ${rankDistribution["51-100"]} docs (${((rankDistribution["51-100"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
- Not Found (or >${MAX_RANK_TO_CHECK}): ${rankDistribution.not_found} docs (${((rankDistribution.not_found / totalEvaluatedSamples) * 100).toFixed(2)}%)

===========================================
AVERAGED PERFORMANCE BY SCHEMA
===========================================

`
  Object.entries(metricsBySchema).forEach(([schema, metrics]) => {
    if (metrics.count > 0) {
      const meanSchemaRank =
        metrics.ranks.length > 0
          ? metrics.ranks.reduce((sum: number, rank: number) => sum + rank, 0) /
            metrics.ranks.length
          : 0
      const schemaMrr = metrics.mrrSum / metrics.count
      const schemaSuccessRate = metrics.successRateCount / metrics.count
      const schemaSuccessAt3 = metrics.successAt3Count / metrics.count
      const schemaSuccessAt5 = metrics.successAt5Count / metrics.count
      const schemaSuccessAt10 = metrics.successAt10Count / metrics.count

      content += `
===== ${schema.toUpperCase()} =====
Total Samples for Schema (Across All Runs): ${metrics.count}
MRR: ${schemaMrr.toFixed(4)}
Mean Rank (found docs): ${metrics.ranks.length > 0 ? meanSchemaRank.toFixed(2) : "N/A"}
Found Rate (@${MAX_RANK_TO_CHECK}): ${(schemaSuccessRate * 100).toFixed(2)}%
Success@3: ${(schemaSuccessAt3 * 100).toFixed(2)}%
Success@5: ${(schemaSuccessAt5 * 100).toFixed(2)}%
Success@10: ${(schemaSuccessAt10 * 100).toFixed(2)}%

${generatePerformanceSummary(schema, { ...metrics, successRateCount: metrics.successRateCount }, CURRENT_STRATEGY)}

`
    } else {
      content += `===== ${schema.toUpperCase()} =====\nNo successful evaluations for this schema.\n\n`
    }
  })

  content += `
===========================================
END OF REPORT
===========================================
`
  return content
}

function generatePerformanceSummary(
  schema: string,
  metrics: {
    mrrSum: number
    ranks: number[]
    successAt3Count: number
    successAt5Count: number
    successAt10Count: number
    successRateCount: number // success within MAX_RANK_TO_CHECK
    count: number
  },
  strategy: EvaluationStrategy,
): string {
  if (metrics.count === 0) return `${schema}: No data available.`

  const mrr = metrics.mrrSum / metrics.count
  const successAt3Rate = metrics.successAt3Count / metrics.count
  const successAt10Rate = metrics.successAt10Count / metrics.count
  const foundRate = metrics.successRateCount / metrics.count

  // Mean rank over found documents only
  const meanRank =
    metrics.ranks.length > 0
      ? metrics.ranks.reduce((sum, rank) => sum + rank, 0) /
        metrics.ranks.length
      : 0

  const MRR_EXCELLENT = 0.7
  const MRR_GOOD = 0.5
  const MRR_FAIR = 0.3
  const MRR_POOR = 0.1
  const SUCCESS_AT_3_GOOD = 0.6
  const SUCCESS_AT_3_FAIR = 0.4
  const SUCCESS_AT_3_POOR = 0.2
  const FOUND_RATE_GOOD = 0.9
  const FOUND_RATE_FAIR = 0.7

  let overallAssessment = ""
  let insights = []
  let suggestions = []

  if (mrr >= MRR_EXCELLENT)
    overallAssessment = `${schema} performs excellently with strategy ${strategy}.`
  else if (mrr >= MRR_GOOD)
    overallAssessment = `${schema} performs well with strategy ${strategy}.`
  else if (mrr >= MRR_FAIR)
    overallAssessment = `${schema} performs adequately with strategy ${strategy}.`
  else if (mrr >= MRR_POOR)
    overallAssessment = `${schema} performs poorly with strategy ${strategy}.`
  else
    overallAssessment = `${schema} performs very poorly with strategy ${strategy}.`

  if (foundRate < FOUND_RATE_FAIR) {
    insights.push(
      `Many (${((1 - foundRate) * 100).toFixed(0)}%) couldn't be found within top ${MAX_RANK_TO_CHECK}.`,
    )
    suggestions.push("Consider indexing improvements or query expansion.")
  }

  if (foundRate >= FOUND_RATE_GOOD && successAt3Rate < SUCCESS_AT_3_FAIR) {
    insights.push(
      `Docs often found but ranked low (mean rank: ${meanRank > 0 ? meanRank.toFixed(1) : "N/A"}).`,
    )
    suggestions.push("Review ranking configuration/boost factors.")
  }

  if (successAt3Rate >= SUCCESS_AT_3_GOOD) {
    insights.push(
      `${(successAt3Rate * 100).toFixed(0)}% appear in top 3, indicating good relevance.`,
    )
  }

  if (
    successAt3Rate < SUCCESS_AT_3_POOR &&
    successAt10Rate >= SUCCESS_AT_3_FAIR
  ) {
    insights.push(`Docs frequently appear in ranks 4-10 rather than top 3.`)
    suggestions.push("Fine-tune ranking to prioritize relevant results higher.")
  }

  switch (schema) {
    case fileSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_FAIR) {
        insights.push("File exact title search underperforming.")
        suggestions.push("Check title standardization/tokenization.")
      }
      break
    case mailSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_FAIR) {
        insights.push("Email subject search underperforming.")
        suggestions.push("Review subject indexing/tokenization.")
      }
      break
    case mailAttachmentSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_FAIR) {
        insights.push("Attachment filename search underperforming.")
        suggestions.push("Check filename processing/indexing (special chars?).")
      }
      break
    case userSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_EXCELLENT) {
        insights.push("User name search should be highly precise.")
        suggestions.push("Ensure names properly indexed with high boost.")
      }
      break
    case eventSchema:
      if (strategy === EvaluationStrategy.ExactTitle && mrr < MRR_GOOD) {
        insights.push("Event name search underperforming.")
        suggestions.push("Review event name indexing/boost factors.")
      }
      break
  }

  let summary = overallAssessment
  if (insights.length > 0)
    summary += "\\nInsights:\\n" + insights.map((i) => `- ${i}`).join("\\n")
  if (suggestions.length > 0)
    summary +=
      "\\nSuggestions:\\n" + suggestions.map((s) => `- ${s}`).join("\\n")

  return summary
}

async function mainEvaluationRunner() {
  Logger.info(
    `Starting search quality evaluation across schemas over ${NUM_RUNS} runs...`,
  )
  Logger.info(`Using strategy: ${CURRENT_STRATEGY}`)
  Logger.info(`Samples per run: ${NUM_SAMPLES}`)

  if (!(CURRENT_STRATEGY in EvaluationStrategy)) {
    Logger.error(
      `Invalid EVALUATION_STRATEGY: ${CURRENT_STRATEGY}. Must be one of ${Object.keys(EvaluationStrategy).join(", ")}`,
    )
    process.exit(1)
  }

  ensureDirectoryExists(OUTPUT_DIR)

  const allRunMetrics: SingleRunMetrics[] = []
  let totalEvaluatedSamples = 0

  for (let i = 1; i <= NUM_RUNS; i++) {
    const runMetrics = await runSingleEvaluation(i)
    allRunMetrics.push(runMetrics)
    totalEvaluatedSamples += runMetrics.evaluatedSamples

    if (i < NUM_RUNS) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  }

  Logger.info(`--- All ${NUM_RUNS} Evaluation Runs Complete ---`)
  Logger.info(
    `Total samples successfully evaluated across all runs: ${totalEvaluatedSamples}`,
  )

  if (totalEvaluatedSamples === 0) {
    Logger.warn(
      "No samples were successfully processed and evaluated across all runs.",
    )
    // Still run failure analysis if any debug data was collected
    const allCollectedDebugData = allRunMetrics.flatMap(
      (run) => run.collectedDebugData,
    )
    if (allCollectedDebugData.length > 0) {
      performFailureAnalysis(allCollectedDebugData, OUTPUT_DIR)
    }
    return
  }

  const averagedMetrics = calculateAverages(
    allRunMetrics,
    totalEvaluatedSamples,
  )

  Logger.info(`
--- Averaged Evaluation Complete Across ${NUM_RUNS} Runs ---
Strategy: ${CURRENT_STRATEGY}
Total Samples Target Per Run: ${NUM_SAMPLES}
Total Samples Successfully Evaluated Across All Runs: ${totalEvaluatedSamples}

**Overall Averaged Mean Reciprocal Rank (MRR): ${averagedMetrics.mrr.toFixed(4)}**

Other Averaged Metrics:
Mean Rank (found documents only): ${averagedMetrics.meanRank.toFixed(2)}
Median Rank (found documents only): ${averagedMetrics.medianRank.toFixed(2)}
Success@3 (based on evaluated): ${(averagedMetrics.successAt3 * 100).toFixed(2)}%
Success@5 (based on evaluated): ${(averagedMetrics.successAt5 * 100).toFixed(2)}%
Success@10 (based on evaluated): ${(averagedMetrics.successAt10 * 100).toFixed(2)}%
Success@${MAX_RANK_TO_CHECK} (based on evaluated): ${(averagedMetrics.successRate * 100).toFixed(2)}%

Averaged Rank Distribution (based on ${totalEvaluatedSamples} samples):
  Rank 1: ${averagedMetrics.rankDistribution["1"]} docs (${((averagedMetrics.rankDistribution["1"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 2-3: ${averagedMetrics.rankDistribution["2-3"]} docs (${((averagedMetrics.rankDistribution["2-3"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 4-5: ${averagedMetrics.rankDistribution["4-5"]} docs (${((averagedMetrics.rankDistribution["4-5"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 6-10: ${averagedMetrics.rankDistribution["6-10"]} docs (${((averagedMetrics.rankDistribution["6-10"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 11-20: ${averagedMetrics.rankDistribution["11-20"]} docs (${((averagedMetrics.rankDistribution["11-20"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 21-50: ${averagedMetrics.rankDistribution["21-50"]} docs (${((averagedMetrics.rankDistribution["21-50"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Rank 51-100: ${averagedMetrics.rankDistribution["51-100"]} docs (${((averagedMetrics.rankDistribution["51-100"] / totalEvaluatedSamples) * 100).toFixed(2)}%)
  Not Found (or >${MAX_RANK_TO_CHECK}): ${averagedMetrics.rankDistribution.not_found} docs (${((averagedMetrics.rankDistribution.not_found / totalEvaluatedSamples) * 100).toFixed(2)}%)
`)

  Logger.info(`--- Averaged Metrics by Schema (Across ${NUM_RUNS} Runs) ---`)
  Object.entries(averagedMetrics.metricsBySchema).forEach(
    ([schema, metrics]) => {
      if (metrics.count > 0) {
        const meanSchemaRank =
          metrics.ranks.length > 0
            ? metrics.ranks.reduce((sum, rank) => sum + rank, 0) /
              metrics.ranks.length
            : 0
        const schemaMrr = metrics.mrrSum / metrics.count
        const schemaSuccessRate = metrics.successRateCount / metrics.count
        const schemaSuccessAt3 = metrics.successAt3Count / metrics.count
        const schemaSuccessAt5 = metrics.successAt5Count / metrics.count
        const schemaSuccessAt10 = metrics.successAt10Count / metrics.count

        Logger.info(`Schema: ${schema} (Total Samples: ${metrics.count})`)
        Logger.info(`  MRR: ${schemaMrr.toFixed(4)}`)
        Logger.info(
          `  Mean Rank (found docs): ${metrics.ranks.length > 0 ? meanSchemaRank.toFixed(2) : "N/A"}`,
        )
        Logger.info(
          `  Median Rank (found docs): ${metrics.ranks.length > 0 ? averagedMetrics.medianRank.toFixed(2) : "N/A"}`,
        )
        // Per-schema median over this schema's ranks
        let medianSchemaRank = 0
        if (metrics.ranks.length > 0) {
          const sortedRanks = [...metrics.ranks].sort((a, b) => a - b)
          const midIndex = Math.floor(sortedRanks.length / 2)
          medianSchemaRank =
            sortedRanks.length % 2 === 0
              ? ((sortedRanks[midIndex - 1] ?? 0) + (sortedRanks[midIndex] ?? 0)) /
                2
              : (sortedRanks[midIndex] ?? 0)
        }
        Logger.info(
          `  Median Rank (found docs): ${metrics.ranks.length > 0 ? medianSchemaRank.toFixed(2) : "N/A"}`,
        )

        Logger.info(
          `  Found Rate (@${MAX_RANK_TO_CHECK}): ${(schemaSuccessRate * 100).toFixed(2)}%`,
        )
        Logger.info(`  Success@3: ${(schemaSuccessAt3 * 100).toFixed(2)}%`)
        Logger.info(`  Success@5: ${(schemaSuccessAt5 * 100).toFixed(2)}%`)
        Logger.info(`  Success@10: ${(schemaSuccessAt10 * 100).toFixed(2)}%`)

        const summary = generatePerformanceSummary(
          schema,
          metrics,
          CURRENT_STRATEGY,
        )
        Logger.info("\\n  Performance Summary:")
        summary.split("\\n").forEach((line) => {
          Logger.info(`  ${line}`)
        })
        Logger.info("")
      } else {
        Logger.info(
          `Schema: ${schema} - No successful evaluations across all runs.`,
        )
        Logger.info("")
      }
    },
  )

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

    // Save consolidated results from all runs
    const allResults = allRunMetrics.flatMap((run) => run.results)
    const resultsFilename = path.join(
      OUTPUT_DIR,
      `evaluation_results_ALL_${CURRENT_STRATEGY}_${timestamp}.json`,
    )
    fs.writeFileSync(resultsFilename, JSON.stringify(allResults, null, 2))
    Logger.info(
      `Consolidated detailed evaluation results (${allResults.length} samples) saved to ${resultsFilename}`,
    )

    // Save consolidated poor rankings
    const allPoorRankings = allResults.filter(
      (r) => r.rank === null || (r.rank && r.rank > POOR_RANK_THRESHOLD),
    )
    if (allPoorRankings.length > 0) {
      const poorRankingsFilename = path.join(
        OUTPUT_DIR,
        `poor_rankings_ALL_${CURRENT_STRATEGY}_${timestamp}.json`,
      )
      fs.writeFileSync(
        poorRankingsFilename,
        JSON.stringify(allPoorRankings, null, 2),
      )
      Logger.info(
        `Consolidated poor rankings (${allPoorRankings.length} samples with rank > ${POOR_RANK_THRESHOLD} or null) saved to ${poorRankingsFilename}`,
      )
    } else {
      Logger.info(
        `No poor rankings (rank > ${POOR_RANK_THRESHOLD} or null) found across all runs.`,
      )
    }

    // Save performance summary text file
    const summaryFilename = path.join(
      OUTPUT_DIR,
      `performance_summary_AVERAGED_${CURRENT_STRATEGY}_${timestamp}.txt`,
    )
    let summaryContent = generateSummaryReportContent(
      averagedMetrics,
      totalEvaluatedSamples,
    )
    fs.writeFileSync(summaryFilename, summaryContent)
    Logger.info(
      `Averaged performance summary text report saved to ${summaryFilename}`,
    )
  } catch (error) {
    Logger.error({ error }, "Failed to save consolidated result/summary files.")
  }

  const allCollectedDebugData = allRunMetrics.flatMap(
    (run) => run.collectedDebugData,
  )
  performFailureAnalysis(allCollectedDebugData, OUTPUT_DIR)
}

mainEvaluationRunner().catch((error) => {
  Logger.error({ error }, "Unhandled error during main evaluation runner")
  process.exit(1)
})
