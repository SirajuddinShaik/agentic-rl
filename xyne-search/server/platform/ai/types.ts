import { type Message } from "@aws-sdk/client-bedrock-runtime"
import { z } from "zod"
import { Apps } from "@xyne/vespa-ts/types"
import { entitySchema } from "@/platform/shared/types"

export const AIProviders = {
  OpenAI: "openai",
  AwsBedrock: "bedrock",
  Ollama: "ollama",
  Together: "together-ai",
  Fireworks: "fireworks",
  GoogleAI: "google-ai",
  VertexAI: "vertex-ai",
  LiteLLM: "lite-llm",
} as const
export type AIProviders = (typeof AIProviders)[keyof typeof AIProviders]

export const AwsBedrockModels = {
  Claude_3_5_Haiku: "aws-claude-3-5-haiku",
  Claude_3_5_Sonnet: "aws-claude-3-5-sonnet",
  Claude_3_5_SonnetV2: "aws-claude-3-5-sonnet-v2",
  Claude_3_7_Sonnet: "aws-claude-3-7-sonnet",
  Claude_Opus_4: "aws-claude-opus-4",
  Claude_Sonnet_4: "aws-claude-sonnet-4",

  Llama_3_1_405B: "aws-llama-3-1-405b",
  Llama_3_1_70B: "aws-llama-3-1-70b",
  Llama_3_1_8B: "aws-llama-3-1-8b",
  Llama_3_2_1B: "aws-llama-3-2-1b",
  Llama_3_2_3B: "aws-llama-3-2-3b",

  Amazon_Nova_Micro: "aws-nova-micro",
  Amazon_Nova_Lite: "aws-nova-lite",
  Amazon_Nova_Pro: "aws-nova-pro",

  CohereCmdR: "aws-cohere-cmd-r",
  CohereCmdRPlus: "aws-cohere-cmd-r-plus",

  DeepSeek_R1: "aws-deepseek-r1",
  Mistral_Large: "aws-mistral-large",
} as const
export type AwsBedrockModels =
  (typeof AwsBedrockModels)[keyof typeof AwsBedrockModels]

export const OpenAIModels = {
  Gpt_4o: "gpt-4o",
  Gpt_4o_mini: "gpt-4o-mini",
  Gpt_4: "gpt-4",
  o3_Deep_Research: "o3-deep-research",
  o4_Mini_Deep_Research: "o4-mini-deep-research",
} as const
export type OpenAIModels = (typeof OpenAIModels)[keyof typeof OpenAIModels]

export const GoogleAIModels = {
  Gemini_2_5_Flash: "googleai-gemini-2-5-flash",
  Gemini_2_0_Flash_Thinking: "googleai-gemini-2-0-flash-thinking",
} as const
export type GoogleAIModels = (typeof GoogleAIModels)[keyof typeof GoogleAIModels]

export const LiteLLMModels = {
  Claude_Sonnet_4_6: "claude-sonnet-4-6",
  Claude_Opus_4_6: "claude-opus-4-6",
  Claude_Haiku_4_5: "vertex_ai/claude-haiku-4-5@20251001",
  Gemini_3_Flash: "gemini-3-flash-preview",

  // Free, self-hosted VLLMs below.
  KIMI_LATEST: "kimi-latest",
  PRIVATE_LARGE: "private-large",
  GLM_PRIVATE: "glm-private",

  GLM_LATEST: "glm-latest",
  GLM_FLASH: "glm-flash-experimental",
  OPEN_LARGE: "open-large",
  GLM_45_AIR: "glm-45-air-curriculum-learning",

  DEEPSEEK: "deepseek",

  OPEN_FAST: "open-fast",
  MINIMAX_M2: "minimaxai/minimax-m2",

  MINIMAX_2_5: "minimaxai/minimax-2-5",

  NEMOTRON: "nemotron",
  // Proxy exposes this with a hyphen; MODELS_LIST env must spell it `gemma-4`
  // (not `gemma4`) or isModelAllowed() filters it out.
  GEMMA_4: "gemma-4",
} as const
export type LiteLLMModels = (typeof LiteLLMModels)[keyof typeof LiteLLMModels]

