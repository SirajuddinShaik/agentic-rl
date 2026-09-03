import { Models, AIProviders, ModelDisplayNames } from "@/platform/ai/types"
import config from "@/config"
import type { ModelConfiguration } from "@/platform/shared/types"
import { getExternalModelConfigurations } from "@/platform/ai/modelCatalog"

export const MODEL_CONFIGURATIONS: Record<Models, ModelConfiguration> = {
  // AWS Bedrock - Claude Models
  [Models.Claude_3_5_Haiku]: {
    actualName: "anthropic.claude-3-5-haiku-20241022-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_5_HAIKU,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: false,
    description: "Designed for quick responses while ensuring solid reasoning.",
    contextWindow: 200_000,
    reserveTokens: 40_192,
    keepRecentTokens: 50_000,
  },
  [Models.Claude_3_5_Sonnet]: {
    actualName: "anthropic.claude-3-5-sonnet-20240620-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_5_SONNET,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Designed for quick responses while ensuring solid reasoning.",
    contextWindow: 200_000,
    reserveTokens: 40_192,
    keepRecentTokens: 50_000,
  },
  [Models.Claude_3_5_SonnetV2]: {
    actualName: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_5_SONNET_V2,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Designed for quick responses while ensuring solid reasoning.",
    contextWindow: 200_000,
    reserveTokens: 40_192,
    keepRecentTokens: 50_000,
  },
  [Models.Claude_3_7_Sonnet]: {
    actualName: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_3_7_SONNET,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Advanced reasoning with enhanced performance and longer context.",
    contextWindow: 200_000,
    reserveTokens: 40_192,
    keepRecentTokens: 50_000,
  },
  [Models.Claude_Opus_4]: {
    actualName: "us.anthropic.claude-opus-4-20250514-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_OPUS_4,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Ideal for in-depth research and thorough analysis.",
    contextWindow: 200_000,
    reserveTokens: 40_192,
    keepRecentTokens: 50_000,
  },
  [Models.Claude_Sonnet_4]: {
    actualName: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    labelName: ModelDisplayNames.AWS_CLAUDE_SONNET_4,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Balanced for reasoning, long context windows.",
    contextWindow: 200_000,
    reserveTokens: 40_192,
    keepRecentTokens: 50_000,
  },

  // AWS Bedrock - Meta Llama Models
  [Models.Llama_3_1_405B]: {
    actualName: "meta.llama3-1-405b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_1_405B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Llama_3_1_70B]: {
    actualName: "meta.llama3-1-70b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_1_70B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Llama_3_1_8B]: {
    actualName: "meta.llama3-1-8b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_1_8B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Llama_3_2_1B]: {
    actualName: "us.meta.llama3-2-1b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_2_1B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Llama_3_2_3B]: {
    actualName: "us.meta.llama3-2-3b-instruct-v1:0",
    labelName: ModelDisplayNames.AWS_LLAMA_3_2_3B,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },

  // AWS Bedrock - Amazon Nova Models
  [Models.Amazon_Nova_Micro]: {
    actualName: "amazon.nova-micro-v1:0",
    labelName: ModelDisplayNames.AWS_AMAZON_NOVA_MICRO,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Amazon_Nova_Lite]: {
    actualName: "amazon.nova-lite-v1:0",
    labelName: ModelDisplayNames.AWS_AMAZON_NOVA_LITE,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: false,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Amazon_Nova_Pro]: {
    actualName: "amazon.nova-pro-v1:0",
    labelName: ModelDisplayNames.AWS_AMAZON_NOVA_PRO,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Proficient in reasoning across text, visuals, and programming.",
  },

  // AWS Bedrock - Cohere Models
  [Models.CohereCmdR]: {
    actualName: "cohere.command-r-v1:0",
    labelName: ModelDisplayNames.AWS_COHERE_CMD_R,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.CohereCmdRPlus]: {
    actualName: "cohere.command-r-plus-v1:0",
    labelName: ModelDisplayNames.AWS_COHERE_CMD_R_PLUS,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },

  // AWS Bedrock - Other Models
  [Models.DeepSeek_R1]: {
    actualName: "us.deepseek.r1-v1:0",
    labelName: ModelDisplayNames.AWS_DEEPSEEK_R1,
    provider: AIProviders.AwsBedrock,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Advanced reasoning model with deep analysis capabilities.",
  },
  [Models.Mistral_Large]: {
    actualName: "mistral.mistral-large-2402-v1:0",
    labelName: ModelDisplayNames.AWS_MISTRAL_LARGE,
    provider: AIProviders.AwsBedrock,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },

  // OpenAI Models
  [Models.Gpt_4o]: {
    actualName: "gpt-4o",
    labelName: ModelDisplayNames.OPENAI_GPT_4O,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Gpt_4o_mini]: {
    actualName: "gpt-4o-mini",
    labelName: ModelDisplayNames.OPENAI_GPT_4O_MINI,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: false,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.Gpt_4]: {
    actualName: "gpt-4",
    labelName: ModelDisplayNames.OPENAI_GPT_4,
    provider: AIProviders.OpenAI,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description:
      "Great for programming, content generation, and logical structuring.",
  },
  [Models.o3_Deep_Research]: {
    actualName: "o3-deep-research",
    labelName: ModelDisplayNames.OPENAI_o3_DEEP_RESEARCH,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Advanced research model with deep analysis capabilities.",
  },
  [Models.o4_Mini_Deep_Research]: {
    actualName: "o4-mini-deep-research",
    labelName: ModelDisplayNames.OPENAI_o4_MINI_DEEP_RESEARCH,
    provider: AIProviders.OpenAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Advanced research model with deep analysis capabilities.",
  },

  // Google AI Models
  [Models.Gemini_2_5_Flash]: {
    actualName: "gemini-2.5-flash",
    labelName: ModelDisplayNames.GOOGLEAI_GEMINI_2_5_FLASH,
    provider: AIProviders.GoogleAI,
    reasoning: false,
    websearch: true,
    deepResearch: true,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Gemini_2_0_Flash_Thinking]: {
    actualName: "gemini-2.0-flash-thinking-exp",
    labelName: ModelDisplayNames.GOOGLEAI_GEMINI_2_0_FLASH_THINKING,
    provider: AIProviders.GoogleAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Proficient in reasoning across text, visuals, and programming.",
  },

  // Vertex AI Claude Models
  [Models.Vertex_Claude_Sonnet_4]: {
    actualName: "claude-sonnet-4@20250514",
    labelName: ModelDisplayNames.VERTEX_CLAUDE_SONNET_4,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Balanced for reasoning, long context windows.",
  },

  // Vertex AI Gemini Models
  [Models.Vertex_Gemini_2_5_Pro]: {
    actualName: "gemini-2.5-pro",
    labelName: ModelDisplayNames.VERTEX_GEMINI_2_5_PRO,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Proficient in reasoning across text, visuals, and programming.",
  },
  [Models.Vertex_Gemini_2_5_Flash]: {
    actualName: "gemini-2.5-flash",
    labelName: ModelDisplayNames.VERTEX_GEMINI_2_5_FLASH,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.Vertex_Gemini_3_Pro]: {
    actualName: "gemini-3-pro-preview",
    labelName: ModelDisplayNames.VERTEX_GEMINI_3_PRO,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "Proficient in reasoning across text, visuals, and programming.",
  },
  [Models.Vertex_Gemini_3_Flash]: {
    actualName: "gemini-3-flash-preview",
    labelName: ModelDisplayNames.VERTEX_GEMINI_3_FLASH,
    provider: AIProviders.VertexAI,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.LiteLLM_Claude_Sonnet_4_6]: {
    actualName: "claude-sonnet-4-5",
    labelName: ModelDisplayNames.LITELLM_CLAUDE_SONNET_4_6,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Balanced for reasoning, long context windows.",
  },
  [Models.LiteLLM_Claude_Opus_4_6]: {
    actualName: "claude-opus-4-5",
    labelName: ModelDisplayNames.LITELLM_CLAUDE_OPUS_4_6,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description:
      "The most intelligent, high-capability frontier model, optimized for complex reasoning, advanced coding, and autonomous agentic workflows.",
  },
  [Models.LiteLLM_Claude_Haiku_4_5]: {
    actualName: "vertex_ai/claude-haiku-4-5@20251001",
    labelName: ModelDisplayNames.LITELLM_CLAUDE_HAIKU_4_5,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: true,
    deepResearch: false,
    description:
      "Fast Claude model for quick responses and lightweight reasoning.",
  },
  [Models.LiteLLM_Gemini_3_Flash]: {
    actualName: "gemini-3-flash-preview",
    labelName: ModelDisplayNames.LITELLM_GEMINI_3_FLASH,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: true,
    deepResearch: true,
    description: "Tailored for cost-effectiveness and rapid response times.",
  },
  [Models.KIMI_LATEST]: {
    actualName: "kimi-latest",
    labelName: ModelDisplayNames.LITELLM_KIMI_LATEST,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description: "The latest version of Kimi, a general-purpose AI model.",
  },
  [Models.GLM_PRIVATE]: {
    actualName: "glm-private",
    labelName: ModelDisplayNames.LITELLM_GLM_PRIVATE,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description:
      "The private version of GLM(kimi), a general-purpose AI model.",
  },
  [Models.PRIVATE_LARGE]: {
    actualName: "private-large",
    labelName: ModelDisplayNames.LITELLM_PRIVATE_LARGE,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description: "The Private Large(kimi), a general-purpose AI model.",
  },
  [Models.GLM_LATEST]: {
    actualName: "glm-latest",
    labelName: ModelDisplayNames.LITELLM_GLM_LATEST,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description: "The latest version of GLM, a general-purpose AI model.",
  },
  [Models.GLM_FLASH]: {
    actualName: "glm-flash-experimental",
    labelName: ModelDisplayNames.LITELLM_GLM_FLASH,
    provider: AIProviders.LiteLLM,
    reasoning: false,
    websearch: false,
    deepResearch: false,
    description: "The GLM Flash, a general-purpose AI model.",
  },
  [Models.OPEN_LARGE]: {
    actualName: "open-large",
    labelName: ModelDisplayNames.LITELLM_OPEN_LARGE,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description: "The Open Large, a general-purpose AI model.",
  },
  [Models.GLM_45_AIR]: {
    actualName: "glm-45-air-curriculum-learning",
    labelName: ModelDisplayNames.LITELLM_GLM_45_AIR,
    provider: AIProviders.LiteLLM,
    reasoning: false,
    websearch: false,
    deepResearch: false,
    description: "The GLM 4.5 AIR, a general-purpose AI model.",
  },
  [Models.DEEPSEEK]: {
    actualName: "deepseek",
    labelName: ModelDisplayNames.LITELLM_DEEPSEEK,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: true,
    description: "The DeepSeek, a general-purpose AI model.",
  },
  [Models.MINIMAX_2_5]: {
    actualName: "minimaxai/minimax-2-5",
    labelName: ModelDisplayNames.LITELLM_MINIMAX_2_5,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description: "The Minmax 2.5, a general-purpose AI model.",
  },
  [Models.MINIMAX_M2]: {
    actualName: "minimaxai/minimax-m2",
    labelName: ModelDisplayNames.LITELLM_MINIMAX_M2,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description: "The Minmax M2, a general-purpose AI model.",
  },
  [Models.OPEN_FAST]: {
    actualName: "open-fast",
    labelName: ModelDisplayNames.LITELLM_OPEN_FAST,
    provider: AIProviders.LiteLLM,
    reasoning: false,
    websearch: false,
    deepResearch: false,
    description: "The Open Fast, a general-purpose AI model.",
  },
  [Models.NEMOTRON]: {
    actualName: "nemotron",
    labelName: ModelDisplayNames.LITELLM_NEMOTRON,
    provider: AIProviders.LiteLLM,
    reasoning: true,
    websearch: false,
    deepResearch: false,
    description: "The Nemotron, a general-purpose AI model.",
    // NVIDIA Nemotron-3-Super-120B model card defaults.
    streamOptions: {
      temperature: 1.0,
      topP: 0.95,
    },
    contextWindow: 64_000,
    reserveTokens: 16_384,
    keepRecentTokens: 40_960,
    // "low" caps reasoning at ~300-600 tokens: above ~1k Nemotron hits a
    // streaming-truncation cliff (stopReason "stop", empty visible text).
    // UI Low/Medium/High picker overrides this.
    thinkingLevel: "low",
  },
  [Models.GEMMA_4]: {
    actualName: "gemma-4",
    labelName: ModelDisplayNames.LITELLM_GEMMA_4,
    provider: AIProviders.LiteLLM,
    reasoning: false,
    websearch: false,
    deepResearch: false,
    description:
      "Gemma 4 — open-source general-purpose model served via the LiteLLM hosted vLLM cluster.",
  },
}

