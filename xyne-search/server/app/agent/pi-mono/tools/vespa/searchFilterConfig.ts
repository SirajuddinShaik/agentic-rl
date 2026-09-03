/* eslint-disable @typescript-eslint/naming-convention --
 * Field kind tags, op names, and YAML keys are external-facing; lowercase
 * keeps them stable across env / file configs without forcing a rename. */
// Single source of truth for the per-deployment structured filter fields
// exposed by the `vespaSearch` tool. Source: `config/searchFilterFields.yaml`
// (see its header for the operator × dataType matrix, tier semantics, and the
// LLM-facing filter object shape).

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parse as parseYaml } from "yaml"

import { baseLogger } from "../../../log"

const Logger = baseLogger("backendv2/vespa/searchFilterConfig")

const DEFAULT_YAML_PATH = "config/searchFilterFields.yaml"

// ─── Filter DSL types ────────────────────────────────────────────────────────

export type DataType = "string" | "number" | "date" | "boolean"

export type FilterTier = "none" | "exact" | "range"

/** Legal ops per (dataType, tier) are enforced via ALLOWED_OPS below. */
export type Operator =
  | "eq"
  | "in"
  | "nin"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "containsAny"

/** Retrieval target only — not exposed as a filter. */
export type NoneFilterDef = { tier: "none" }

export type ExactFilterDef = {
  tier: "exact"
  operators: ReadonlyArray<
    Extract<Operator, "eq" | "in" | "nin" | "contains" | "containsAny">
  >
}

export type RangeFilterDef = {
  tier: "range"
  operators: ReadonlyArray<
    Extract<Operator, "eq" | "in" | "nin" | "gt" | "gte" | "lt" | "lte">
  >
  /** Maps a user-facing string to what Vespa stores. Extensible: future
   *  encodings (epoch_ms, …) drop in without a schema change. */
  encoding?: "yyyymmddInt"
}

/** Resolved field def consumed by the search tool + WHERE builder. */
export type FieldDef = {
  name: string
  description: string
  dataType: DataType
  multiValued: boolean
  /** Vespa column name when it differs from `name` (e.g. YAML `file_name`
   *  → Vespa `fileName`). Defaults to `name`. */
  vespaField: string
  filter: NoneFilterDef | ExactFilterDef | RangeFilterDef
}

// ─── Operator × DataType × Tier matrix ──────────────────────────────────────
// Enforced at YAML-load; ops outside the matrix are warned + dropped.
// Gotchas:
//   - strings have no `range` tier — lexicographic range rarely means what
//     users want; model it as date with a yyyy-prefix encoding instead.
//   - date+range omits `eq`: partial inputs ("2024" vs "2024-06-15") are
//     ambiguous. Single-day: `{gte: "2024-06-15", lte: "2024-06-15"}`.
//   - booleans only support `eq`.

const ALLOWED_OPS: Record<
  DataType,
  Record<FilterTier, ReadonlySet<Operator>>
> = {
  string: {
    none: new Set(),
    exact: new Set<Operator>(["eq", "in", "nin", "contains", "containsAny"]),
    range: new Set<Operator>(),
  },
  number: {
    none: new Set(),
    exact: new Set<Operator>(["eq", "in", "nin"]),
    range: new Set<Operator>(["eq", "in", "nin", "gt", "gte", "lt", "lte"]),
  },
  date: {
    none: new Set(),
    exact: new Set<Operator>(),
    range: new Set<Operator>(["gt", "gte", "lt", "lte"]),
  },
  boolean: {
    none: new Set(),
    exact: new Set<Operator>(["eq"]),
    range: new Set<Operator>(),
  },
}

const KNOWN_DATA_TYPES = new Set<DataType>(["string", "number", "date", "boolean"])
const KNOWN_TIERS = new Set<FilterTier>(["none", "exact", "range"])
const KNOWN_OPS = new Set<Operator>([
  "eq",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "containsAny",
])

const isString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0

// ─── Shared validator ───────────────────────────────────────────────────────
// One YAML/JSON entry → validated FieldDef or null. Failures log loudly so
// misconfig is visible.

