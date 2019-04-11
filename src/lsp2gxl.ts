import yargs = require("yargs");
import {
  WorkspaceSymbolRequest,
  InitializeRequest,
  InitializeParams,
  ShutdownRequest,
  DocumentSymbolRequest,
  SymbolInformation,
  DocumentSymbol,
  DocumentSymbolParams
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
import { asGXL } from "./gxl";
import { writeFile } from "mz/fs";

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
    let symbols: (SymbolInformation | DocumentSymbol)[] = [];
    if (initResult.capabilities.workspaceSymbolProvider) {
      symbols =
        (await connection.sendRequest(WorkspaceSymbolRequest.type, {})) || [];
    } else {
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
        const docParams: DocumentSymbolParams = {
          textDocument: {
            uri: pathToFileURL(file.toString()).href
          }
        };
        console.log("Getting symbols for", file);
        const docSymbols = await connection.sendRequest(
          DocumentSymbolRequest.type,
          docParams
        );
        symbols.push(...(docSymbols || []));
      }
    }
    console.log(`${symbols.length} symbols found`);

    const gxl = asGXL(symbols);
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
