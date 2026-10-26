import { describe, expect, it } from 'vitest';
import { parseTerrainGrid } from '@wargame/shared';
import {
  DOODAD_MAX_REACH,
  DOODAD_OVERHANG,
  DOODAD_MAX_SCALE,
  KEEP_CLEAR,
  MAX_STAND_HEIGHT,
  QUARTER_TURN,
  composeTerrain,
  frameGrid,
} from './composeTerrain';

// The pure half of the tiler: a grid of terrain in, a grid of atlas indices
// out. No Babylon, so the mask arithmetic and the tables are testable even
// though nothing that draws them is.
//
// ⚠️ `rows[0]` is the row nearest the camera, so these fixtures read bottom-up
// exactly as a map file does.
const compose = (...rows: string[]) => composeTerrain(parseTerrainGrid(rows));
const cellAt = (cells: ReturnType<typeof compose>, col: number, row: number) => cells[row][col];

describe('roads', () => {
  // The sheet's 4x4 is structured -- rows carry the north/south bits, columns
  // the east/west ones -- so these spot-checks are enough to catch a table
  // transcribed a row or a column out.
  // Kept off the edge of the fixture, which counts as road -- see below.
  it('picks the junction each neighbourhood calls for', () => {
    const cells = compose(
      '.....', // 0
      '..-..', // 1
      '.---.', // 2
      '..-..', // 3
      '.....', // 4
    );
    expect(cells[2][2].ground).toBe('ground_pathCross'); // crossroads: road on all four
    expect(cells[2][1].ground).toBe('ground_pathEnd'); // road only to the east
    expect(cells[2][3].ground).toBe('ground_pathEnd'); // road only to the west
    expect(cells[1][2].ground).toBe('ground_pathEnd'); // road only to the north
    expect(cells[3][2].ground).toBe('ground_pathEnd'); // road only to the south
  });

  it('draws a corner where a road turns, and a straight where it does not', () => {
    const cells = compose(
      '....', // 0
      '.--.', // 1
      '.-..', // 2
      '....', // 3
    );
    expect(cells[1][1].ground).toBe('ground_pathBend'); // north and east: a corner
    expect(cells[1][2].ground).toBe('ground_pathEnd'); // west only: an end
    expect(cells[2][1].ground).toBe('ground_pathEnd'); // south only: an end
  });

  // ⚠️ The edge of what is drawn counts as more road, as it does as more water,
  // so a road runs off it rather than ending in a cap. What is drawn is the
  // board in its frame, so that edge is the rim of the scenery.
  it('runs a road off the edge rather than capping it', () => {
    expect(compose('--')[0][0]).toEqual(compose('---')[0][1]);
  });
});

describe('the frame', () => {
  // Framed by an argument rather than by FRAME, so these hold however deep the
  // frame is tuned.
  const frame = (depth: number, ...rows: string[]) => frameGrid(parseTerrainGrid(rows), depth);

  it('leaves the board unchanged inside it', () => {
    const grid = parseTerrainGrid(['.f^', '~=~', '.-#']);
    const framed = frameGrid(grid, 2);
    expect(framed).toHaveLength(7);
    expect(framed[0]).toHaveLength(7);
    expect(framed.slice(2, 5).map((row) => row.slice(2, 5))).toEqual(grid);
  });

  it('continues each edge outward, and fills each corner from the corner tile', () => {
    const framed = frame(2, 'f^', '..');
    const southward = ['forest', 'forest', 'forest', 'hills', 'hills', 'hills'];
    expect(framed[2]).toEqual(southward); // the board's near row, carried east and west
    expect(framed[0]).toEqual(southward); // and south, corners included
    expect(framed[5]).toEqual(Array(6).fill('plains'));
  });

  it('runs a road that crosses the edge out to the rim, straight through the seam', () => {
    const framed = frame(2, '.-.', '.-.');
    expect(framed.map((row) => row[3])).toEqual(Array(6).fill('road'));
    const cells = composeTerrain(framed);
    expect(cells[2][3].ground).toBe('ground_pathStraight'); // the board's own edge tile
    expect(cells[0][3].ground).toBe('ground_pathStraight'); // and the rim
  });

  // A road along the edge crosses the edges at its ends, and only those.
  it('does not widen a road that runs along the edge', () => {
    const framed = frame(2, '---', '...');
    expect(framed[1].slice(2, 5)).toEqual(['plains', 'plains', 'plains']);
    expect(framed[2]).toEqual(Array(7).fill('road'));
  });

  it('carries a bridge on as road where its road leaves, and as its water where that does', () => {
    expect(frame(1, '~=~', '.-.')[0][2]).toBe('road');
    expect(frame(1, '-=-', '.~.')[0][2]).toBe('river');
    expect(frame(1, '-=-', '.w.')[0][2]).toBe('sea');
  });

  it('keeps a river its channel across the seam', () => {
    const cells = composeTerrain(frame(2, '.~.', '.~.'));
    expect(cells[2][3].ground).toBe('ground_riverStraight');
    expect(cells[2][3]).toEqual(cells[3][3]);
  });

  it('continues sea, and not a structure', () => {
    expect(frame(1, 'w#', '..')[0]).toEqual(['sea', 'sea', 'plains', 'plains']);
  });
});

