/**
 * Router Types
 *
 * Adapted from ClawRouter (MIT licensed, BlockRunAI)
 */

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX";

const TIER_ORDER: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2 };

export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

export type DimensionName =
  | "tokenCount"
  | "codePresence"
  | "reasoningMarkers"
  | "technicalTerms"
  | "creativeMarkers"
  | "simpleIndicators"
  | "multiStepPatterns"
  | "questionComplexity"
  | "imperativeVerbs"
  | "constraintCount"
  | "outputFormat"
  | "referenceComplexity"
  | "negationComplexity"
  | "domainSpecificity";

export type ScoringResult = {
  score: number;
  tier: Tier | null;
  confidence: number;
  signals: string[];
};

export type RoutingDecision = {
  model: string;
  tier: Tier;
  confidence: number;
  method: "rules";
  reasoning: string;
  signals: string[];
  estimatedTokens: number;
};

export type ScoringConfig = {
  tokenCountThresholds: { simple: number; complex: number };
  codeKeywords: string[];
  reasoningKeywords: string[];
  simpleKeywords: string[];
  technicalKeywords: string[];
  creativeKeywords: string[];
  imperativeVerbs: string[];
  constraintIndicators: string[];
  outputFormatKeywords: string[];
  referenceKeywords: string[];
  negationKeywords: string[];
  domainSpecificKeywords: string[];
  dimensionWeights: Record<DimensionName, number>;
  tierBoundaries: {
    simpleMedium: number;
    mediumComplex: number;
  };
  confidenceSteepness: number;
  confidenceThreshold: number;
};

export type TierConfig = {
  SIMPLE: string;
  MEDIUM: string;
  COMPLEX: string;
};

export type RoutingConfig = {
  version: string;
  scoring: ScoringConfig;
  tiers: TierConfig;
  overrides: {
    maxTokensForceComplex: number;
    ambiguousDefaultTier: Tier;
  };
};
