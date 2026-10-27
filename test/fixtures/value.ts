/** Fail at the fixture boundary instead of hiding a missing row, element or response from TypeScript. */
export function fixtureValue<T>(value: T, description: string): NonNullable<T> {
  if (value === undefined || value === null)
    throw new Error(`Missing fixture value: ${description}`);
  return value;
}
