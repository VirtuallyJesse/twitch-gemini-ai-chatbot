/* Single-active playback coordination across every video and audio
   element in the gallery. Claiming playback pauses whatever else is
   currently sounding, Twitter-style. */
let active: HTMLMediaElement | null = null;

export function claimPlayback(el: HTMLMediaElement) {
  if (active && active !== el && !active.paused) {
    try {
      active.pause();
    } catch {
      // ignore
    }
  }
  active = el;
}
