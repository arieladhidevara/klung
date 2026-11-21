// An old saved project may contain cues without labels. Keep them readable.
export const DEFAULT_CUE_LABEL = 'TRANSPOSE';
export function cueLabel(cue) {
  const value = typeof cue?.label === 'string' ? cue.label.trim() : '';
  return value || DEFAULT_CUE_LABEL;
}