export const VertexAIModels = {
  // Identifiers differ from AwsBedrockModels even for the same Claude model.
  Claude_Sonnet_4: "vertex-claude-sonnet-4",
  Claude_3_7_Sonnet: "vertex-claude-3-7-sonnet",
  Claude_3_5_Sonnet: "vertex-claude-3-5-sonnet",

  // Identifiers differ from GoogleAIModels even for the same Gemini model.
  Gemini_2_5_Pro: "vertex-gemini-2-5-pro",
  Gemini_2_5_Flash: "vertex-gemini-2-5-flash",
  Gemini_3_Pro: "vertex-gemini-3-pro-preview",
  Gemini_3_Flash: "vertex-gemini-3-flash-preview",
} as const
export type VertexAIModels = (typeof VertexAIModels)[keyof typeof VertexAIModels]

// Unified enum aggregating every provider's models.
export const Models = {
  Claude_3_5_Haiku: AwsBedrockModels.Claude_3_5_Haiku,
  Claude_3_5_Sonnet: AwsBedrockModels.Claude_3_5_Sonnet,
  Claude_3_5_SonnetV2: AwsBedrockModels.Claude_3_5_SonnetV2,
  Claude_3_7_Sonnet: AwsBedrockModels.Claude_3_7_Sonnet,
  Claude_Opus_4: AwsBedrockModels.Claude_Opus_4,
  Claude_Sonnet_4: AwsBedrockModels.Claude_Sonnet_4,
  Llama_3_1_405B: AwsBedrockModels.Llama_3_1_405B,
  Llama_3_1_70B: AwsBedrockModels.Llama_3_1_70B,
  Llama_3_1_8B: AwsBedrockModels.Llama_3_1_8B,
  Llama_3_2_1B: AwsBedrockModels.Llama_3_2_1B,
  Llama_3_2_3B: AwsBedrockModels.Llama_3_2_3B,
  Amazon_Nova_Micro: AwsBedrockModels.Amazon_Nova_Micro,
  Amazon_Nova_Lite: AwsBedrockModels.Amazon_Nova_Lite,
  Amazon_Nova_Pro: AwsBedrockModels.Amazon_Nova_Pro,
  CohereCmdR: AwsBedrockModels.CohereCmdR,
  CohereCmdRPlus: AwsBedrockModels.CohereCmdRPlus,
  DeepSeek_R1: AwsBedrockModels.DeepSeek_R1,
  Mistral_Large: AwsBedrockModels.Mistral_Large,

  Gpt_4o: OpenAIModels.Gpt_4o,
  Gpt_4o_mini: OpenAIModels.Gpt_4o_mini,
  Gpt_4: OpenAIModels.Gpt_4,
  o3_Deep_Research: OpenAIModels.o3_Deep_Research,
  o4_Mini_Deep_Research: OpenAIModels.o4_Mini_Deep_Research,

  Gemini_2_5_Flash: GoogleAIModels.Gemini_2_5_Flash,
  Gemini_2_0_Flash_Thinking: GoogleAIModels.Gemini_2_0_Flash_Thinking,

  Vertex_Claude_Sonnet_4: VertexAIModels.Claude_Sonnet_4,
  Vertex_Gemini_2_5_Pro: VertexAIModels.Gemini_2_5_Pro,
  Vertex_Gemini_2_5_Flash: VertexAIModels.Gemini_2_5_Flash,
  Vertex_Gemini_3_Pro: VertexAIModels.Gemini_3_Pro,
  Vertex_Gemini_3_Flash: VertexAIModels.Gemini_3_Flash,
  LiteLLM_Claude_Sonnet_4_6: LiteLLMModels.Claude_Sonnet_4_6,
  LiteLLM_Claude_Opus_4_6: LiteLLMModels.Claude_Opus_4_6,
  LiteLLM_Claude_Haiku_4_5: LiteLLMModels.Claude_Haiku_4_5,
  LiteLLM_Gemini_3_Flash: LiteLLMModels.Gemini_3_Flash,

  KIMI_LATEST: LiteLLMModels.KIMI_LATEST,
  PRIVATE_LARGE: LiteLLMModels.PRIVATE_LARGE,
  GLM_PRIVATE: LiteLLMModels.GLM_PRIVATE,

  GLM_LATEST: LiteLLMModels.GLM_LATEST,
  GLM_FLASH: LiteLLMModels.GLM_FLASH,
  OPEN_LARGE: LiteLLMModels.OPEN_LARGE,
  GLM_45_AIR: LiteLLMModels.GLM_45_AIR,

  DEEPSEEK: LiteLLMModels.DEEPSEEK,

  MINIMAX_2_5: LiteLLMModels.MINIMAX_2_5,

  OPEN_FAST: LiteLLMModels.OPEN_FAST,
  MINIMAX_M2: LiteLLMModels.MINIMAX_M2,

  NEMOTRON: LiteLLMModels.NEMOTRON,
  GEMMA_4: LiteLLMModels.GEMMA_4,
} as const
export type Models = (typeof Models)[keyof typeof Models]

