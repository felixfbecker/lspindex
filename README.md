# lspquery

A CLI tool to start a language server speaking the
[Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
on a project, query all its symbols and references and output the result as
graph encoded in GXL.

## Usage

```
lsp2gxl --rootUri <rootUri> <language server command to run>

Options:
  --version      Show version number                                   [boolean]
  --rootPath     The rootUri to pass to the language server in the initialize
                 message                                     [string] [required]
  --filePattern  Glob pattern for files that symbols should be collected from
                 (relative to rootPath)                                 [string]
  --outFile      The file path to the output GXL file        [string] [required]
  --help         Show help                                             [boolean]

Examples:
  lsp2gxl --rootPath                        Analyze Python files in the flask
  /Users/felix/git/flask --filePattern      project with the Python language
  '**/*.py' --outFile flask.gxl pyls        server and write the result to
                                            flask.gxl
```

## Build

You need NodeJS installed.

```
npm install
```
