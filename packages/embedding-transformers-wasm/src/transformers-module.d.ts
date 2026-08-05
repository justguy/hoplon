declare module '@huggingface/transformers' {
  import type { TransformersModule } from './types.js';

  export const env: TransformersModule['env'];
  export const pipeline: TransformersModule['pipeline'];
}
