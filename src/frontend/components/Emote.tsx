import { useState } from 'react';
import type { EmoteDef } from '../lib/emotes';

/* Renders a 1x CDN emote asset; if the provider CDN fails, degrade
   gracefully to the emote's text name instead of a broken image. */
export default function Emote({ def }: { def: EmoteDef }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span className="italic text-faint">{def.name}</span>;
  }

  return (
    <img
      src={def.url}
      alt={def.name}
      title={`${def.name} · ${def.provider}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="inline-block h-[18px] w-auto align-[-4px]"
    />
  );
}
