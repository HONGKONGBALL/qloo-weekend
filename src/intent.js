/**
 * Parse a free-text taste query or a mood chip into agent intent.
 * Free text: English, max 200 characters, up to 3 interests (comma/semicolon/newline split).
 */

export const DEFAULT_MOOD = "outdoors";

export const MOOD_IDS = ["outdoors", "culture", "film", "quiet"];

export const MOOD_LOOKUP = {
  outdoors: {
    tagQuery: "park",
    preferTypes: ["urn:tag:genre:place", "urn:tag:category:place"],
    entityQuery: "Hong Kong Park",
    entityTypes: "urn:entity:place",
  },
  culture: {
    tagQuery: "museum",
    preferTypes: ["urn:tag:genre:place", "urn:tag:category:place"],
    entityQuery: "Hong Kong Museum of Art",
    entityTypes: "urn:entity:place",
  },
  film: {
    tagQuery: "movie theater",
    preferTypes: ["urn:tag:category:place", "urn:tag:genre:place"],
    entityQuery: "In the Mood for Love",
    entityTypes: "urn:entity:movie",
  },
  quiet: {
    tagQuery: "quiet",
    preferTypes: ["urn:tag:ambience:qloo", "urn:tag:noise_level:qloo"],
    entityQuery: "tea house",
    entityTypes: "urn:entity:place",
  },
};

const MAX_CHARS = 200;
const MAX_INTERESTS = 3;

/**
 * @param {{ q?: string, mood?: string }} input
 * @returns {{ ok: true, interests: string[], mood: string|null, raw: string } | { ok: false, error: string }}
 */
export function parseIntent(input = {}) {
  const moodRaw = input.mood == null ? "" : String(input.mood).trim();
  const qRaw = input.q == null ? "" : String(input.q);
  const q = qRaw.trim().slice(0, MAX_CHARS);

  if (moodRaw && !MOOD_IDS.includes(moodRaw)) {
    return {
      ok: false,
      error: `Unknown mood. Choose one of: ${MOOD_IDS.join(", ")}.`,
    };
  }

  if (q) {
    const parts = q
      .split(/[,;\n]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, MAX_INTERESTS);
    const interests = parts.length ? parts : [q];
    return {
      ok: true,
      interests,
      mood: moodRaw && MOOD_IDS.includes(moodRaw) ? moodRaw : null,
      raw: q,
    };
  }

  const mood = moodRaw && MOOD_IDS.includes(moodRaw) ? moodRaw : DEFAULT_MOOD;
  const lookup = MOOD_LOOKUP[mood];
  return {
    ok: true,
    interests: [lookup.entityQuery],
    mood,
    raw: "",
  };
}
