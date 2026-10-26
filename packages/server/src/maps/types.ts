/**
 * A battlefield: terrain, and nothing else.
 *
 * ⚠️ Units are **not** here. Every map used to carry its own copy of the same
 * three placements in the same corner, which was one piece of content written
 * four times; `matchState.ts` now deploys one army onto whatever board it is
 * given. What a map owes that army is a **deployment zone it can stand in** --
 * see the warning beside `ARMY`.
 *
 * ⚠️ **Map ids are immutable.** A match records the id it was built from, so
 * changing a map's terrain under its id retroactively changes what every
 * existing match claims to have been played on. A changed map gets a new id.
 */
export interface GameMap {
  id: string;
  name: string;
  /**
   * Parsed by `parseTerrainGrid`. Every row must be the same length.
   *
   * ⚠️ **`rows[0]` is the row nearest the camera** — the bottom of the screen.
   * Row index increases north, so a map written top-down on paper is upside
   * down here. Author it bottom-up, or write it out and reverse it.
   */
  rows: string[];
  /**
   * Where along its own edge each seat's deployment zone sits: the board
   * column of its westmost square, near seat first, in board coordinates
   * whichever way the seat faces. Omitted, both are centred.
   *
   * ⚠️ **A map may not put water or rock under a zone.** `wheels` cannot enter
   * river or hills at any price, and nothing enters sea, so a board that draws
   * any of them into a deployment square strands whatever a player puts there.
   * `maps.test.ts` is what catches it, checking every square of both zones.
   */
  zoneStarts?: [near: number, far: number];
}
