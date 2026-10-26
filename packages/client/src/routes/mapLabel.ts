import type { MapSummary } from '@wargame/shared';

/** How a picker names a map: its name, then its size, width first. */
export const mapLabel = ({ name, width, height }: MapSummary): string =>
  `${name} · ${width}×${height}`;
