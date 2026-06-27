export { extension, manifest } from "./extension.js";
export {
  collectTextFromStream,
  findVisionModelName,
  formatConsultResult,
  formatImagePlaceholder,
  formatNoVisionPlaceholder,
  isVisionCapable,
} from "./pure.js";
export type {
  OrchestratorForVision,
  ResolvedVisionModel,
  VisionHandoffDeps,
  VisionHandoffService,
} from "./service.js";
export {
  createVisionHandoffService,
  orchestratorLocalHandle,
  visionHandoffHandle,
} from "./service.js";
export { createConsultVisionTool } from "./tool.js";
