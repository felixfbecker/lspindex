import {
  SymbolInformation,
  DocumentSymbol,
  SymbolKind
} from "vscode-languageserver-types";
import { JSDOM } from "jsdom";
import hashObject from "object-hash";
import { fileURLToPath } from "url";

const XLINK_NS = "http://www.w3.org/1999/xlink";

export function asGXL(symbols: (SymbolInformation | DocumentSymbol)[]): string {
  const jsdom = new JSDOM(
    `<?xml version="1.0" encoding="utf-8"?>
    <gxl xmlns:xlink="http://www.w3.org/1999/xlink"></gxl>`,
    { contentType: "application/xml" }
  );
  const document: XMLDocument = jsdom.window.document;
  const graphElement = document.documentElement.appendChild(
    document.createElement("graph")
  );
  graphElement.setAttribute("id", Date.now() + "");

  function createGXLNode(
    id: string,
    type: string,
    attrs: Record<string, string | number | undefined>
  ): Element {
    const node = document.createElement("node");
    node.setAttribute("id", id);

    const typeEl = document.createElement("type");
    typeEl.setAttributeNS(XLINK_NS, "xlink:href", type);
    node.appendChild(typeEl);

    for (const [name, value] of Object.entries(attrs)) {
      if (value) {
        addGXLAttribute(node, name, value);
      }
    }

    node.append("\n");
    return node;
  }

  function addGXLAttribute(
    node: Element,
    name: string,
    value: string | number
  ): void {
    let type: string;
    if (typeof value === "number" && Number.isInteger(value)) {
      type = "int";
    } else if (typeof value === "string") {
      type = "string";
    } else {
      throw new Error("Invalid type");
    }
    const attribute = document.createElement("attr");
    attribute.setAttribute("name", name);
    const valueElement = attribute.appendChild(document.createElement(type));
    valueElement.textContent = value.toString();
    node.append("\n  ", attribute);
  }

  for (const symbol of symbols) {
    const type = getGXLSymbolKind(symbol);
    if (!type) {
      continue;
    }
    const range = DocumentSymbol.is(symbol)
      ? symbol.range
      : symbol.location.range;
    const node = createGXLNode(hashObject(symbol), type, {
      "Source.Name": symbol.name,
      "Source.Line": range.start.line,
      "Source.Column": range.start.character,
      "Source.Path": !DocumentSymbol.is(symbol)
        ? fileURLToPath(symbol.location.uri)
        : undefined
    });
    graphElement.append("\n", node);
  }

  const serializer = new (jsdom.window as any).XMLSerializer();
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    serializer.serializeToString(document)
  );
}

function getGXLSymbolKind(
  symbol: SymbolInformation | DocumentSymbol
): string | undefined {
  switch (symbol.kind) {
    case SymbolKind.Module:
      return "File";
    case SymbolKind.Class:
      return "Class";
    case SymbolKind.Field:
    case SymbolKind.Property:
      return "Member";
    case SymbolKind.Method:
      return "Method";
    case SymbolKind.Function:
      return "Routine";
  }
}