// Which providers serve each model. Keyed by display name, not model id,
// because the same model has different ids per provider.
export const ModelProviderAvailability: Record<string, AIProviders[]> = {
  // Served by more than one provider.
  "Claude 3.5 Haiku": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude 3.5 Sonnet": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude 3.5 Sonnet V2": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude 3.7 Sonnet": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude Opus 4": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude Sonnet 4": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Gemini 2.5 Flash": [AIProviders.GoogleAI, AIProviders.VertexAI],

  // Single-provider models.
  "Llama 3.1 405B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.1 70B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.1 8B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.2 1B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.2 3B Instruct": [AIProviders.AwsBedrock],
  "Amazon Nova Micro": [AIProviders.AwsBedrock],
  "Amazon Nova Lite": [AIProviders.AwsBedrock],
  "Amazon Nova Pro": [AIProviders.AwsBedrock],
  "Cohere Command R": [AIProviders.AwsBedrock],
  "Cohere Command R+": [AIProviders.AwsBedrock],
  "DeepSeek R1": [AIProviders.AwsBedrock],
  "Mistral Large": [AIProviders.AwsBedrock],
  "GPT-4o": [AIProviders.OpenAI],
  "GPT-4o Mini": [AIProviders.OpenAI],
  "GPT-4": [AIProviders.OpenAI],
  "Gemini 2.0 Flash Thinking": [AIProviders.GoogleAI],
  "GLM Latest": [AIProviders.LiteLLM],
  "LiteLLM Claude Sonnet 4.5": [AIProviders.LiteLLM],
  "LiteLLM Gemini 3 Pro": [AIProviders.LiteLLM],
  "LiteLLM Gemini 3 Flash": [AIProviders.LiteLLM],
}

export const ModelDisplayNames = {
  AWS_CLAUDE_3_5_HAIKU: "Claude 3.5 Haiku",
  AWS_CLAUDE_3_5_SONNET: "Claude 3.5 Sonnet",
  AWS_CLAUDE_3_5_SONNET_V2: "Claude 3.5 Sonnet V2",
  AWS_CLAUDE_3_7_SONNET: "Claude 3.7 Sonnet",
  AWS_CLAUDE_OPUS_4: "Claude Opus 4",
  AWS_CLAUDE_SONNET_4: "Claude Sonnet 4",
  AWS_LLAMA_3_1_405B: "Llama 3.1 405B Instruct",
  AWS_LLAMA_3_1_70B: "Llama 3.1 70B Instruct",
  AWS_LLAMA_3_1_8B: "Llama 3.1 8B Instruct",
  AWS_LLAMA_3_2_1B: "Llama 3.2 1B Instruct",
  AWS_LLAMA_3_2_3B: "Llama 3.2 3B Instruct",
  AWS_AMAZON_NOVA_MICRO: "Amazon Nova Micro",
  AWS_AMAZON_NOVA_LITE: "Amazon Nova Lite",
  AWS_AMAZON_NOVA_PRO: "Amazon Nova Pro",
  AWS_COHERE_CMD_R: "Cohere Command R",
  AWS_COHERE_CMD_R_PLUS: "Cohere Command R+",
  AWS_DEEPSEEK_R1: "DeepSeek R1",
  AWS_MISTRAL_LARGE: "Mistral Large",

  OPENAI_GPT_4O: "GPT-4o",
  OPENAI_GPT_4O_MINI: "GPT-4o Mini",
  OPENAI_GPT_4: "GPT-4",
  OPENAI_o3_DEEP_RESEARCH: "o3 Deep Research",
  OPENAI_o4_MINI_DEEP_RESEARCH: "o4 Mini Deep Research",

  GOOGLEAI_GEMINI_2_5_FLASH: "Gemini 2.5 Flash",
  GOOGLEAI_GEMINI_2_0_FLASH_THINKING: "Gemini 2.0 Flash Thinking",

  VERTEX_CLAUDE_SONNET_4: "Claude Sonnet 4",
  VERTEX_GEMINI_2_5_PRO: "Gemini 2.5 Pro",
  VERTEX_GEMINI_2_5_FLASH: "Gemini 2.5 Flash",
  VERTEX_GEMINI_3_PRO: "Gemini 3 Pro",
  VERTEX_GEMINI_3_FLASH: "Gemini 3 Flash",
  LITELLM_CLAUDE_SONNET_4_6: "Claude Sonnet 4.6",
  LITELLM_CLAUDE_OPUS_4_6: "Claude Opus 4.6",
  LITELLM_GEMINI_3_FLASH: "Gemini 3 Flash",

  LITELLM_KIMI_LATEST: "KIMI Latest",
  LITELLM_CLAUDE_HAIKU_3_5: "LiteLLM Claude Haiku 3.5",
  LITELLM_CLAUDE_HAIKU_3_5_20241022: "LiteLLM Claude Haiku 3.5 20241022",
  LITELLM_CLAUDE_HAIKU_4_5: "Claude Haiku 4.5",
  LITELLM_PRIVATE_LARGE: "LiteLLM Private Large",
  LITELLM_GLM_PRIVATE: "GLM Private",

  LITELLM_GLM_LATEST: "GLM Latest",
  LITELLM_GLM_FLASH: "GLM Flash",
  LITELLM_OPEN_LARGE: "Open Large",
  LITELLM_GLM_45_AIR: "GLM 4.5 AIR",

  LITELLM_DEEPSEEK: "DeepSeek",

  LITELLM_MINIMAX_2_5: "Minmax 2.5",

  LITELLM_OPEN_FAST: "Open Fast",
  LITELLM_MINIMAX_M2: "Minmax M2",

  LITELLM_NEMOTRON: "Nemotron",
  LITELLM_GEMMA_4: "Gemma 4",
} as const
export type ModelDisplayNames =
  (typeof ModelDisplayNames)[keyof typeof ModelDisplayNames]

