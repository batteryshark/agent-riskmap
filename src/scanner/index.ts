export {
  SignaturePack,
  SignaturePackError,
  loadSignaturePack,
  compilePattern,
  type SignatureRule,
  type ObservationGate,
  type CalleeClassification,
  type ContentSignature,
  type MatchMode,
  type GateAction,
} from "./signature-pack.js";

export { taxonomyRoot, resolveSourceCalleePack, loadSourceCalleePack } from "./taxonomy.js";

export { Scanner, loadScanner, type Observation } from "./scanner.js";
