import type { PlayerColor } from '@wargame/shared';

/**
 * A side's colour, where the page draws one -- the cutaway's health bars. The
 * board draws none: a side's figures wear its army's uniform.
 */
export const PLAYER_HEX: Record<PlayerColor, string> = {
  blue: '#5999ff',
  red: '#ff544d',
};
