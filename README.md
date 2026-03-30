# FormaTeX VS Code Extension

Compile LaTeX using FormaTeX API directly from VS Code.

## Features

- Secure API key storage using VS Code Secret Storage
- Compile current `.tex` document
- Compile selected `.tex` file from Explorer
- Compile full LaTeX project with dependency packaging
- Syntax check without full compilation
- Save output PDFs to `.formatex/output`
- Show compile logs and diagnostics

## Commands

- `FormaTeX: Set API Key`
- `FormaTeX: Clear API Key`
- `FormaTeX: Compile Current Document`
- `FormaTeX: Compile Selected File`
- `FormaTeX: Compile Project`
- `FormaTeX: Check Syntax`
- `FormaTeX: Open Last PDF`
- `FormaTeX: Show Compile Output`
- `FormaTeX: Show Usage`

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to run the Extension Development Host.

## Packaging

```bash
npm run package
```

This generates a `.vsix` artifact.