export const QueryCategory = {
  Self: "Self",
  InternalPerson: "InternalPerson",
  ExternalPerson: "ExternalPerson",
  Other: "Other",
} as const
export type QueryCategory = (typeof QueryCategory)[keyof typeof QueryCategory]

export const QueryType = {
  SearchWithoutFilters: "SearchWithoutFilters",
  GetItems: "GetItems",
  SearchWithFilters: "SearchWithFilters",
} as const
export type QueryType = (typeof QueryType)[keyof typeof QueryType]

export type Cost = {
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}

export type TimeDirection = "next" | "prev" | null
export interface TemporalClassifier {
  direction: TimeDirection | null
  filterQuery: string | null
}

export type RuntimeModelId = Models | string

export interface ModelParams {
  max_new_tokens?: number
  top_p?: number
  temperature?: number
  modelId: RuntimeModelId
  systemPrompt?: string
  userCtx?: string
  stream: boolean
  json?: boolean
  messages?: Message[]
  reasoning?: boolean
  prompt?: string
  agentPrompt?: string
  imageFileNames?: string[]
  tools?: Array<{
    name: string
    description?: string
    parameters?: any
  }>
  tool_choice?: "auto" | "none" | "required"
  parallel_tool_calls?: boolean
  webSearch?: boolean
  agentWithNoIntegrations?: boolean
  deepResearchEnabled?: boolean
}

export interface ConverseResponse {
  text?: string
  metadata?: any
  cost?: number
  reasoning?: boolean
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  sources?: WebSearchSource[]
  groundingSupports?: GroundingSupport[]
}

export interface WebSearchSource {
  uri: string
  title: string
  searchQuery?: string
}

export interface GroundingSupport {
  segment: {
    startIndex: number
    endIndex: number
    text: string
  }
  groundingChunkIndices: number[]
}

export interface LLMProvider {
  converseStream(
    messages: Message[],
    params?: ModelParams,
  ): AsyncIterableIterator<ConverseResponse>
  converseStream(
    messages: Message[],
    params?: ModelParams,
  ): AsyncIterableIterator<ConverseResponse>
  converse(messages: Message[], params?: ModelParams): Promise<ConverseResponse>
}

export interface AnswerResponse {
  answer: string | null
}

export const QueryAnalysisSchema = z.object({
  category: z.nativeEnum(QueryCategory),
  mentionedNames: z.array(z.string()),
  mentionedEmails: z.array(z.string()),
})

export type QueryAnalysisResult = z.infer<typeof QueryAnalysisSchema>

export const initialResultsOrRewriteSchema = z.object({
  answer: z.string().optional(),
  citations: z.array(z.number()),
  rewrittenQueries: z.array(z.string()).optional(),
})

