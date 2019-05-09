import {
  SymbolInformation,
  DocumentSymbol
} from "vscode-languageserver-protocol";

export type LSPSymbol = SymbolInformation | DocumentSymbol;
