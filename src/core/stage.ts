import { AspectRatio } from './aspect';

/** Longest side of the tool stage in CSS pixels. Tools layout to this box; DIVE scales it. */
export const STAGE_LONG_SIDE = 1920;

export function stageSize(aspect: AspectRatio): { width: number; height: number } {
  if (aspect.width >= aspect.height) {
    return {
      width: STAGE_LONG_SIDE,
      height: Math.max(1, Math.round((STAGE_LONG_SIDE * aspect.height) / aspect.width)),
    };
  }
  return {
    width: Math.max(1, Math.round((STAGE_LONG_SIDE * aspect.width) / aspect.height)),
    height: STAGE_LONG_SIDE,
  };
}