describe('water', () => {
  // The rule that outlives the tileset: no sprite index appears here, only the
  // shape of the shoreline, so this still holds if the art is replaced.
  it('puts the shore on the side the land is on', () => {
    const cells = compose(
      '...', // 0  land
      '~~~', // 1  water
      '...', // 2  land
    );
    // Land north and south, water east and west: a channel across the board.
    // The model is drawn running north-south, so this one is turned.
    expect(cellAt(cells, 1, 1)).toMatchObject({ ground: 'ground_riverStraight', turns: 1 });
  });

  it('runs off the edge of the board rather than growing a shore along it', () => {
    const cells = compose(
      '...', // 0
      '~~~', // 1
      '...', // 2
    );
    // The west end is the board edge, which counts as more water, so this is
    // the same tile as the middle rather than an end cap.
    expect(cellAt(cells, 0, 1)).toEqual(cellAt(cells, 1, 1));
  });

  it('wraps a lake in its nine-slice', () => {
    const cells = compose(
      '.....', // 0
      '.~~~.', // 1
      '.~~~.', // 2
      '.~~~.', // 3
      '.....', // 4
    );
    expect(cellAt(cells, 2, 2).ground).toBe('ground_riverOpen'); // no land at all
    // One model, four turns -- which is the whole reason this is cheaper in
    // three dimensions than it was as sprites.
    // The model banks to the south at rest, so each edge is one more turn.
    expect(cellAt(cells, 2, 1)).toMatchObject({ ground: 'ground_riverSide', turns: 0 }); // land south
    expect(cellAt(cells, 1, 2)).toMatchObject({ ground: 'ground_riverSide', turns: 1 }); // land west
    expect(cellAt(cells, 2, 3)).toMatchObject({ ground: 'ground_riverSide', turns: 2 }); // land north
    expect(cellAt(cells, 3, 2)).toMatchObject({ ground: 'ground_riverSide', turns: 3 }); // land east
    expect(cellAt(cells, 1, 3)).toMatchObject({ ground: 'ground_riverCorner', turns: 2 }); // land west and north
    expect(cellAt(cells, 3, 3)).toMatchObject({ ground: 'ground_riverCorner', turns: 3 }); // land north and east
  });

  // An island: water on all four sides of its neighbours, land on one
  // diagonal, which is the case a four-neighbour mask alone cannot see.
  it('rounds the four corners around an island', () => {
    // Two rings of water, or the cells beside the island would also touch the
    // outer shore and never reach the all-four-sides case at all.
    const cells = compose(
      '.......', // 0
      '.~~~~~.', // 1
      '.~~~~~.', // 2
      '.~~.~~.', // 3  <- the island, at col 3
      '.~~~~~.', // 4
      '.~~~~~.', // 5
      '.......', // 6
    );
    for (const [col, row] of [
      [2, 4],
      [4, 4],
      [2, 2],
      [4, 2],
    ]) {
      expect(cellAt(cells, col, row).ground).toBe('ground_riverCornerSmall');
    }
    // All four, and each turned differently -- one model covers the lot.
    expect(
      new Set([
        cellAt(cells, 2, 4).turns,
        cellAt(cells, 4, 4).turns,
        cellAt(cells, 2, 2).turns,
        cellAt(cells, 4, 2).turns,
      ]).size,
    ).toBe(4);
    // Straight out from the island is *not* a corner: the island is an
    // orthogonal neighbour there, so those cells take a shoreline instead.
    expect(cellAt(cells, 3, 2).ground).toBe('ground_riverSide');
  });

  // The mask says the same of both -- water north and east -- and only the land
  // in the crook between them tells a channel's bend from a lake's corner.
  it('bends a river a tile wide, where a lake keeps its corner', () => {
    const river = compose('...', '.~~', '.~.')[1][1];
    const lake = compose('....', '.~~.', '.~~.', '....')[1][1];
    expect(river.ground).toBe('ground_riverBend');
    expect(lake.ground).toBe('ground_riverCorner');
    expect(river.turns).toBe(lake.turns);
  });

  it('forks and crosses a river a tile wide', () => {
    expect(compose('...', '~~~', '.~.')[1][1].ground).toBe('ground_riverSplit');
    expect(compose('.~.', '~~~', '.~.')[1][1].ground).toBe('ground_riverCross');
  });

  // The sprite sheet had nothing for this and fell back to a hard blue square.
  // The kit draws it.
  it('draws a pond with no water neighbours at all', () => {
    expect(compose('...', '.~.', '...')[1][1].ground).toBe('ground_riverTile');
  });
});

