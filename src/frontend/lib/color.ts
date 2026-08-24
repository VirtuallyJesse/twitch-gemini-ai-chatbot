/* Deterministic hue per name so chatters keep a stable color without Twitch
   palette data; callers tune saturation/lightness per surface. */

export function stringToColor(str: string, saturation = 70, lightness = 65): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, ${saturation}%, ${lightness}%)`;
}
