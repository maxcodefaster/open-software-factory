export function searchExpression(value: string) {
  const terms = [
    ...new Set(
      value
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu)
        ?.filter(
          (term) => !["about", "from", "have", "that", "this", "what", "which"].includes(term),
        ) ?? [],
    ),
  ].slice(0, 12);
  return terms.length ? terms.join(" | ") : value.replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
}
