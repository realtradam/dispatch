export { extension, manifest } from "./extension.js";
export {
  collectTextFromStream,
  filterVisionTools,
  findVisionModelName,
  formatConsultResult,
  formatImagePlaceholder,
  formatImageUnavailablePlaceholder,
  formatNoVisionPlaceholder,
  isVisionCapable,
} from "./pure.js";
export { createReadImageTool } from "./read-image.js";
export type {
  ResolvedVisionModel,
  VisionHandoffDeps,
  VisionHandoffService,
} from "./service.js";
export {
  createVisionHandoffService,
  visionHandoffHandle,
} from "./service.js";
export { createConsultVisionTool } from "./tool.js";
