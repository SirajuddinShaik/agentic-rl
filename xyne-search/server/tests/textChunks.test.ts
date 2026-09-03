import { describe, expect, test } from "bun:test"

const {
  processTextContentWithVirtualPages,
  processTextPageContent,
  virtualTextPages,
} = await import("@/ingestion/chunking/textChunks")

describe("text chunking", () => {
  test("splits long text into virtual pages", () => {
    const content = Array.from(
      { length: 81 },
      (_, index) =>
        `line ${index} has enough content to produce meaningful chunks`,
    ).join("\n")

    const pages = virtualTextPages(content)

    expect(pages).toHaveLength(2)
  })

  test("stores zero-based page metadata for standard text processing", () => {
    const content = Array.from(
      { length: 81 },
      (_, index) =>
        `line ${index} has enough content to produce meaningful chunks`,
    ).join("\n")

    const result = processTextContentWithVirtualPages(content, {
      pageNumberBase: 0,
      trim: true,
    })
    const pageNumbers = new Set(
      result.chunks_map.flatMap((meta) => meta.page_numbers),
    )

    expect(result.chunks.length).toBeGreaterThan(0)
    expect(pageNumbers.has(0)).toBe(true)
    expect(pageNumbers.has(1)).toBe(true)
  })

  test("supports zero-based page metadata for scheduler text fallback", () => {
    const result = processTextPageContent(
      "This text part has enough content to survive paragraph chunking.",
      0,
    )

    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.chunks_map.every((meta) => meta.page_numbers[0] === 0)).toBe(
      true,
    )
  })
})