describe('sea', () => {
  // Drawn with the river's own models, so the paint is all that tells them
  // apart -- and it has to, since one can be waded and the other cannot.
  it('is painted, where a river is not', () => {
    const cells = compose('...', '~~~', 'www');
    expect(cellAt(cells, 1, 2).paint).toBe('sea');
    expect(cellAt(cells, 1, 1).paint).toBeUndefined();
  });

  it('takes a river into it with no bank across the mouth', () => {
    const cells = compose(
      '.~.', // 0
      '.~.', // 1
      'www', // 2
    );
    // The sea counts as more water, so the last tile of river is a channel
    // running on into it rather than an end cap.
    expect(cellAt(cells, 1, 1).ground).toBe('ground_riverStraight');
  });

  it('runs off the edge of the board rather than growing a shore along it', () => {
    const cells = compose('...', 'www', 'www');
    expect(cellAt(cells, 0, 1)).toEqual(cellAt(cells, 1, 1));
  });

  it('paints a bridge by the water it spans', () => {
    expect(cellAt(compose('.-.', 'w=w', '.-.'), 1, 1).paint).toBe('sea');
    expect(cellAt(compose('.-.', '~=~', '.-.'), 1, 1).paint).toBeUndefined();
  });
});

describe('bridges', () => {
  // A bridge is water with a road over it, so it belongs to both families.
  // Leaving it out of the water one makes every river dead-end at its crossing.
  it('does not break the river it crosses', () => {
    const cells = compose(
      '..-..', // 0
      '~~=~~', // 1
      '..-..', // 2
    );
    // The water either side reads as a continuous channel, not as two stubs.
    expect(cellAt(cells, 1, 1).ground).toBe('ground_riverStraight');
    expect(cellAt(cells, 3, 1).ground).toBe('ground_riverStraight');
  });

  // The deck stands *on* the water, so the ground beneath it is still river --
  // which is why the underside the sprite sheet needed a second pass for does
  // not arise at all here.
  it('stands a deck on the water, turned the way the road runs', () => {
    const northSouth = compose('..-..', '~~=~~', '..-..');
    expect(cellAt(northSouth, 2, 1).ground).toBe('ground_riverStraight');
    expect(cellAt(northSouth, 2, 1).props).toEqual([
      // The deck is drawn spanning east to west, so a north-south road turns it.
      // ⚠️ `squeeze` is under 1 because the model is wider than the road it
      // carries -- asserted as *narrower than the model ships* rather than as a
      // figure, so tuning the width does not land here.
      {
        model: 'bridge_wood',
        x: 0,
        z: 0,
        rotation: QUARTER_TURN,
        scale: 1,
        squeeze: expect.any(Number) as number,
      },
    ]);
    const { squeeze } = cellAt(northSouth, 2, 1).props[0];
    expect(squeeze).toBeGreaterThan(0);
    expect(squeeze).toBeLessThan(1);

    const eastWest = compose('..~..', '.-=-.', '..~..');
    expect(cellAt(eastWest, 2, 1).props[0]).toMatchObject({
      model: 'bridge_wood',
      rotation: 0,
    });
  });

  it('runs a deck toward the ground at its ends, whatever stands there', () => {
    const cells = compose('...', '~=~', '.#.');
    expect(cellAt(cells, 1, 1).props[0].rotation).toBe(QUARTER_TURN);
  });

  // A crossing longer than a tile is one bridge rather than several: an end
  // piece ramped onto each bank, and middle spans between.
  it('spans a long crossing with an end ramped onto each bank and middles between', () => {
    const deck = (cells: ReturnType<typeof compose>, col: number, row: number) => {
      const { model, rotation } = cellAt(cells, col, row).props[0];
      return [model, rotation / QUARTER_TURN];
    };
    // Running north: the south end ramps south, the north end north.
    const northward = compose('..-..', '~~=~~', '~~=~~', '~~=~~', '..-..');
    expect(deck(northward, 2, 1)).toEqual(['bridge_side_wood', 1]);
    expect(deck(northward, 2, 2)).toEqual(['bridge_center_wood', 1]);
    expect(deck(northward, 2, 3)).toEqual(['bridge_side_wood', 3]);
    // Running east: the west end ramps west, the east end east.
    const eastward = compose('.~~~.', '-===-', '.~~~.');
    expect(deck(eastward, 1, 1)).toEqual(['bridge_side_wood', 2]);
    expect(deck(eastward, 2, 1)).toEqual(['bridge_center_wood', 0]);
    expect(deck(eastward, 3, 1)).toEqual(['bridge_side_wood', 0]);
  });

  // A two-lane crossing gives its bridge cells masks 7 and 13 rather than 5
  // and 10, because each lane sees the other beside it -- so orientation
  // cannot be read off the road mask.
  it('runs a two-lane deck the way the road does, not the way the mask says', () => {
    const cells = compose(
      '..--..', // 0
      '~~==~~', // 1
      '..--..', // 2
    );
    expect(cellAt(cells, 2, 1).props[0].rotation).toBe(QUARTER_TURN);
    expect(cellAt(cells, 3, 1).props[0].rotation).toBe(QUARTER_TURN);
  });
});

