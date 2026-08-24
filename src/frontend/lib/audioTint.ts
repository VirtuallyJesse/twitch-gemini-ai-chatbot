/* Audio tile palette — nine flat washes assigned one per audio object.
   Selection hashes the stable item id, then repairs locally so a tile never
   matches its immediate left or top neighbor in the rendered deck. Purely
   presentational: reads no metadata, storage, or layout beyond `cols`. */

export const AUDIO_TINT_HUES: readonly string[] = [
  '#ff5c7a', // rose
  '#ffd166', // gold
  '#7ed957', // green
  '#4fd8b8', // mint
  '#5fc9e8', // cyan
  '#63a8ff', // azure
  '#a273ff', // violet
  '#d98cff', // orchid
  '#9aa7bd', // slate
];

/* FNV-1a — same id always lands on the same palette preference. */
function stableHash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface TintSlot {
  id: string;
  type: string;
}

/* One palette index per deck slot in grid order (row * cols + col); -1 marks
   non-audio slots, which neither paint nor constrain their neighbors. Repair
   is O(1) per tile: with at most two forbidden neighbors, advancing past the
   hashed preference always lands on a free wash within two steps. */
export function assignAudioTints(items: readonly TintSlot[], cols: number): number[] {
  const out = new Array<number>(items.length).fill(-1);
  const stride = Math.max(1, Math.floor(cols));
  const n = AUDIO_TINT_HUES.length;
  for (let idx = 0; idx < items.length; idx++) {
    if (items[idx].type !== 'audio') continue;
    let candidate = stableHash(items[idx].id) % n;
    const left = idx % stride === 0 ? -1 : out[idx - 1];
    const top = idx < stride ? -1 : out[idx - stride];
    while (candidate === left || candidate === top) {
      candidate = (candidate + 1) % n;
    }
    out[idx] = candidate;
  }
  return out;
}
