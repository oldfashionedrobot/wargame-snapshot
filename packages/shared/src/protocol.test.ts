import { describe, expect, it } from 'bun:test';
import { parseCommand } from './protocol';

// parseCommand is the only thing standing between an attacker-controlled POST
// body and the authority. TypeScript is erased, so every guarantee here is a
// runtime one.
describe('parseCommand', () => {
  const path = [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
  ];

  describe('accepts', () => {
    it('a move command', () => {
      expect(parseCommand({ type: 'move', unitId: 'u1', path, facing: 'north' })).toEqual({
        type: 'move',
        unitId: 'u1',
        path,
        facing: 'north',
      });
    });

    // ⚠️ The field has to survive a parser whose whole job is building a fresh
    // literal and discarding everything it does not recognise -- see "strips
    // arbitrary extra properties" below, which is exactly the fate this would
    // have had if `parseCommand` had not been widened.
    it('a move carrying a target', () => {
      expect(
        parseCommand({ type: 'move', unitId: 'u1', path, facing: 'north', targetUnitId: 'r3' }),
      ).toEqual({ type: 'move', unitId: 'u1', path, facing: 'north', targetUnitId: 'r3' });
    });

    it('a move with no target at all, which is every move before 9h', () => {
      const parsed = parseCommand({ type: 'move', unitId: 'u1', path, facing: 'north' });
      expect(parsed).not.toBeNull();
      expect(Object.keys(parsed ?? {})).not.toContain('targetUnitId');
    });

    // ⚠️ **The same whitelist, and a worse failure if it is forgotten.** A
    // dropped `targetUnitId` loses an attack; a dropped `attackKind` turns a
    // *charge* into an attack, which resolves, succeeds, and does something the
    // player never asked for.
    it('carries an attack kind through', () => {
      expect(
        parseCommand({
          type: 'move',
          unitId: 'u1',
          path,
          facing: 'north',
          targetUnitId: 'r3',
          attackKind: 'charge',
        }),
      ).toMatchObject({ attackKind: 'charge' });
    });

    it('leaves the key off entirely when none was sent', () => {
      const parsed = parseCommand({ type: 'move', unitId: 'u1', path, facing: 'north' });
      expect(Object.keys(parsed ?? {})).not.toContain('attackKind');
    });

    it('refuses a kind it does not know rather than dropping it', () => {
      expect(
        parseCommand({
          type: 'move',
          unitId: 'u1',
          path,
          facing: 'north',
          targetUnitId: 'r3',
          attackKind: 'bayonet',
        }),
      ).toBeNull();
    });

    it('an endTurn command', () => {
      expect(parseCommand({ type: 'endTurn' })).toEqual({ type: 'endTurn' });
    });

    it('a surrender, with anything smuggled onto it stripped', () => {
      expect(parseCommand({ type: 'surrender', actor: 'red', winner: 'red' })).toEqual({
        type: 'surrender',
      });
    });

    it('a single-element path -- legal, and means "act without moving"', () => {
      const single = [{ col: 3, row: 4 }];
      expect(parseCommand({ type: 'move', unitId: 'u1', path: single, facing: 'south' })).toEqual({
        type: 'move',
        unitId: 'u1',
        path: single,
        facing: 'south',
      });
    });
  });

  describe('rejects', () => {
    // ⚠️ Every case starts from a command that parses and breaks exactly one
    // thing. A case that also left out a second field would be refused for
    // that field, and prove nothing about the one it names -- which is how
    // the path bound and the empty-path check went unexercised.
    const valid = { type: 'move', unitId: 'u1', path, facing: 'north' };
    const without = (field: keyof typeof valid): unknown =>
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));

    it('parses the command every case below starts from', () => {
      expect(parseCommand(valid)).not.toBeNull();
    });

    const rejected: [string, unknown][] = [
      ['null', null],
      ['a string', 'move'],
      ['an array', [valid]],
      ['an unknown type', { ...valid, type: 'selfDestruct' }],
      ['a missing type', without('type')],
      ['a non-string unitId', { ...valid, unitId: 7 }],
      ['a missing path', without('path')],
      ['a non-array path', { ...valid, path: 'north' }],
      ['an empty path', { ...valid, path: [] }],
      ['a path holding a non-coordinate', { ...valid, path: [{ col: 0 }] }],
      ['a path with non-integer coordinates', { ...valid, path: [{ col: 0.5, row: 1 }] }],
      ['a move with no facing at all', without('facing')],
      ['a facing that is not one of the four', { ...valid, facing: 'up' }],
      ['a facing that is not even a string', { ...valid, facing: 0 }],
      // ⚠️ Refused rather than dropped. Silently discarding a malformed target
      // would turn an attack into a plain move: the command would succeed and
      // do something the player never asked for.
      ['a target that is present but not a string', { ...valid, targetUnitId: 7 }],
      ['an attack kind that is neither', { ...valid, targetUnitId: 'r1', attackKind: 'bite' }],
    ];

    for (const [name, input] of rejected) {
      it(name, () => expect(parseCommand(input)).toBeNull());
    }

    // A defensive allocation bound, not a game rule -- validatePath owns the
    // real limit. This stops a body that fits under maxRequestBodySize from
    // still materialising thousands of coordinates.
    it('a path longer than MAX_PATH_STEPS', () => {
      const long = Array.from({ length: 257 }, (_, i) => ({ col: i, row: 0 }));
      expect(parseCommand({ ...valid, path: long })).toBeNull();
      expect(parseCommand({ ...valid, path: long.slice(0, 256) })).not.toBeNull();
    });
  });

  // The security property: parseCommand *constructs* the result rather than
  // passing the input through, so a client cannot smuggle fields into the
  // authority -- `actor` above all, which is what keeps Command and Action
  // distinct at runtime rather than only in the type system.
  describe('drops everything it was not asked for', () => {
    it('strips a smuggled actor from a move', () => {
      const parsed = parseCommand({
        type: 'move',
        unitId: 'u1',
        path,
        facing: 'north',
        actor: 'red',
      });
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty('actor');
    });

    it('strips a smuggled actor from an endTurn', () => {
      const parsed = parseCommand({ type: 'endTurn', actor: 'red' });
      expect(parsed).toEqual({ type: 'endTurn' });
    });

    it('strips arbitrary extra properties', () => {
      const parsed = parseCommand({
        type: 'move',
        unitId: 'u1',
        path,
        facing: 'north',
        rolls: [6, 6],
      });
      expect(Object.keys(parsed ?? {}).sort()).toEqual(['facing', 'path', 'type', 'unitId']);
    });

    it('strips extra properties from inside a coordinate', () => {
      const parsed = parseCommand({
        type: 'move',
        unitId: 'u1',
        facing: 'north',
        path: [{ col: 0, row: 0, elevation: 9 }],
      });
      expect(parsed).toEqual({
        type: 'move',
        unitId: 'u1',
        path: [{ col: 0, row: 0 }],
        facing: 'north',
      });
    });
  });
});
