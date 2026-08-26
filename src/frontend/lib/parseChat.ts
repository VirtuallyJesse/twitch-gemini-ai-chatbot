import { getEmote, type EmoteDef } from './emotes';

export type Token =
  | { t: 'text'; v: string }
  | { t: 'cmd'; v: string }
  | { t: 'mention'; v: string }
  | { t: 'emote'; v: string; e: EmoteDef }
  | { t: 'link'; v: string; href: string };

const CMD_RE = /^![a-zA-Z][\w-]*$/;
const MENTION_RE = /^(@\w+)([.,!?:]*)$/;
const URLISH_RE = /^https?:\/\/\S+$/i;

export function parseChat(
  raw: string,
  channel?: string,
  meta?: { twitchEmotesByName?: unknown } | null
): Token[] {
  const out: Token[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };

  for (const chunk of raw.split(/(\s+)/)) {
    if (!chunk) continue;
    if (!chunk.trim()) {
      buf += chunk;
      continue;
    }

    const isEmoteFlagged = chunk.startsWith('emote:');
    const cleanChunk = isEmoteFlagged ? chunk.slice(6) : chunk;
    const emote = getEmote(cleanChunk, channel, meta);
    if (emote) {
      flush();
      out.push({ t: 'emote', v: cleanChunk, e: emote });
      continue;
    }

    if (isEmoteFlagged) {
      buf += cleanChunk;
      continue;
    }

    if (CMD_RE.test(chunk)) {
      flush();
      out.push({ t: 'cmd', v: chunk });
      continue;
    }

    const mention = chunk.match(MENTION_RE);
    if (mention) {
      flush();
      out.push({ t: 'mention', v: mention[1] });
      buf += mention[2];
      continue;
    }

    if (URLISH_RE.test(chunk)) {
      /* safe links only: URL must parse and be strictly http(s) */
      try {
        const u = new URL(chunk);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          flush();
          out.push({ t: 'link', v: chunk, href: u.href });
          continue;
        }
      } catch {
        /* fall through to plain text */
      }
    }

    buf += chunk;
  }
  flush();
  return out;
}