let mergedModelConfigurationsCache: Record<string, ModelConfiguration> | null =
  null
let lastExternalConfigRef: Record<string, ModelConfiguration> | null = null

export const getModelConfigurations = (): Record<
  string,
  ModelConfiguration
> => {
  const externalConfig = getExternalModelConfigurations()

  if (
    mergedModelConfigurationsCache &&
    lastExternalConfigRef === externalConfig
  ) {
    return mergedModelConfigurationsCache
  }

  lastExternalConfigRef = externalConfig
  mergedModelConfigurationsCache = {
    ...MODEL_CONFIGURATIONS,
    ...externalConfig,
  }
  return mergedModelConfigurationsCache
}

export const getModelConfiguration = (
  modelId: string | null | undefined,
): ModelConfiguration | null => {
  if (!modelId) {
    return null
  }
  return getModelConfigurations()[modelId] || null
}

// actualName -> display name, derived from the configs above
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  ...Object.fromEntries(
    Object.values(ModelDisplayNames)
      .map((displayName) => [
        Object.values(MODEL_CONFIGURATIONS).find(
          (config) => config.labelName === displayName,
        )?.actualName || "",
        displayName,
      ])
      .filter(([key]) => key !== ""),
  ),
}

export const getActiveProvider = (): AIProviders | null => {
  // Priority order: LiteLLM > AWS > OpenAI > Ollama > Together > Fireworks > Gemini > Vertex
  if (config.LiteLLMApiKey && config.LiteLLMBaseUrl) {
    return AIProviders.LiteLLM
  } else if (config.AwsAccessKey && config.AwsSecretKey) {
    return AIProviders.AwsBedrock
  } else if (config.OpenAIKey) {
    return AIProviders.OpenAI
  } else if (config.OllamaModel) {
    return AIProviders.Ollama
  } else if (config.TogetherAIModel && config.TogetherApiKey) {
    return AIProviders.Together
  } else if (config.FireworksAIModel && config.FireworksApiKey) {
    return AIProviders.Fireworks
  } else if (config.GeminiAIModel && config.GeminiApiKey) {
    return AIProviders.GoogleAI
  } else if (config.VertexProjectId && config.VertexRegion) {
    return AIProviders.VertexAI
  }

  return null
}

