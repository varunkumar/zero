// `command-score` is a CommonJS package with no bundled type declarations
// (`module.exports = commandScore`). This ambient declaration describes the
// single function it exports; it only affects type-checking, not runtime
// module resolution.
declare module "command-score" {
  export default function commandScore(string: string, abbreviation: string): number;
}
