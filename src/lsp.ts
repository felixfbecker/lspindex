import {
  SymbolInformation,
  DocumentSymbol,
  SymbolKind
} from "vscode-languageserver-protocol";

export type LSPSymbol = SymbolInformation | DocumentSymbol;

export const SYMBOL_KIND_DIRECTORY = 400 as SymbolKind;
