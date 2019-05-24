import { DocumentSymbol, SymbolKind } from "vscode-languageserver-types";
import { JSDOM, DOMWindow } from "jsdom";
import hashObject from "object-hash";
import { fileURLToPath, pathToFileURL } from "url";
import { LSPSymbol } from "./lsp";
import * as path from "path";
import { Signale } from "signale";
import chalk from "chalk";

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
  document.documentElement.append("\n  ", graphElement);
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
    node.append("\n      ", createGXLType(type));

    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) {
        throw new Error(`Attribute ${name} for node ${id} has no value`);
      }
      addGXLAttribute(node, name, value);
    }

    node.append("\n    ");
    return node;
  }

  function createGXLEdge(from: string, to: string, type: GXLEdgeType): Element {
    const edge = document.createElement("edge");
    edge.setAttribute("from", from);
    edge.setAttribute("to", to);
    edge.setAttribute("id", hashObject({ from, to, type }));
    edge.append("\n      ", createGXLType(type), "\n    ");
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
    node.append("\n      ", attribute);
  }

  const nodeIds = new Set<string>();
  const edgeNodeIds: { from: string; to: string }[] = [];

  for (const [uri, symbols] of symbolsByFile) {
    const filePath = fileURLToPath(uri);
    const relativeFilePath = path.relative(rootPath, filePath);
    for (const symbol of symbols) {
      const type = getGXLSymbolKind(symbol);
      if (!type) {
        logger.info("Skipping symbol", chalk.bold(symbol.name));
        continue;
      }
      const nodeID = symbolId(symbol);
      nodeIds.add(nodeID);
      const range = DocumentSymbol.is(symbol)
        ? symbol.range
        : symbol.location.range;

      // Add Enclosing edge from file/directory to parent directory
      if (symbol.kind === SymbolKind.File) {
        // Don't go past the root path
        if (
          relativeFilePath === ".." ||
          relativeFilePath.startsWith(".." + path.sep)
        ) {
          throw Object.assign(
            new Error("File outside the root made it into the index"),
            { symbol }
          );
        }
        // Don't add an Enclosing edge for the root directory node
        if (relativeFilePath !== "") {
          const parentDirectoryPath = path.join(filePath, "..");
          const parentDirectoryUri = pathToFileURL(parentDirectoryPath).href;
          const parentDirSymbols = symbolsByFile.get(parentDirectoryUri);
          if (parentDirSymbols) {
            if (
              parentDirSymbols.length !== 1 ||
              parentDirSymbols[0].kind !== SymbolKind.File
            ) {
              logger.error(
                "Expected parent dir to only have a single symbol of kind File, got",
                parentDirSymbols
              );
            }
            logger.info(
              "Adding Enclosing edge to directory of",
              relativeFilePath
            );
            // from : child
            // to   : parent
            const from = nodeID;
            const to = symbolId(parentDirSymbols[0]);
            const edge = createGXLEdge(from, to, "Enclosing");
            graphElement.append("\n    ", edge);
            edgeNodeIds.push({ from, to });
          } else if (filePath !== rootPath) {
            logger.error("Expected parent dir symbol for symbol", symbol, {
              relativeFilePath,
              rootPath,
              parentDirectoryPath
            });
          }
        }
      } else {
        // Try to add an edge to containerName, if exists
        if (!DocumentSymbol.is(symbol)) {
          const container = symbols.find(s => s.name === symbol.containerName);
          if (container) {
            logger.info(
              "Adding Encloding edge from",
              chalk.bold(symbol.name),
              "to container",
              chalk.bold(container.name)
            );
            // from : child
            // to   : parent
            const from = nodeID;
            const to = symbolId(container);
            const edge = createGXLEdge(from, to, "Enclosing");
            graphElement.append("\n    ", edge);
            edgeNodeIds.push({ from, to });
          } else {
            // Add edge to containing file
            const fileSymbol = symbols.find(
              s =>
                s.kind === SymbolKind.File && s.name === path.basename(filePath)
            );
            if (!fileSymbol) {
              logger.error(
                "Expected document symbols for file",
                relativeFilePath,
                "to contain symbol of kind File",
                symbols
              );
            } else {
              logger.info(
                "Adding Encloding edge from",
                chalk.bold(symbol.name),
                "to containing file",
                chalk.bold(relativeFilePath)
              );
              const from = nodeID;
              const to = symbolId(fileSymbol);
              const edge = createGXLEdge(from, to, "Enclosing");
              graphElement.append("\n    ", edge);
              edgeNodeIds.push({ from, to });
            }
          }
        }
      }

      logger.info(
        "Adding node for",
        type,
        chalk.bold(symbol.name),
        "in",
        relativeFilePath
      );
      const node = createGXLNode(nodeID, type, {
        "Source.Name": symbol.name,
        "Source.Line": range.start.line,
        "Source.Column": range.start.character,
        "Source.Path": path.relative(rootPath, fileURLToPath(uri))
      });
      graphElement.append("\n    ", node);

      // References
      const referencesToSymbol = references.get(symbol) || [];
      if (referencesToSymbol.length > 0) {
        for (const referenceSymbol of referencesToSymbol) {
          const referenceNodeID = symbolId(referenceSymbol);
          edgeNodeIds.push({ from: referenceNodeID, to: nodeID });
          logger.info(
            "Adding Source_Dependency edge from",
            chalk.bold(referenceSymbol.name),
            "to",
            chalk.bold(symbol.name)
          );
          const edge = createGXLEdge(
            referenceNodeID,
            nodeID,
            "Source_Dependency"
          );
          graphElement.append("\n    ", edge);
        }
      }
    }
  }

  graphElement.append("\n  ");
  document.documentElement.append("\n");

  // Make sure there are no non-existing edge references
  logger.await("Validating edge IDs");
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
  return xmlStr;
}

export function getGXLSymbolKind(symbol: LSPSymbol): string | undefined {
  switch (symbol.kind) {
    case SymbolKind.File:
      // case SymbolKind.Module:
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
