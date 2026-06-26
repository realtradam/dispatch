export { extension, manifest } from "./extension.js";
export {
  buildTranscriptionPrompt,
  collectTextFromStream,
  findVisionModelName,
  formatNoVisionPlaceholder,
  formatTranscriptionText,
  isVisionCapable,
} from "./pure.js";
export type {
  ResolvedVisionModel,
  VisionHandoffDeps,
  VisionHandoffService,
} from "./service.js";
export {
  createVisionHandoffService,
  visionHandoffHandle,
} from "./service.js";
export { createReadImageTool } from "./tool.js";
