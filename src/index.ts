export { workflow, PRODUCT, QUESTION, type AgentRiskReport, type TargetReport } from "./product.js";
export { discover, sweep, scanTarget, type Target, type TargetKind, type TargetScan } from "./scan.js";
export {
  DIMENSIONS, buildProfile, scanDimensionPatterns, DIM_PATTERNS, atomHints, has, hasFacet,
  type Dimension, type Facet, type DimHint, type DimensionProfile,
} from "./dimensions.js";
export {
  HAZARDS, analyzeHazards, selfSufficientHazards, type HazardId, type HazardResult,
} from "./hazards.js";
export { tierOfProfile, surfacePosture, type Posture, type Tier } from "./severity.js";
