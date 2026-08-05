/** Public dependency-impact sidecar surface shared by review and repair. */

export {
  composeDependencyImpactSidecar,
  type ComposeDependencyImpactSidecarInput,
} from './dependencyImpactComposer.js';
export { deriveReviewSubjects } from './dependencyImpactReviewSubjects.js';
export { deriveRepairSubjects } from './dependencyImpactRepairSubjects.js';
