const stopwords: Record<string, readonly string[]> = {
  de: [
    "der",
    "die",
    "das",
    "und",
    "ist",
    "nicht",
    "mit",
    "für",
    "von",
    "den",
    "wird",
    "auf",
    "ein",
    "eine",
    "zu",
    "im",
    "bei",
    "oder",
    "als",
    "auch",
  ],
  en: [
    "the",
    "and",
    "is",
    "not",
    "with",
    "for",
    "of",
    "to",
    "in",
    "on",
    "this",
    "that",
    "are",
    "be",
    "or",
    "as",
    "it",
    "from",
    "by",
    "an",
  ],
};

/**
 * The language the Project's own documentation is written in, when it is clearly German or
 * English. Anything else returns undefined and agents match the repository's documentation.
 */
export function documentationLanguage(samples: readonly string[]): "de" | "en" | undefined {
  const words = samples
    .join("\n")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .match(/[a-zäöüß]+/g);
  if (!words || words.length < 40) return undefined;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const score = (language: string) =>
    (stopwords[language] ?? []).reduce((total, word) => total + (counts.get(word) ?? 0), 0);
  const german = score("de");
  const english = score("en");
  if (german > english * 1.5) return "de";
  if (english > german * 1.5) return "en";
  return undefined;
}
