export interface AspectRatio {
  width: number;
  height: number;
}

export const DEFAULT_ASPECT: AspectRatio = { width: 9, height: 16 };

export function parseAspectRatio(value?: string | number | null): AspectRatio {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return { width: value, height: 1 };
  }

  if (!value || typeof value !== 'string') {
    return { ...DEFAULT_ASPECT };
  }

  const trimmed = value.trim();
  const pair = trimmed.match(/^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/);
  if (pair) {
    const width = Number(pair[1]);
    const height = Number(pair[2]);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return { width: numeric, height: 1 };
  }

  return { ...DEFAULT_ASPECT };
}

export function aspectCss(aspect: AspectRatio): string {
  return `${aspect.width} / ${aspect.height}`;
}

/** Largest rectangle of `aspect` that fits in the cell (letterbox / pillarbox). */
export function containSize(
  cellWidth: number,
  cellHeight: number,
  aspect: AspectRatio,
): { width: number; height: number } {
  if (!(cellWidth > 0) || !(cellHeight > 0) || !(aspect.width > 0) || !(aspect.height > 0)) {
    return { width: 0, height: 0 };
  }
  const cell = cellWidth / cellHeight;
  const target = aspect.width / aspect.height;
  if (cell > target) {
    return { width: cellHeight * target, height: cellHeight };
  }
  return { width: cellWidth, height: cellWidth / target };
}
