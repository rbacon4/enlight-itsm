/**
 * Derives a default project key from a slug (used when no custom key is given).
 *
 * "it-helpdesk"     → "IH"
 * "hr-support"      → "HS"
 * "general-it"      → "GI"
 * "helpdesk"        → "HELP"
 */
export function projectKey(slug: string): string {
  const words = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .split('-')
    .filter(Boolean);

  if (words.length >= 2) {
    return words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 5);
  }

  return (words[0] ?? slug).slice(0, 4).toUpperCase();
}

/** Normalises a raw key input: uppercase, strip non-alphanumeric. */
export function normaliseKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/** Returns a display ticket ID like "IH-42" given the project's stored key. */
export function ticketId(key: string, ticketNumber: number): string {
  return `${key}-${ticketNumber}`;
}