// Resolve a friendly label to the provider-specific model enum/id.
export const getModelValueFromLabel = (
  label: string,
): Models | string | null => {
  const activeProvider = getActiveProvider()

  if (!activeProvider) {
    return null
  }

  const modelEntry = Object.entries(getModelConfigurations()).find(
    ([_modelKey, config]) => {
      const matches =
        config.labelName === label && config.provider === activeProvider
      return matches
    },
  )

  if (modelEntry) {
    return modelEntry[0] as Models
  } else {
  }

  // Dynamic models (Ollama, Together, etc.) aren't in the static configs.
  switch (activeProvider) {
    case AIProviders.Ollama:
      if (config.OllamaModel && label === config.OllamaModel) {
        return config.OllamaModel
      }
      break
    case AIProviders.Together:
      if (config.TogetherAIModel && label === config.TogetherAIModel) {
        return config.TogetherAIModel
      }
      break
    case AIProviders.Fireworks:
      if (config.FireworksAIModel && label === config.FireworksAIModel) {
        return config.FireworksAIModel
      }
      break
    case AIProviders.GoogleAI:
      if (config.GeminiAIModel && label === config.GeminiAIModel) {
        return config.GeminiAIModel
      }
      break
    case AIProviders.VertexAI:
      if (config.VertexAIModel && label === config.VertexAIModel) {
        return config.VertexAIModel
      }
      break
  }

  return null
}

