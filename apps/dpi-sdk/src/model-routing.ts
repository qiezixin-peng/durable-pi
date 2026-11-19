import type { ModelCapabilitySupport, ModelInfo } from "./api.js";

export interface ModelRequirements {
  textInput?: boolean;
  imageInput?: boolean;
  toolCalling?: boolean;
  streaming?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  minimumContextWindow?: number;
  minimumOutputTokens?: number;
  /** Unsafe for execution tasks; useful only when a human deliberately accepts uncertainty. */
  allowUnknown?: boolean;
}

export interface ModelCompatibility {
  eligible: boolean;
  reasons: string[];
}

const support = (
  value: ModelCapabilitySupport,
  label: string,
  allowUnknown: boolean,
  reasons: string[],
) => {
  if (value === "supported") return;
  if (value === "unknown" && allowUnknown) return;
  reasons.push(`${label} is ${value}`);
};

/** Capability gate only. Quality, stability, latency and price ranking belong to Model Policy. */
export function modelCompatibility(model: ModelInfo, requirements: ModelRequirements): ModelCompatibility {
  const reasons: string[] = [];
  const capabilities = model.capabilities;
  const allowUnknown = requirements.allowUnknown === true;
  for (const [required, value, label] of [
    [requirements.textInput, capabilities.textInput, "text input"],
    [requirements.imageInput, capabilities.imageInput, "image input"],
    [requirements.toolCalling, capabilities.toolCalling, "tool calling"],
    [requirements.streaming, capabilities.streaming, "streaming"],
    [requirements.structuredOutput, capabilities.structuredOutput, "structured output"],
    [requirements.reasoning, capabilities.reasoning, "reasoning"],
  ] as const)
    if (required) support(value, label, allowUnknown, reasons);
  if (
    requirements.minimumContextWindow !== undefined &&
    capabilities.contextWindow < requirements.minimumContextWindow
  )
    reasons.push(
      `context window ${capabilities.contextWindow} is below ${requirements.minimumContextWindow}`,
    );
  if (
    requirements.minimumOutputTokens !== undefined &&
    capabilities.maxOutputTokens < requirements.minimumOutputTokens
  )
    reasons.push(
      `max output ${capabilities.maxOutputTokens} is below ${requirements.minimumOutputTokens}`,
    );
  return { eligible: reasons.length === 0, reasons };
}

export function eligibleModels(models: readonly ModelInfo[], requirements: ModelRequirements) {
  return models.filter((model) => modelCompatibility(model, requirements).eligible);
}
