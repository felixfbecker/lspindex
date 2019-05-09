import {
  SymbolInformation,
  DocumentSymbol,
  SymbolKind
} from "vscode-languageserver-types";
import { JSDOM, DOMWindow } from "jsdom";
import hashObject from "object-hash";
import { fileURLToPath } from "url";
import { LSPSymbol } from "./lsp";

type GXLEdgeType = "Source_Dependency" | "Enclosing";

const XLINK_NS = "http://www.w3.org/1999/xlink";

export function asGXL(
  symbolsByFile: Map<string, LSPSymbol[]>,
  references: Map<LSPSymbol, LSPSymbol[]>
): string {
  const jsdom = new JSDOM(
    `<?xml version="1.0" encoding="utf-8"?>
    <gxl xmlns:xlink="http://www.w3.org/1999/xlink"></gxl>`,
    { contentType: "application/xml" }
  );
  const window = jsdom.window as DOMWindow & typeof globalThis;
  const document: XMLDocument = window.document;
  const graphElement = document.documentElement.appendChild(
    document.createElement("graph")
  );
  graphElement.setAttribute("id", hashObject([symbolsByFile, references]));

  function createGXLType(type: string) {
    const typeEl = document.createElement("type");
    typeEl.setAttributeNS(XLINK_NS, "xlink:href", type);
    return typeEl;
  }

  function createGXLNode(
    id: string,
    type: string,
    attrs: Record<string, string | number | undefined>
  ): Element {
    const node = document.createElement("node");
    node.setAttribute("id", id);
    node.append("\n  ", createGXLType(type));

    for (const [name, value] of Object.entries(attrs)) {
      if (value) {
        addGXLAttribute(node, name, value);
      }
    }

    node.append("\n");
    return node;
  }

  function createGXLEdge(from: string, to: string, type: GXLEdgeType): Element {
    const edge = document.createElement("edge");
    edge.setAttribute("from", from);
    edge.setAttribute("to", to);
    edge.append("\n  ", createGXLType(type));
    return edge;
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

  for (const [uri, symbols] of symbolsByFile) {
    for (const symbol of symbols) {
      const nodeID = hashObject(symbol);
      const type = getGXLSymbolKind(symbol);
      if (!type) {
        continue;
      }
      const range = DocumentSymbol.is(symbol)
        ? symbol.range
        : symbol.location.range;
      const node = createGXLNode(nodeID, type, {
        "Source.Name": symbol.name,
        "Source.Line": range.start.line,
        "Source.Column": range.start.character,
        "Source.Path": fileURLToPath(uri)
      });
      graphElement.append("\n", node);

      // References
      for (const reference of references.get(symbol) || []) {
        const referenceNodeID = hashObject(reference);
        const edge = createGXLEdge(
          referenceNodeID,
          nodeID,
          "Source_Dependency"
        );
        graphElement.append("\n", edge);
      }
    }
  }

  const serializer = new window.XMLSerializer();
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    serializer.serializeToString(document)
  );
}

export function getGXLSymbolKind(symbol: LSPSymbol): string | undefined {
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
