import {
  adjectives,
  animals,
  NumberDictionary,
  uniqueNamesGenerator,
} from 'unique-names-generator';

/**
 * A name nobody had to choose -- *Brave-Otter-482* -- for a guest that has not
 * chosen one, so diving in takes no typing. Server-side, so the word lists never
 * reach the client's bundle. Not promised unique: it is what an opponent sees,
 * and identity is the guest's id.
 */
export function generateName(): string {
  return uniqueNamesGenerator({
    // ⚠️ Made per name: the "dictionary" is one number, drawn when it is made.
    dictionaries: [adjectives, animals, NumberDictionary.generate({ min: 100, max: 999 })],
    separator: '-',
    style: 'capital',
  });
}

/** Long enough for any name `generateName` makes. */
const NAME_LENGTH = 40;

/**
 * A name a player sent, trimmed and bounded, or `null` for one with nothing in
 * it -- which is then generated, as an unsent one is.
 */
export function readName(sent: string): string | null {
  // By code point, so a bound never splits a character in two.
  // eslint-disable-next-line no-control-regex
  const name = Array.from(sent.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .slice(0, NAME_LENGTH)
    .join('')
    .trim();
  return name || null;
}
