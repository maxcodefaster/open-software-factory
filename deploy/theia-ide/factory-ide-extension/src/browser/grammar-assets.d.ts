// Theia's CommonJS extension compiler does not resolve the package's .d.mts subpaths.
// Keep the grammar-data boundary typed without loading Shiki's rendering engine.
declare module "@shikijs/langs/*" {
  const grammars: readonly {
    readonly scopeName: string;
    readonly name: string;
    readonly [key: string]: unknown;
  }[];
  export default grammars;
}