export type ResultsOrRewrite = z.infer<typeof initialResultsOrRewriteSchema>

export const SearchAnswerResponse = z.object({
  answer: z.string().nullable(),
  citations: z.array(z.number()).nullable(),
  searchQueries: z.array(z.string()),
  usefulIndex: z.array(z.number()),
})

export const ToolAnswerResponse = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.any()).optional(),
})

export const MailParticipantSchema = z.object({
  from: z.array(z.string()).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),
})

export type MailParticipant = z.infer<typeof MailParticipantSchema>

// Zoho Desk ticket filters.
export const TicketParticipantSchema = z.object({
  ticketNumber: z.array(z.string()).optional(), // e.g. "763526", "751480"

  assigneeEmail: z.array(z.string()).optional(),
  contact: z.array(z.string()).optional(),
  departmentName: z.array(z.string()).optional(),

  status: z.array(z.string()).optional(), // Open, Closed, On Hold, etc.
  priority: z.array(z.string()).optional(), // High, Medium, Low
  classification: z.array(z.string()).optional(), // Incident, Problem, Request, Question

  category: z.array(z.string()).optional(),
  subCategory: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),

  accountName: z.array(z.string()).optional(),
  productName: z.array(z.string()).optional(),
  teamName: z.array(z.string()).optional(),
  merchantId: z.array(z.string()).optional(), // custom field

  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),

  channel: z.array(z.string()).optional(), // Email, Phone, Chat, Web, etc.

  isOverDue: z.boolean().optional(),
  isResponseOverdue: z.boolean().optional(),
  isEscalated: z.boolean().optional(),
})

export type TicketParticipant = z.infer<typeof TicketParticipantSchema>

export const FiltersSchema = z.object({
  apps: z.array(z.nativeEnum(Apps)).nullable(),
  entities: z.array(entitySchema).nullable(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  timestampField: z
    .enum(["createdTime", "modifiedTime", "closedTime", "dueDate"])
    .optional(), // which time field to filter on, for schemas with several (e.g. ticket)
  sortDirection: z.string().optional(),
  count: z.preprocess((val) => (val == null ? 5 : val), z.number()),
  offset: z.preprocess((val) => (val == null ? 0 : val), z.number()),
  mailParticipants: MailParticipantSchema.optional(),
  ticketParticipants: TicketParticipantSchema.optional(),
})

const TemporalClassifierSchema = z.object({
  direction: z.union([z.literal("prev"), z.literal("next")]).nullable(),
})

export const GetItems = z
  .object({
    type: z.literal(QueryType.GetItems),
    isFollowUp: z.boolean().optional(),
    filters: FiltersSchema,
    filterQuery: z.string().nullable(),
  })
  .merge(TemporalClassifierSchema)

export const SearchWithFilters = z
  .object({
    type: z.literal(QueryType.SearchWithFilters),
    isFollowUp: z.boolean().optional(),
    filters: FiltersSchema,
    filterQuery: z.string().nullable(),
  })
  .merge(TemporalClassifierSchema)

export const QueryRouterResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(QueryType.SearchWithoutFilters),
      isFollowUp: z.boolean().optional(),
      filters: FiltersSchema,
      filterQuery: z.string().nullable(),
    })
    .merge(TemporalClassifierSchema),
  SearchWithFilters,
  GetItems,
])

export type QueryRouterLLMResponse = z.infer<typeof QueryRouterResponseSchema>

export interface ChainBreakClassifications {
  availableChainBreaks: Array<{
    chainIndex: number
    messageIndex: number
    originalQuery: string
    classification: QueryRouterLLMResponse
  }>
  usage: string
}

export const QueryContextRank = z.object({
  canBeAnswered: z.boolean(),
  contextualChunks: z.array(z.number()),
})

export type QueryContextRank = z.infer<typeof QueryContextRank>

export type QueryRouterResponse = z.infer<typeof QueryRouterResponseSchema>

interface TextQueryItem {
  type: "text"
  value: string
}

interface PillValue {
  title: string
  docId: string
  wholeSheet?: boolean
  threadId?: string
  app?: Apps
  entity?: string
  url?: string
  parentThreadId?: string
}

interface PillQueryItem {
  type: "pill"
  value: PillValue
}

interface LinkQueryItem {
  type: "link"
  value: string
}

type UserQueryItem = TextQueryItem | PillQueryItem | LinkQueryItem

export type UserQuery = UserQueryItem[]
