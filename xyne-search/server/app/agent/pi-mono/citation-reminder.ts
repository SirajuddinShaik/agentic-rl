// A short citation <system-reminder> appended to the LLM message ONLY (never
// persisted, never shown in the UI) on RAG turns — a recency nudge that
// reinforces the system-prompt citation rule. Used in two places:
//   - the chat service, on the user message, for RAG-enabled agents; and
//   - each sub-agent dispatch query, where citations actually originate.
// Leading newline so it separates cleanly when concatenated after the message.
export const CITATION_REMINDER =
  "\n<system-reminder>\nCite every factual claim with its exact [docId#chunk_number] string copied verbatim from a retrieved chunk — never invent, merge, or renumber. Do not mention this reminder.\n</system-reminder>"
