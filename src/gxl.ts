import { DocumentSymbol, SymbolKind } from "vscode-languageserver-types";
import { JSDOM, DOMWindow } from "jsdom";
import hashObject from "object-hash";
import { fileURLToPath, pathToFileURL } from "url";
import { LSPSymbol } from "./lsp";
import * as path from "path";
import formatXml from "xml-formatter";
import { Signale } from "signale";

type GXLEdgeType = "Source_Dependency" | "Enclosing";

const symbolId = (symbol: LSPSymbol): string =>
  String(symbol.kind) +
  ":" +
  String(getGXLSymbolKind(symbol)) +
  ":" +
  symbol.name +
  ":" +
  hashObject(symbol);

interface GXLNodeAttributes {
  "Source.Name": string;
  "Source.Line": number;
  "Source.Column": number;
  "Source.Path": string;
}

const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_PROCESSING_INSTRUCTION = '<?xml version="1.0" encoding="utf-8"?>';

export function asGXL(
  symbolsByFile: Map<string, LSPSymbol[]>,
  references: Map<LSPSymbol, LSPSymbol[]>,
  rootPath: string,
  logger: Signale
): string {
  const jsdom = new JSDOM(
    `${XML_PROCESSING_INSTRUCTION}
    <gxl xmlns:xlink="http://www.w3.org/1999/xlink"></gxl>`,
    { contentType: "application/xml" }
  );
  const window = jsdom.window as DOMWindow & typeof globalThis;
  const document: XMLDocument = window.document;
  const graphElement = document.createElement("graph");
  graphElement.setAttribute("edgeids", String(true));
  document.documentElement.append(graphElement);
  graphElement.setAttribute("id", hashObject([symbolsByFile, references]));

  function createGXLType(type: string): Element {
    const typeEl = document.createElement("type");
    typeEl.setAttributeNS(XLINK_NS, "xlink:href", type);
    return typeEl;
  }

  function createGXLNode(
    id: string,
    type: string,
    attrs: GXLNodeAttributes
  ): Element {
    const node = document.createElement("node");
    node.setAttribute("id", id);
    node.append(createGXLType(type));

    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) {
        throw new Error(`Attribute ${name} for node ${id} has no value`);
      }
      addGXLAttribute(node, name, value);
    }

    return node;
  }

  function createGXLEdge(from: string, to: string, type: GXLEdgeType): Element {
    const edge = document.createElement("edge");
    edge.setAttribute("from", from);
    edge.setAttribute("to", to);
    edge.setAttribute("id", hashObject({ from, to, type }));
    edge.append(createGXLType(type));
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
    node.append(attribute);
  }

  const nodeIds = new Set<string>();
  const edgeNodeIds: { from: string; to: string }[] = [];

  for (const [uri, symbols] of symbolsByFile) {
    for (const symbol of symbols) {
      const type = getGXLSymbolKind(symbol);
      if (!type) {
        continue;
      }
      const nodeID = symbolId(symbol);
      nodeIds.add(nodeID);
      const range = DocumentSymbol.is(symbol)
        ? symbol.range
        : symbol.location.range;

      // Add node for parent directory
      if (symbol.kind === SymbolKind.File) {
        const filePath = fileURLToPath(uri);
        const relativeFilePath = path.relative(rootPath, filePath);
        if (
          relativeFilePath !== ".." &&
          !relativeFilePath.startsWith(".." + path.sep)
        ) {
          const parentDirectoryPath = path.join(filePath, "..");
          const parentDirectoryUri = pathToFileURL(parentDirectoryPath).href;
          if (parentDirectoryPath !== rootPath) {
            const parentDirSymbols = symbolsByFile.get(parentDirectoryUri);
            if (parentDirSymbols) {
              if (
                parentDirSymbols.length > 1 ||
                parentDirSymbols[0].kind !== SymbolKind.File
              ) {
                logger.error(
                  "Error: Expected parent dir to only have a single symbol of kind File, got",
                  parentDirSymbols
                );
              }
              logger.info("Adding node for directory of", filePath);
              const edge = createGXLEdge(
                nodeID,
                symbolId(parentDirSymbols[0]),
                "Enclosing"
              );
              graphElement.append(edge);
            } else if (filePath !== rootPath) {
              logger.error(
                "Error: Expected parent dir symbol for symbol",
                symbol,
                { relativeFilePath, rootPath, parentDirectoryPath }
              );
            }
          }
        }
      } else {
        // Try to add an edge to containerName, if exists
        if (!DocumentSymbol.is(symbol)) {
          const container = symbols.find(s => s.name === symbol.containerName);
          if (container) {
            createGXLEdge(nodeID, symbolId(container), "Enclosing");
          } else {
            // Add edge to containing file
            const fileSymbol = symbols.find(
              s =>
                s.kind === SymbolKind.File &&
                s.name === path.relative(rootPath, fileURLToPath(uri))
            )!;
            if (fileSymbol) {
              createGXLEdge(nodeID, symbolId(fileSymbol), "Enclosing");
            }
          }
        }
      }

      const node = createGXLNode(nodeID, type, {
        "Source.Name": symbol.name,
        "Source.Line": range.start.line,
        "Source.Column": range.start.character,
        "Source.Path": path.relative(rootPath, fileURLToPath(uri))
      });
      graphElement.append(node);

      // References
      const referencesToSymbol = references.get(symbol) || [];
      if (referencesToSymbol.length > 0) {
        for (const referenceSymbol of referencesToSymbol) {
          const referenceNodeID = symbolId(referenceSymbol);
          edgeNodeIds.push({ from: referenceNodeID, to: nodeID });
          const edge = createGXLEdge(
            referenceNodeID,
            nodeID,
            "Source_Dependency"
          );
          graphElement.append(edge);
        }
      }
    }
  }

  // Verify
  for (const edge of edgeNodeIds) {
    if (!nodeIds.has(edge.from)) {
      logger.error(`Edge is referencing non-existant from node ${edge.from}`);
    }

    if (!nodeIds.has(edge.to)) {
      logger.error(`Edge is referencing non-existant to node ${edge.to}`);
    }
  }

  logger.info(`${nodeIds.size} nodes total`);
  logger.info(`${edgeNodeIds.length} edges total`);

  logger.await("Serializing GXL");
  const serializer = new window.XMLSerializer();
  const xmlStr =
    XML_PROCESSING_INSTRUCTION + "\n" + serializer.serializeToString(document);
  logger.await("Formatting GXL");
  return formatXml(xmlStr, { collapseContent: true, stripComments: false });
}

export function getGXLSymbolKind(symbol: LSPSymbol): string | undefined {
  switch (symbol.kind) {
    case SymbolKind.File:
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
    // case SymbolKind.Variable:
    //   return "Variable";
  }
}
