import { VespaSearchResponseToSearchResult } from "@xyne/vespa-ts/mappers"
import type { VespaFileSearch } from "@xyne/vespa-ts/types"
import { searchVespa } from "@/platform/search/vespa"
import type { SearchResponse } from "@/platform/shared/types"
import { describe, expect, test } from "bun:test"
import { chunkDocument } from "@/ingestion/chunking/chunks"

type MatchFeatures = {
  "query(alpha)": number
  chunk_vector_score: number
  doc_recency: number
  scaled_bm25_chunks: number
  scaled_bm25_title: number
  title_vector_score: number
}

const user = "junaid.s@xynehq.com"

const search = async (query: string): Promise<SearchResponse> => {
  return VespaSearchResponseToSearchResult(
    await searchVespa(query, user, null, null, { limit: 10 }),
    {
      chunkDocument: chunkDocument,
    },
  ) as SearchResponse
}

describe.skip("search events", () => {
  test("verbatim name search", async () => {
    const query = "Task pull business value."

    const searchResults = await search(query)
    const first = searchResults.results[0]
    expect(first).toBeDefined()
    expect(first?.type === "event" && first.name).toBe(query)
  })

  test("partial name search", async () => {
    // event fullname "Expert win prove brother situation."
    const query = "Expert win prove"

    const searchResults = await (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(
      first?.type === "event" && first.name.includes(query),
    ).toBeTrue()
  })

  test("search with description", async () => {
    const query =
      "Thus name high. Space whatever little develop student democratic. Heart whom baby decide reality in forget."

    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(first?.type === "event" && first.description).toBe(query)
  })

  test("search with partial description", async () => {
    const query = "Along say want. Yes receive statement bill Republican."

    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(
      first?.type === "event" && first.description?.includes(query),
    ).toBeTrue()
  })

  test("search with partial name and partial description", async () => {
    const query = "Picture fine Probably certain so heart"

    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(
      first?.type === "event" && first.name.includes("Picture fine"),
    ).toBeTruthy()
  })

  test("search with attendees names as a phrase", async () => {
    // the event contains attendees "Jonathon Phillips" ; searching just with their firstnames and partial event name "Their test talk face out.",
    const query = "test talk with Jonathon"
    const searchResults = (await search(query)).results

    const correctDocIndex = searchResults.findIndex(
      (i) => i.type === "event" && i.name === "Their test talk face out.",
    )

    expect(correctDocIndex).toBeLessThan(3)
    const correctDoc = searchResults[correctDocIndex]
    expect(correctDoc).toBeDefined()
    expect(
      correctDoc?.type === "event" && correctDoc.name,
    ).toBe("Their test talk face out.")
    expect(
      correctDoc?.type === "event" &&
        correctDoc.attendeesNames!.includes("Jonathon Phillips"),
    ).toBeTruthy()
  })
})

describe.skip("search mails", () => {
  test("exact subject match", async () => {
    const query = "Citizen while suddenly phone recently analysis."

    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(first?.type === "mail" && first.subject).toBe(query)
  })

  test("partial subject match", async () => {
    const query = "Prevent force difference kid"
    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(
      first?.type === "mail" && first.subject.includes(query),
    ).toBe(true)
  })

  // TODO: fix chunks search
  test("mail chunks search", async () => {
    // mail has the subject "Fill far main energy industry however simply form. "
    const query =
      "McCloud is an American television police drama that aired on NBC from 1970-77"
    const searchResults = (await search(query)).results
    const correctDocIndex = searchResults.findIndex(
      (i) =>
        i.type === "mail" &&
        i.subject === "Fill far main energy industry however simply form.",
    )

    expect(correctDocIndex).toBeLessThan(5)
  })
})

describe.skip("search files", () => {
  test("verbatim title search", async () => {
    const query = "From ACH direct debit to Prepaid card?"
    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(first?.type === "file" && first.title).toBe(query)
  })

  test("partial title match", async () => {
    const query = "Who maintains receipt"
    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(
      first?.type === "file" && first.title.includes(query),
    ).toBe(true)
  })

  test("fuzzy search", async () => {
    // title of the doc search
    const docTitleSearchedFor =
      "What tax-free retirement accounts are available for self-employed individuals?"
    const query = "tax-free retirement self employed"
    const searchResults = (await search(query)).results
    const correctDocIndex = searchResults.findIndex(
      (i) => i.type === "file" && i.title === docTitleSearchedFor,
    )
    expect(correctDocIndex).toBeLessThanOrEqual(3)
  })

  test("out-of-order search", async () => {
    // title of the doc search
    const docTitleSearchedFor =
      "Are Investment Research websites worth their premiums?"
    const query = "investment premiums worth"
    const searchResults = (await search(query)).results
    const correctDocIndex = searchResults.findIndex(
      (i) => i.type === "file" && i.title === docTitleSearchedFor,
    )

    expect(correctDocIndex).toBeLessThan(3)
  })

  test("chunks match", async () => {
    // title of the doc
    const chunkDocTitle =
      "What standards should I expect of my CPA when an error was made?"
    const query =
      "I haven't spoken to Kwame since he went off to HBS, but I did get an invitation to his graduation"
    //@ts-ignore
    const searchResults: {
      fields: VespaFileSearch & { matchfeatures: MatchFeatures }
    }[] = (await searchVespa(query, user, null, null, { limit: 10 })).root
      .children
    const correctDocIndex = searchResults.findIndex(
      (i) => i.fields?.title === chunkDocTitle,
    )

    const correctDoc = searchResults[correctDocIndex]
    expect(correctDoc).toBeDefined()
    expect(
      (correctDoc?.fields.matchfeatures.scaled_bm25_chunks ?? 0) > 0.9,
    ).toBeTrue()
    expect(correctDocIndex).toBeLessThan(3)
  })

  test("semantic search", async () => {
    const query = "what are north korea note worthy things"
    //@ts-ignore
    const searchResults: {
      fields: VespaFileSearch & { matchfeatures: MatchFeatures }
    }[] = (await searchVespa(query, user, null, null, { limit: 10 })).root
      .children
    const fileIdx = searchResults.findIndex(
      (i) => i.fields.sddocname === "file",
    )

    expect(fileIdx).toBeLessThan(3)
    const fileDoc = searchResults[fileIdx]
    expect(fileDoc).toBeDefined()
    expect(
      (fileDoc?.fields.matchfeatures.chunk_vector_score ?? 0) > 0.5,
    ).toBeTrue()
  })

  test("recent document should have higher rank", async () => {
    const query = "claim mileage for traveling"
    const searchResults = (await search(query)).results
    const r0 = searchResults[0]
    const r1 = searchResults[1]
    expect(r0).toBeDefined()
    expect(r1).toBeDefined()
    const doc1 = (r0?.type == "file" && r0.updatedAt) || 0
    const doc2 = (r1?.type == "file" && r1.updatedAt) || 0

    expect(doc1 > doc2).toBeTrue()
  })
})

describe.skip("people search", () => {
  test("name match", async () => {
    const query = "Brenda Molina"
    const searchResults = await (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(first?.type === "user" && first.name).toBe(query)
  })

  test("email match", async () => {
    const query = "nguyenstephanie@example.org"
    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(first?.type === "user" && first.email).toBe(query)
  })

  test("retrieves user document by name-based query", async () => {
    const query = "get the contact of Kim Calhoun"
    const searchResults = (await search(query)).results
    const first = searchResults[0]
    expect(first).toBeDefined()
    expect(first?.type === "user" && first.name).toBe("Kim Calhoun")
  })
})