describe('ground cover', () => {
  it('stands a tree on grass and a mesa on hills', () => {
    const cells = compose('f^.');
    expect(cells[0][0].ground).toBe('ground_grass');
    // A wood is several trees now, and which ones is the tile's own business --
    // see the variety tests below. The count is deliberately not pinned: what
    // matters is that a wood is more than one thing and all of it is trees.
    expect(cells[0][0].props.length).toBeGreaterThan(1);
    expect(cells[0][0].props.every((prop) => prop.model.startsWith('tree_'))).toBe(true);

    // ⚠️ Hills do **not** raise their ground: the tile stays flat grass
    // and a rock stands on it, which is the whole shape of the thing. How high
    // a unit ends up is the rock's own top, so it is pointed at rather than
    // stated -- `standOnProp`, never `standOn`.
    const peak = cells[0][1];
    expect(peak.ground).toBe('ground_grass');
    expect(peak.props).toHaveLength(1);
    expect(peak.standOnProp).toBe(0);
    expect(peak.standOn).toBeUndefined();
    // Centred, unlike everything else that stands on a tile, because a unit
    // stands on top of it.
    expect({ x: peak.props[0].x, z: peak.props[0].z }).toEqual({ x: 0, z: 0 });

    // ⚠️ Plains are no longer bare -- they carry scenery. What they never carry
    // is a tree or a stone, because both of those say something about the tile
    // and scenery says nothing.
    const onPlains = cells[0][2].props.map((prop) => prop.model);
    expect(onPlains).not.toContain('tree_default');
    expect(onPlains.some((model) => model.startsWith('stone_'))).toBe(false);
  });

  it('builds a structure as a village round a paved square a unit stands in', () => {
    const structure = compose('#')[0][0];
    expect(structure.paint).toBe('paved');
    expect(structure.standOnProp).toBeUndefined();
    expect(structure.standOn).toBeUndefined();
    expect(structure.props.every((prop) => prop.model.startsWith('house_'))).toBe(true);
    const corners = structure.props.map(({ x, z }) => `${Math.sign(x)},${Math.sign(z)}`);
    expect(new Set(corners).size).toBe(4);
  });

  it('turns every door to one of the streets that cross the tile', () => {
    for (const house of compose('###', '###')
      .flat()
      .flatMap((cell) => cell.props)) {
      // A door faces +z unturned.
      const door = { x: Math.sin(house.rotation), z: Math.cos(house.rotation) };
      expect(Math.abs(door.x * door.z)).toBeCloseTo(0);
      expect(door.x * -house.x + door.z * -house.z).toBeGreaterThan(0);
    }
  });

  // The only height in the renderer that is stated rather than measured, and
  // the reason is that a bridge's own top is its handrail.
  it('stands a unit on the bridge deck, not on the water under it', () => {
    const cells = compose('..-..', '~~=~~', '..-..');
    expect(cells[1][2].standOn).toBeGreaterThan(0);
    expect(cells[1][1].standOn).toBeUndefined(); // the water beside it is not walked on
  });

  // The ceiling binds whatever is stated here just as it binds the models --
  // `warnIfTooTall` is the other half, since a model's height is not known
  // until it loads.
  it('never stands a unit higher than picking can absorb', () => {
    const cells = compose('f^-~=#', '.~^-.#', '=-~^f#');
    for (const row of cells) {
      for (const cell of row) {
        expect(cell.standOn ?? 0).toBeLessThanOrEqual(MAX_STAND_HEIGHT);
      }
    }
  });

  // ⚠️ A unit stands in the middle of its tile, so a prop planted there is a
  // prop wearing a soldier. Checked over a board carrying every kind of
  // scatter there is -- peaks, woods and open ground -- because each is placed
  // by different arithmetic and any of them could drift inward.
  it('keeps every prop clear of the middle of the tile', () => {
    const cells = compose(...Array.from({ length: 12 }, () => '^f.#^f.#^f.#'));
    for (const cell of cells.flat()) {
      cell.props.forEach((prop, i) => {
        // ⚠️ Except the one a unit stands *on top of*. A mesa is centred
        // precisely because the unit ends up above it rather than beside it,
        // and holding it to the keep-clear would be holding it to the opposite
        // of what it is for.
        if (i === cell.standOnProp) return;
        expect(Math.hypot(prop.x, prop.z)).toBeGreaterThanOrEqual(KEEP_CLEAR);
      });
    }
  });

  // ⚠️ A bound, but a loose one: plains are flat, so a tuft leaning onto the
  // tile beside it has no drop to float over. It still has to be a bound,
  // because "a bit over the edge" and "halfway onto next door" are different
  // things. Solved from the constants, not sampled.
  const WIDEST_DOODAD = 0.41;

  it('lets a doodad lean over its edge, but only barely', () => {
    const reach = DOODAD_MAX_REACH + (WIDEST_DOODAD / 2) * DOODAD_MAX_SCALE;
    expect(reach).toBeLessThanOrEqual(0.5 + DOODAD_OVERHANG);
    expect(reach).toBeGreaterThan(0.5); // or the allowance is dead and should go
  });

  // A bridge is the exception, and deliberately so: it spans its tile, and a
  // unit stands on its deck rather than beside it.
  it('centres a bridge instead', () => {
    const deck = compose('..-..', '~~=~~', '..-..')[1][2].props[0];
    expect({ x: deck.x, z: deck.z }).toEqual({ x: 0, z: 0 });
  });

  it('puts the same props in the same places every time', () => {
    expect(compose('^')).toEqual(compose('^'));
    expect(compose('.f.')[0][1].props).toEqual(compose('.f.')[0][1].props);
  });

  it('does not lay every tile out identically', () => {
    // Same terrain, different coordinates -- so anything shared between these
    // came from the tile's position and not from the terrain type. Woodland
    // rather than peaks: a mesa is one centred rock and has only its turn to
    // vary, while a tree varies in shape, place, turn and size.
    const row = compose('ffffffff');
    const layouts = new Set(row[0].map((cell) => JSON.stringify(cell.props)));
    expect(layouts.size).toBe(8);
  });

  // ⚠️ *Light* is the brief and the thing that could quietly stop being true.
  // Every tile carrying something reads as a feature rather than as scenery,
  // and a bare board is what this was added to fix -- so both ends are held.
  it('scatters open ground thinly, leaving most of it bare', () => {
    const plains = compose(...Array.from({ length: 14 }, () => '..............')).flat();
    const carrying = plains.filter((cell) => cell.props.length > 0).length;
    const share = carrying / plains.length;

    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.55);
  });

  it('puts at most one doodad on a tile', () => {
    const plains = compose(...Array.from({ length: 10 }, () => '..........')).flat();
    expect(Math.max(...plains.map((cell) => cell.props.length))).toBe(1);
  });

  it('uses more than one kind, and turns and sizes them differently', () => {
    const props = compose(...Array.from({ length: 10 }, () => '..........'))
      .flat()
      .flatMap((cell) => cell.props);

    expect(new Set(props.map((p) => p.model)).size).toBeGreaterThan(1);
    expect(new Set(props.map((p) => p.rotation)).size).toBeGreaterThan(1);
    expect(new Set(props.map((p) => p.scale)).size).toBeGreaterThan(1);
  });

  // Scenery, not terrain: a tile with a flower on it plays exactly like one
  // without, so nothing about the cell may differ but its props.
  it('leaves a decorated tile otherwise identical to a bare one', () => {
    const plains = compose(...Array.from({ length: 8 }, () => '........')).flat();
    const bare = plains.find((cell) => cell.props.length === 0);
    const decorated = plains.find((cell) => cell.props.length > 0);

    expect({ ...bare, props: [] }).toEqual({ ...decorated, props: [] });
  });

  // A wood used to be one shape stamped repeatedly. Six shapes, each turned and
  // sized, is what stops a forest reading as wallpaper.
  it('draws a wood out of more than one kind of tree', () => {
    const trees = compose(...Array.from({ length: 8 }, () => 'ffffffff'))
      .flat()
      .flatMap((cell) => cell.props);

    expect(new Set(trees.map((t) => t.model)).size).toBeGreaterThan(1);
    expect(new Set(trees.map((t) => t.rotation)).size).toBeGreaterThan(1);
    expect(new Set(trees.map((t) => t.scale)).size).toBeGreaterThan(1);
    expect(trees.every((t) => t.model.startsWith('tree_'))).toBe(true);
  });

  it('does not stack every tree in the same quarter of its tile', () => {
    const corners = new Set(
      compose('ffffffff', 'ffffffff')
        .flat()
        .map(({ props }) => `${Math.sign(props[0].x)},${Math.sign(props[0].z)}`),
    );
    expect(corners.size).toBeGreaterThan(1);
  });

  // ⚠️ The three below are the contract of scattering a wood as one shape
  // rather than a tile at a time. Each states a thing the per-tile ring could
  // not do, so together they are what stops it quietly coming back.

  it('never leaves a square of woodland bare', () => {
    const rows = ['ffff', 'f..f', 'ffff'];
    const cells = compose(...rows);

    rows.forEach((row, r) =>
      [...row].forEach((char, c) => {
        if (char !== 'f') return;
        // A unit may stand on any of these, and a forest tile with nothing on
        // it is terrain lying about what it is.
        expect(cellAt(cells, c, r).props.length).toBeGreaterThan(0);
        expect(cellAt(cells, c, r).props.every((p) => p.model.startsWith('tree_'))).toBe(true);
      }),
    );
  });

  it('grows a wood with its area rather than repeating one tile', () => {
    const count = (...rows: string[]) =>
      compose(...rows)
        .flat()
        .flatMap(({ props }) => props)
        .filter((prop) => prop.model.startsWith('tree_')).length;

    // Four tiles of wood carry far more than twice what one does -- which is
    // the density holding while the shape changes.
    expect(count('ff', 'ff')).toBeGreaterThan(count('f.', '..') * 2);
  });

  it('spreads a wood evenly over the tiles it covers', () => {
    const counts = compose(...Array.from({ length: 4 }, () => 'ffff'))
      .flat()
      .map(({ props }) => props.length);

    // ⚠️ The number this exists to catch. Handing each tree to a randomly chosen
    // tile of the group is a multinomial, and its spread is visible on the
    // board: this same wood ran 2 trees on one square against 7 on another,
    // target 5, before the placement went round robin. A tolerance of one
    // leaves room for a candidate the spacing turns away without leaving room
    // for that.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('fills the tile rather than ringing it', () => {
    const radii = compose(...Array.from({ length: 6 }, () => 'ffffff'))
      .flat()
      .flatMap(({ props }) => props.map((prop) => Math.hypot(prop.x, prop.z)));

    // A ring put every trunk in one narrow band. A scatter uses the whole tile
    // outside the hole a unit stands in, so both ends of the range show up.
    expect(Math.min(...radii)).toBeLessThan(0.3);
    expect(Math.max(...radii)).toBeGreaterThan(0.45);
  });
});
