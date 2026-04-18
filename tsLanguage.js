// tree-sitter-typescript exports two grammars: typescript and tsx
// This helper resolves the right one based on file extension.
import TSModule from "tree-sitter-typescript";

const { typescript, tsx } = TSModule;

export function typescriptLanguage(ext) {
  return ext === ".tsx" ? tsx : typescript;
}
