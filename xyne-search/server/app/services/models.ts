import { getAvailableModels, type AvailableModelConfig } from "@/platform/ai/fetchModels"
import config from "@/config"

export class ModelNotAllowedError extends Error {
  public override readonly name = "ModelNotAllowedError"
  public readonly requestedModel?: string
  public constructor(requestedModel?: string) {
    super(
      requestedModel
        ? `Model ${requestedModel} is not allowed`
        : "No models are available",
    )
    if (requestedModel !== undefined) {
      this.requestedModel = requestedModel
    }
  }
}

const providerConfig = (): Parameters<typeof getAvailableModels>[0] => ({
  AwsAccessKey: config.AwsAccessKey,
  AwsSecretKey: config.AwsSecretKey,
  OpenAIKey: config.OpenAIKey,
  OllamaModel: config.OllamaModel,
  TogetherAIModel: config.TogetherAIModel,
  TogetherApiKey: config.TogetherApiKey,
  FireworksAIModel: config.FireworksAIModel,
  FireworksApiKey: config.FireworksApiKey,
  GeminiAIModel: config.GeminiAIModel,
  GeminiApiKey: config.GeminiApiKey,
  VertexAIModel: config.VertexAIModel,
  VertexProjectId: config.VertexProjectId,
  VertexRegion: config.VertexRegion,
  LiteLLMApiKey: config.LiteLLMApiKey,
  LiteLLMBaseUrl: config.LiteLLMBaseUrl,
})

export const getCanonicalModelCatalog = async (): Promise<
  AvailableModelConfig[]
> => getAvailableModels(providerConfig())

export const resolveCanonicalModel = async (
  requestedModel?: string,
): Promise<AvailableModelConfig> => {
  const models = await getCanonicalModelCatalog()
  if (models.length === 0) {
    throw new ModelNotAllowedError(requestedModel)
  }

  const requested = requestedModel?.trim()
  if (requested && requested !== "default") {
    const match = models.find(
      (model) =>
        model.id === requested ||
        model.labelName === requested ||
        model.actualName === requested,
    )
    if (!match) {
      throw new ModelNotAllowedError(requested)
    }
    return match
  }

  const configuredDefault = config.defaultBestModel?.trim()
  if (configuredDefault) {
    const defaultMatch = models.find(
      (model) =>
        model.id === configuredDefault ||
        model.actualName === configuredDefault ||
        model.labelName === configuredDefault,
    )
    if (defaultMatch) {
      return defaultMatch
    }
  }

  const [first] = models
  if (!first) {
    throw new ModelNotAllowedError(requestedModel)
  }
  return first
}
