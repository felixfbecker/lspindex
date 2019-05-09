import yargs = require("yargs");
import {
  WorkspaceSymbolRequest,
  InitializeRequest,
  InitializeParams,
  ShutdownRequest,
  DocumentSymbolRequest,
  SymbolInformation,
  DocumentSymbol,
  DocumentSymbolParams,
  ReferenceParams,
  ReferencesRequest,
  Location,
  SymbolKind
} from "vscode-languageserver-protocol";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from "vscode-jsonrpc";
import { spawn } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";
import glob from "fast-glob";
import { asGXL, getGXLSymbolKind } from "./gxl";
import { writeFile, readFile } from "mz/fs";
import { Range } from "@sourcegraph/extension-api-classes";
import { LSPSymbol } from "./lsp";

async function main() {
  const using: (() => any)[] = [];
  try {
    const argv = yargs
      .option("rootPath", {
        type: "string",
        demandOption: true,
        description:
          "The rootUri to pass to the language server in the initialize message"
      })
      .option("filePattern", {
        type: "string",
        description:
          "Glob pattern for files that symbols should be collected from (relative to rootPath)"
      })
      .option("outFile", {
        type: "string",
        description: "The file path to the output GXL file",
        demandOption: true
      })
      .usage("lsp2gxl --rootUri <rootUri> <language server command to run>")
      .example(
        `lsp2gxl --rootPath /Users/felix/git/flask --filePattern '**/*.py' --outFile flask.gxl pyls`,
        "Analyze Python files in the flask project with the Python language server and write the result to flask.gxl"
      )
      .help().argv;
    if (argv._.length < 1) {
      console.error("No language server command given");
      process.exitCode = 1;
      return;
    }
    console.log("running", argv._);

    // Spawn language server
    const childProcess = spawn(argv._[0], argv._.slice(1));
    using.push(() => childProcess.kill());
    const connection = createMessageConnection(
      new StreamMessageReader(childProcess.stdout),
      new StreamMessageWriter(childProcess.stdin),
      console
    );
    connection.listen();
    using.push(() => connection.sendRequest(ShutdownRequest.type));
    connection.onError(err => console.error(err));

    // Initialize
    const rootPath = path.resolve(argv.rootPath);
    const initParams: InitializeParams = {
      rootPath,
      rootUri: pathToFileURL(rootPath).href,
      processId: process.pid,
      capabilities: {},
      workspaceFolders: null
    };
    const initResult = await connection.sendRequest(
      InitializeRequest.type,
      initParams
    );
    console.log("initialize result", initResult);

    // Query symbols
    /** Map from URI to symbols */
    const symbols = new Map<string, LSPSymbol[]>();
    /** Map from definition to references */
    const allReferences = new Map<LSPSymbol, Location[]>();
    const symbolToSymbolReferences = new Map<LSPSymbol, LSPSymbol[]>();

    if (!argv.filePattern) {
      console.error("No file pattern provided");
      process.exitCode = 1;
      return;
    }
    const files = glob.stream(argv.filePattern, {
      absolute: true,
      cwd: rootPath,
      onlyFiles: true
    });
    for await (const file of files) {
      const uri = pathToFileURL(file.toString()).href;
      const docParams: DocumentSymbolParams = { textDocument: { uri } };
      console.log("Getting symbols for", file);
      const docSymbols = await connection.sendRequest(
        DocumentSymbolRequest.type,
        docParams
      );
      if (!docSymbols) {
        continue;
      }
      symbols.set(uri, docSymbols);

      // Get references for each symbol
      for (const symbol of docSymbols) {
        if (!getGXLSymbolKind(symbol)) {
          continue;
        }
        const range = DocumentSymbol.is(symbol)
          ? symbol.selectionRange
          : symbol.location.range;
        const referencePosition = range.start;
        const content = await readFile(file, { encoding: "utf-8" });
        const lineContent = content.split("\n")[range.start.line];
        // Don't get references on import bindings
        if (/\bimport\b/.test(lineContent)) {
          continue;
        }
        if (lineContent.slice(referencePosition.character).startsWith("def ")) {
          referencePosition.character += "def ".length + 1;
        }
        if (
          lineContent.slice(referencePosition.character).startsWith("class ")
        ) {
          referencePosition.character += "class ".length + 1;
        }
        console.log("\nGetting references for", symbol.name);
        console.log(
          lineContent.slice(0, range.start.character) +
            "❗️" +
            lineContent.slice(range.start.character)
        );
        const referenceParams: ReferenceParams = {
          context: { includeDeclaration: false },
          textDocument: { uri },
          position: referencePosition
        };
        const references = await connection.sendRequest(
          ReferencesRequest.type,
          referenceParams
        );
        console.log("references", references && references.length);
        allReferences.set(symbol, references || []);
      }
    }

    // After knowing all symbols:
    // For each reference, check all symbol ranges to find the symbol range the reference is contained in.
    for (const [definitionSymbol, references] of allReferences) {
      const referencingSymbols: LSPSymbol[] = [];
      for (const reference of references) {
        const documentSymbols: LSPSymbol[] | undefined = symbols.get(
          reference.uri
        );
        if (!documentSymbols) {
          continue;
        }
        const referenceRange = Range.fromPlain(reference.range);
        const referencingSymbol = documentSymbols.find(symbol =>
          Range.fromPlain(
            DocumentSymbol.is(symbol) ? symbol.range : symbol.location.range
          ).contains(referenceRange)
        );
        if (!referencingSymbol) {
          console.log(
            `Reference to ${definitionSymbol.name} was not within any symbol`
          );
          // TODO add a symbol for each file, then fallback to using the file symbol
          continue;
        }
        console.log(
          `Mapped reference from ${referencingSymbol.name} to ${
            definitionSymbol.name
          }`
        );
        referencingSymbols.push(referencingSymbol);
      }
      symbolToSymbolReferences.set(definitionSymbol, referencingSymbols);
    }

    const gxl = asGXL(symbols, symbolToSymbolReferences);
    const outFile = path.resolve(argv.outFile);
    await writeFile(outFile, gxl);
    console.log("wrote result to", outFile);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    for (const fn of using) {
      await fn();
    }
  }
}

main();