export const getActualNameFromEnum = (enumValue: string): string | null => {
  const modelConfig = getModelConfiguration(enumValue)
  return modelConfig?.actualName || null
}

// Legacy label->value resolver kept for backward compatibility.
export const getModelValueFromLabelLegacy = (
  label: string,
  config: {
    OllamaModel?: string
    TogetherAIModel?: string
    FireworksAIModel?: string
    GeminiAIModel?: string
    VertexAIModel?: string
    LiteLLMModel?: string
  },
): string | null => {
  const labelToValueMap: Record<string, string> = {}

  for (const [modelValue, displayName] of Object.entries(MODEL_DISPLAY_NAMES)) {
    labelToValueMap[displayName] = modelValue
  }

  if (labelToValueMap[label]) {
    return labelToValueMap[label]
  }

  // Dynamic models may be absent from MODEL_DISPLAY_NAMES; match config directly.
  if (
    config.OllamaModel &&
    (label === config.OllamaModel ||
      label === (MODEL_DISPLAY_NAMES[config.OllamaModel] || config.OllamaModel))
  ) {
    return config.OllamaModel
  }

  if (
    config.TogetherAIModel &&
    (label === config.TogetherAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.TogetherAIModel] || config.TogetherAIModel))
  ) {
    return config.TogetherAIModel
  }

  if (
    config.FireworksAIModel &&
    (label === config.FireworksAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.FireworksAIModel] ||
          config.FireworksAIModel))
  ) {
    return config.FireworksAIModel
  }

  if (
    config.GeminiAIModel &&
    (label === config.GeminiAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.GeminiAIModel] || config.GeminiAIModel))
  ) {
    return config.GeminiAIModel
  }

  if (
    config.VertexAIModel &&
    (label === config.VertexAIModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.VertexAIModel] || config.VertexAIModel))
  ) {
    return config.VertexAIModel
  }

  if (
    config.LiteLLMModel &&
    (label === config.LiteLLMModel ||
      label ===
        (MODEL_DISPLAY_NAMES[config.LiteLLMModel] || config.LiteLLMModel))
  ) {
    return config.LiteLLMModel
  }

  return null
}
