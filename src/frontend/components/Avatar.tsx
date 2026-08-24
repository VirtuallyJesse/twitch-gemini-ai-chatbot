import { useState } from 'react';
import { stringToColor } from '../lib/color';

interface Props {
  name: string;
  color?: string;
  src?: string | null;
  size?: number;
}

export default function Avatar({ name, color, src, size = 22 }: Props) {
  const [imgError, setImgError] = useState(false);
  const bgColor = color || stringToColor(name || 'user', 65, 60);

  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={name}
        onError={() => setImgError(true)}
        className="inline-block shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  const initial = (name || '?').charAt(0).toUpperCase();

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase select-none"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.46,
        color: '#101113',
        background: bgColor,
      }}
    >
      {initial}
    </span>
  );
}
