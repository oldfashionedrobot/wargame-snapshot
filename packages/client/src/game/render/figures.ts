import type { PlayerColor, UnitTypeId } from '@wargame/shared';

/**
 * What a figure is: a board piece, or one of a cutaway ensemble's members.
 * Each is drawn from a file of its own under `public/models/units`.
 */
export type Role = 'infantry' | 'cavalry' | 'general' | 'gunner' | 'crew' | 'gun';

/** The animation sets: every role moves as one of these bodies. */
export type Body = 'foot' | 'gunner' | 'crew' | 'mounted' | 'gun';

export const BODY: Record<Role, Body> = {
  infantry: 'foot',
  cavalry: 'mounted',
  general: 'mounted',
  gunner: 'gunner',
  crew: 'crew',
  gun: 'gun',
};

/**
 * Every animation a body answers to, named as the converter names them, so the
 * code asks for `fire` and any foot figure answers.
 */
export const MOTIONS = {
  foot: ['stand', 'walk', 'present', 'fire', 'charge', 'flee', 'hit', 'fall'],
  gunner: ['stand', 'walk', 'ram', 'hit', 'fall'],
  crew: ['stand', 'walk', 'hit', 'fall'],
  mounted: ['stand', 'walk', 'gallop', 'cut', 'hit', 'fall'],
  gun: ['stand', 'walk', 'fire', 'fall'],
} as const satisfies Record<Body, readonly string[]>;

export type Motion = (typeof MOTIONS)[Body][number];

/** ⚠️ **A side's colour is its army**: blue is Continental and red British. */
const ARMY: Record<PlayerColor, string> = { blue: 'continental', red: 'british' };

/** The file a figure of this role and side is drawn from; the gun serves both. */
export function figureFile(role: Role, color: PlayerColor): string {
  return role === 'gun' ? 'gun' : `${ARMY[color]}/${role}`;
}

/** Every file there is, as `figureFile` names them. */
export const FIGURE_FILES = [
  ...new Set(
    (Object.keys(BODY) as Role[]).flatMap((role) =>
      (Object.keys(ARMY) as PlayerColor[]).map((color) => figureFile(role, color)),
    ),
  ),
];

/**
 * The figure that stands for a unit on the board. A Record, like every other
 * content table, so a new unit type is a compile error here rather than a
 * missing model at runtime.
 */
export const PIECE: Record<UnitTypeId, Role> = {
  infantry: 'infantry',
  cavalry: 'cavalry',
  general: 'general',
  artillery: 'gun',
};
