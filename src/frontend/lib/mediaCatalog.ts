import type { MediaCommandConfig, MediaModel } from './types';

export const MEDIA_PROVIDER_ORDER = ['pollinations', 'google'] as const;

export function mediaTargetValue(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

export function groupMediaModels(models: readonly MediaModel[]) {
  return MEDIA_PROVIDER_ORDER.map((provider) => ({
    provider,
    models: models
      .filter((model) => model.provider === provider)
      .sort((left, right) => left.id.localeCompare(right.id)),
  })).filter((group) => group.models.length > 0);
}

export function normalizeMediaSelection(
  current: MediaCommandConfig,
  selected: MediaModel
): Partial<MediaCommandConfig> {
  return {
    provider: selected.provider,
    model: selected.id,
    voice: selected.voices?.includes(current.voice || '')
      ? current.voice
      : selected.defaultVoice || selected.voices?.[0],
    duration: selected.durations?.includes(current.duration || Number.NaN)
      ? current.duration
      : selected.durations?.[0],
  };
}