const validateFieldEntry = (
  raw: unknown,
  source: string,
): FieldDef | null => {
  if (!raw || typeof raw !== "object") {
    Logger.warn({ source, raw }, "field entry: not an object")
    return null
  }
  const e = raw as Record<string, unknown>
  if (!isString(e["name"])) {
    Logger.warn({ source }, "field entry: missing or non-string `name`")
    return null
  }
  const name = e["name"] as string
  if (!isString(e["description"])) {
    Logger.warn({ source, name }, "field entry: missing `description`")
    return null
  }
  const description = e["description"] as string
  const dataType = e["dataType"]
  if (typeof dataType !== "string" || !KNOWN_DATA_TYPES.has(dataType as DataType)) {
    Logger.warn(
      { source, name, dataType },
      "field entry: invalid `dataType` (expected string|number|date|boolean)",
    )
    return null
  }
  const multiValued = e["multiValued"]
  if (typeof multiValued !== "boolean") {
    Logger.warn(
      { source, name },
      "field entry: missing `multiValued` (boolean)",
    )
    return null
  }
  const vespaField = isString(e["vespaField"])
    ? (e["vespaField"] as string)
    : name

  const filterRaw = e["filter"]
  if (!filterRaw || typeof filterRaw !== "object") {
    Logger.warn({ source, name }, "field entry: missing `filter` block")
    return null
  }
  const f = filterRaw as Record<string, unknown>
  const tier = f["tier"]
  if (typeof tier !== "string" || !KNOWN_TIERS.has(tier as FilterTier)) {
    Logger.warn(
      { source, name, tier },
      "field entry: invalid `filter.tier` (expected none|exact|range)",
    )
    return null
  }

  if (tier === "none") {
    return {
      name,
      description,
      dataType: dataType as DataType,
      multiValued,
      vespaField,
      filter: { tier: "none" },
    }
  }

  // exact / range — validate operators
  const opsRaw = f["operators"]
  if (!Array.isArray(opsRaw) || opsRaw.length === 0) {
    Logger.warn(
      { source, name, tier },
      "field entry: `filter.operators` must be a non-empty array",
    )
    return null
  }
  const allowed = ALLOWED_OPS[dataType as DataType][tier as FilterTier]
  const ops: Operator[] = []
  const droppedOps: string[] = []
  for (const op of opsRaw) {
    if (typeof op !== "string" || !KNOWN_OPS.has(op as Operator)) {
      droppedOps.push(`${String(op)} (unknown op)`)
      continue
    }
    if (!allowed.has(op as Operator)) {
      droppedOps.push(
        `${op} (not allowed for ${dataType} + ${tier})`,
      )
      continue
    }
    ops.push(op as Operator)
  }
  if (droppedOps.length) {
    Logger.warn(
      { source, name, droppedOps },
      "field entry: dropped invalid operators",
    )
  }
  if (ops.length === 0) {
    Logger.warn(
      { source, name },
      "field entry: no valid operators left after validation",
    )
    return null
  }

  if (tier === "exact") {
    return {
      name,
      description,
      dataType: dataType as DataType,
      multiValued,
      vespaField,
      filter: {
        tier: "exact",
        operators: ops as ExactFilterDef["operators"],
      },
    }
  }

  const encodingRaw = f["encoding"]
  const encoding =
    encodingRaw === "yyyymmddInt" ? ("yyyymmddInt" as const) : undefined
  if (dataType === "date" && encoding !== "yyyymmddInt") {
    Logger.warn(
      { source, name },
      "field entry: date+range requires `filter.encoding: yyyymmddInt`",
    )
    return null
  }
  return {
    name,
    description,
    dataType: dataType as DataType,
    multiValued,
    vespaField,
    filter: {
      tier: "range",
      operators: ops as RangeFilterDef["operators"],
      ...(encoding ? { encoding } : {}),
    },
  }
}

// ─── YAML loader ────────────────────────────────────────────────────

const resolveYamlPath = (): string => {
  const envPath = process.env["VESPA_SEARCH_FILTER_FIELDS_PATH"]?.trim()
  if (envPath) return envPath
  return resolve(process.cwd(), DEFAULT_YAML_PATH)
}

const loadFromYaml = (): ReadonlyArray<FieldDef> | null => {
  const path = resolveYamlPath()
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (err) {
    Logger.warn({ err, path }, "searchFilterFields YAML: read failed")
    return null
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    Logger.warn({ err, path }, "searchFilterFields YAML: parse error")
    return null
  }
  if (!parsed || typeof parsed !== "object") {
    Logger.warn({ path }, "searchFilterFields YAML: top-level not an object")
    return null
  }
  const root = parsed as { fields?: unknown }
  if (!Array.isArray(root.fields)) {
    Logger.warn(
      { path },
      "searchFilterFields YAML: `fields` key missing or not an array",
    )
    return null
  }
  const out: FieldDef[] = []
  for (const entry of root.fields) {
    const validated = validateFieldEntry(entry, `yaml:${path}`)
    if (validated) out.push(validated)
  }
  if (out.length === 0) {
    Logger.warn(
      { path },
      "searchFilterFields YAML: no valid fields after validation; falling through",
    )
    return null
  }
  Logger.info(
    {
      path,
      count: out.length,
      fields: out.map((f) => f.name),
    },
    "searchFilterFields: loaded from YAML",
  )
  return out
}

// ─── Top-level resolver (memoised) ──────────────────────────────────────────

let cached: ReadonlyArray<FieldDef> | null = null

/** Resolve the active filter-field config from YAML & cache */
export const getSearchFilterFields = (): ReadonlyArray<FieldDef> => {
  if (cached) return cached
  const fromYaml = loadFromYaml()
  if (fromYaml) {
    cached = fromYaml
    return cached
  }
  return []
}

/** Returns only the fields that participate in the search filter DSL
 *  (drops `tier: none`). Convenience for the Typebox schema builder. */
export const getExposedFilterFields = (): ReadonlyArray<FieldDef> =>
  getSearchFilterFields().filter((f) => f.filter.tier !== "none")

/** Test-only memo reset. */
export const __resetSearchFilterFieldsCacheForTests = (): void => {
  cached = null
}
