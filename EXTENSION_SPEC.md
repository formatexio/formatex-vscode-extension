# FormaTeX VS Code Extension — Full Implementation Spec

> This document is a complete implementation spec for the next major version of the FormaTeX VS Code extension.
> It covers every new feature, all required backend endpoints, the full file structure, and per-component implementation details.
> The existing compilation functionality (`extension.ts`, `api.ts`, `project.ts`, `diagnostics.ts`, `settings.ts`, `types.ts`) is preserved as-is and extended.

---

## 1. What This Version Adds

The current extension (v0.1.0) only compiles local `.tex` files. This version adds:

1. **Cloud Project Panel** — an Activity Bar sidebar listing all FormaTeX cloud projects and their files
2. **Virtual File System (VFS)** — open and edit cloud project files directly in VS Code with automatic save-to-cloud
3. **URI Handler** — the FormaTeX web app can open a specific project in VS Code with one click
4. **"Open Locally" mode** — download a project as a local workspace (alternative to VFS)
5. **Cloud compilation** — compile the currently-open cloud project from VS Code
6. **Richer status bar** — shows connected user, plan, and active project

---

## 2. New Backend API Endpoints Required

The extension team must coordinate with the backend team to ship these endpoints. All are under `/api/v1/` and authenticated with `X-API-Key`.

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/projects` | List all projects for the authenticated user |
| `GET` | `/api/v1/projects/:id` | Get project metadata |

**`GET /api/v1/projects` response:**
```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "My Thesis",
      "mainFile": "main.tex",
      "fileCount": 12,
      "updatedAt": "2026-04-05T10:00:00Z",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

**`GET /api/v1/projects/:id` response:**
```json
{
  "id": "uuid",
  "name": "My Thesis",
  "mainFile": "main.tex",
  "fileCount": 12,
  "updatedAt": "2026-04-05T10:00:00Z",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

### Project Files

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/projects/:id/files` | List all files with metadata (no content) |
| `GET` | `/api/v1/projects/:id/files/*path` | Read a single file's content |
| `PUT` | `/api/v1/projects/:id/files/*path` | Write (create or update) a file |
| `DELETE` | `/api/v1/projects/:id/files/*path` | Delete a file |
| `POST` | `/api/v1/projects/:id/files/*path/rename` | Rename / move a file |
| `GET` | `/api/v1/projects/:id/export` | Export entire project as a ZIP archive |

**`GET /api/v1/projects/:id/files` response:**
```json
{
  "files": [
    {
      "path": "main.tex",
      "size": 4096,
      "updatedAt": "2026-04-05T10:00:00Z",
      "mimeType": "text/x-tex"
    },
    {
      "path": "figures/diagram.png",
      "size": 102400,
      "updatedAt": "2026-04-01T00:00:00Z",
      "mimeType": "image/png"
    }
  ]
}
```

**`GET /api/v1/projects/:id/files/*path` response:**
- For text files: `Content-Type: text/plain`, raw UTF-8 body
- For binary files: `Content-Type: application/octet-stream`, raw binary body
- Status `404` if file does not exist

**`PUT /api/v1/projects/:id/files/*path` request:**
- For text files: `Content-Type: text/plain`, raw UTF-8 body
- For binary files: `Content-Type: application/octet-stream`, raw binary body
- Response: `204 No Content` on success

**`DELETE /api/v1/projects/:id/files/*path` response:** `204 No Content`

**`POST /api/v1/projects/:id/files/*path/rename` request:**
```json
{ "newPath": "chapters/intro.tex" }
```
Response: `204 No Content`

**`GET /api/v1/projects/:id/export` response:** `Content-Type: application/zip`, ZIP archive containing all project files.

### User

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/me` | Get authenticated user info (name, email, plan) |

**`GET /api/v1/me` response:**
```json
{
  "name": "Alice",
  "email": "alice@example.com",
  "plan": "pro"
}
```

---

## 3. Extension File Structure

```
src/
  extension.ts          — existing (add new command registrations + URI handler + panel activation)
  api.ts                — existing (add project/file management methods to FormatexApiClient)
  types.ts              — existing (add new interfaces: Project, ProjectFile, UserInfo)
  settings.ts           — existing (add new settings: autoSyncOnSave, openMode)
  project.ts            — existing (unchanged)
  diagnostics.ts        — existing (unchanged)
  auth.ts               — NEW: credential/session helpers (extracted from extension.ts)
  status-bar.ts         — NEW: richer status bar component
  projects-tree.ts      — NEW: TreeDataProvider for the Projects panel
  vfs-provider.ts       — NEW: FileSystemProvider for formatex:// URIs
  uri-handler.ts        — NEW: vscode.UriHandler for vscode://formatex-io.formatex/...
  commands/
    cloud.ts            — NEW: open-project, open-locally, compile-cloud commands
```

---

## 4. New `types.ts` additions

Add these interfaces to the existing `types.ts`:

```typescript
export interface Project {
  id: string;
  name: string;
  mainFile: string;
  fileCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface ProjectFile {
  path: string;       // relative, e.g. "figures/diagram.png"
  size: number;
  updatedAt: string;
  mimeType: string;
}

export interface UserInfo {
  name: string;
  email: string;
  plan: string;
}
```

---

## 5. New `api.ts` additions

Add these methods to the existing `FormatexApiClient` class:

```typescript
// User
getMe(apiKey: string): Promise<ApiResponse<UserInfo>>

// Projects
listProjects(apiKey: string): Promise<ApiResponse<{ projects: Project[] }>>
getProject(projectId: string, apiKey: string): Promise<ApiResponse<Project>>

// Files
listFiles(projectId: string, apiKey: string): Promise<ApiResponse<{ files: ProjectFile[] }>>
readFile(projectId: string, filePath: string, apiKey: string): Promise<Uint8Array>
writeFile(projectId: string, filePath: string, content: Uint8Array, mimeType: string, apiKey: string): Promise<void>
deleteFile(projectId: string, filePath: string, apiKey: string): Promise<void>
renameFile(projectId: string, oldPath: string, newPath: string, apiKey: string): Promise<void>
exportProject(projectId: string, apiKey: string): Promise<Uint8Array>  // returns ZIP bytes
```

For `readFile` and `exportProject`: use raw `fetch` (not the JSON `request` helper), streaming the binary response as `arrayBuffer`.

For `writeFile`: send raw `Uint8Array` as the body with appropriate `Content-Type`.

---

## 6. New `settings.ts` additions

Add to `FormatexSettings` and `getSettings()`:

```typescript
// New fields:
openMode: "vfs" | "local";       // "vfs" = virtual FS (default), "local" = download to folder
autoSyncOnSave: boolean;          // only relevant for "vfs" mode (always true in VFS by design)
showProjectsPanel: boolean;       // show the FormaTeX activity bar panel (default: true)
localWorkspaceDir: string;        // base directory for "open locally" downloads (default: "")
```

New `package.json` configuration properties:
```json
"formatex.openMode": {
  "type": "string",
  "enum": ["vfs", "local"],
  "default": "vfs",
  "description": "How to open FormaTeX cloud projects. 'vfs' opens them as a virtual workspace (edits sync to cloud automatically). 'local' downloads them to a local folder."
},
"formatex.showProjectsPanel": {
  "type": "boolean",
  "default": true,
  "description": "Show the FormaTeX Projects panel in the Activity Bar."
},
"formatex.localWorkspaceDir": {
  "type": "string",
  "default": "",
  "description": "Base directory for 'open locally' project downloads. Defaults to the OS temp directory."
}
```

---

## 7. `auth.ts` (NEW)

Extract API key logic out of `extension.ts` into a dedicated module. Add user caching.

```typescript
const SECRET_API_KEY = "formatex.apiKey";

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | null>
export async function setApiKey(context: vscode.ExtensionContext): Promise<void>
export async function clearApiKey(context: vscode.ExtensionContext): Promise<void>

// Cached user info — fetched once per session, cleared on key change
export async function getCachedUser(
  context: vscode.ExtensionContext,
  client: FormatexApiClient
): Promise<UserInfo | null>

export function clearCachedUser(): void
```

`getCachedUser` fetches `GET /api/v1/me` on first call and caches the result in memory (not persisted — cleared on VS Code restart or key change). Used by the status bar and tree view header.

---

## 8. `status-bar.ts` (NEW)

Replace the single status bar item in `extension.ts` with a dedicated class.

### Behavior

- **Default (no key set):** `FormaTeX: Not connected` with warning icon, clicking opens "Set API Key"
- **Idle (key set, no project open):** `FormaTeX: Ready [plan]` — clicking shows the output channel
- **Project open:** `FormaTeX: [project name]` — clicking shows a quick pick with project actions
- **Compiling:** `$(sync~spin) FormaTeX: Compiling...`
- **Error:** `$(error) FormaTeX: Failed` — clicking shows output

### API

```typescript
export class FormatexStatusBar {
  constructor(context: vscode.ExtensionContext)
  setReady(user?: UserInfo): void
  setProject(projectName: string): void
  setCompiling(): void
  setFailed(): void
  setNotConnected(): void
  dispose(): void
}
```

---

## 9. `projects-tree.ts` (NEW)

Implements `vscode.TreeDataProvider<TreeNode>` for the FormaTeX Activity Bar panel.

### Tree structure

```
FORMATEX PROJECTS
  Alice (alice@example.com) — Pro       ← header node (not clickable)
  ─────────────────────────────────────
  My Thesis                             ← ProjectNode
    main.tex                            ← FileNode
    chapters/
      intro.tex
      conclusion.tex
    figures/
      diagram.png
  Conference Paper                      ← ProjectNode
    ...
```

### Node types

```typescript
type TreeNode = HeaderNode | ProjectNode | FolderNode | FileNode;

interface HeaderNode  { kind: "header"; label: string }
interface ProjectNode { kind: "project"; project: Project }
interface FolderNode  { kind: "folder"; projectId: string; folderPath: string; label: string }
interface FileNode    { kind: "file"; projectId: string; file: ProjectFile }
```

### TreeDataProvider implementation

- `getTreeItem(node)`: returns a `vscode.TreeItem` with appropriate:
  - `iconPath`: use `ThemeIcon` — `folder` / `file` / `account` etc.
  - `contextValue`: `"formatexProject"` / `"formatexFile"` / `"formatexFolder"` — used to attach context menu items
  - `command` on `FileNode`: `{ command: "formatex.openFile", arguments: [node] }`
  - `collapsibleState`: projects and folders are `Collapsed` by default
- `getChildren(node)`:
  - root → fetch `listProjects`, return header + project nodes
  - `ProjectNode` → fetch `listFiles` for that project, group into folder + file nodes
  - `FolderNode` → return its children from the already-fetched file list (cache per project)
- `refresh()`: clears cache, fires `_onDidChangeTreeData`

### Context menu commands (right-click on node)

On `ProjectNode` (contextValue `"formatexProject"`):
- **Open in VS Code** — `formatex.openProject`
- **Open Locally (Download)** — `formatex.openProjectLocally`
- **Compile** — `formatex.compileCloudProject`
- **Open in Browser** — `formatex.openProjectInBrowser`
- **Refresh** — `formatex.refreshProjectFiles`
- **Copy Project ID** — `formatex.copyProjectId`

On `FileNode` (contextValue `"formatexFile"`):
- **Open** — `formatex.openFile`
- **Rename** — `formatex.renameFile`
- **Delete** — `formatex.deleteFile`

### Refresh triggers

- On `setApiKey` / `clearApiKey`
- On VFS file write (debounced 2s)
- Manual refresh command

---

## 10. `vfs-provider.ts` (NEW)

Implements `vscode.FileSystemProvider` for the `formatex` URI scheme.

### URI format

```
formatex://<projectId>/<file-path>
formatex://abc123/main.tex
formatex://abc123/chapters/intro.tex
```

The authority component is the project ID. The path is the file path within the project.

### Implementation

```typescript
export class FormatexFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  // Cache: projectId -> Map<filePath, { content: Uint8Array, mtime: number, size: number }>
  private cache: Map<string, Map<string, CachedFile>> = new Map();

  stat(uri: vscode.Uri): vscode.FileStat
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][]
  readFile(uri: vscode.Uri): Uint8Array
  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void
  delete(uri: vscode.Uri, options: { recursive: boolean }): void
  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void
  createDirectory(uri: vscode.Uri): void
  watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[] }): vscode.Disposable
}
```

**Important implementation notes:**

- All `FileSystemProvider` methods are synchronous in the VS Code API signature but can return `Thenable`. Use async implementations returning Promises.
- `stat` on a directory URI (no file extension, or path ends with `/`) returns `{ type: FileType.Directory, ... }`. VS Code probes this to build the file tree.
- `readDirectory`: parse the cached file list for the project, build a virtual directory tree. A path `chapters/intro.tex` means `chapters/` is a directory containing `intro.tex`.
- `readFile`: check cache first. If not cached, call `api.readFile`, populate cache, return bytes.
- `writeFile`: upload via `api.writeFile`, update cache, fire `_onDidChangeFile` event with `Changed` type. Do NOT await the upload before returning to VS Code — queue writes and process them, firing the event once the upload completes.
- `delete` + `rename`: call respective API methods, update cache.
- File change events: fire `{ type: FileChangeType.Changed, uri }` after every successful write. The tree view should debounce and refresh on these events.

### Opening a VFS workspace

When the user opens a project (from tree or URI handler):

```typescript
// Open the project root as a VS Code workspace
const projectUri = vscode.Uri.from({ scheme: "formatex", authority: projectId, path: "/" });
vscode.workspace.updateWorkspaceFolders(
  vscode.workspace.workspaceFolders?.length ?? 0,
  null,
  { uri: projectUri, name: projectName }
);
```

This adds the FormaTeX project as a workspace folder. Files appear in the Explorer like a normal local project.

### Language support

Register the `formatex` scheme for the LaTeX language so syntax highlighting, IntelliSense, and the existing FormaTeX commands all work:

```json
// package.json
"languages": [
  {
    "id": "latex",
    "extensions": [".tex"],
    "aliases": ["LaTeX"]
  }
]
```

And in the extension:

```typescript
vscode.languages.setTextDocumentLanguage(doc, "latex");
// Or: ensure "formatex" scheme is treated as a "file" scheme for language purposes
```

---

## 11. `uri-handler.ts` (NEW)

Handles `vscode://formatex-io.formatex/<path>` URIs from the web app.

### Supported URIs

| URI | Action |
|-----|--------|
| `vscode://formatex-io.formatex/open?projectId=<id>` | Open project in VS Code (VFS or local per setting) |
| `vscode://formatex-io.formatex/open?projectId=<id>&file=<path>` | Open project and reveal/open the given file |

### Implementation

```typescript
export function registerUriHandler(
  context: vscode.ExtensionContext,
  client: FormatexApiClient,
  provider: FormatexFileSystemProvider
): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        if (uri.path !== "/open") return;

        const params = new URLSearchParams(uri.query);
        const projectId = params.get("projectId");
        const filePath  = params.get("file") ?? null;

        if (!projectId) return;

        // Ensure API key is configured
        const apiKey = await getApiKey(context);
        if (!apiKey) return;

        const settings = getSettings();
        if (settings.openMode === "local") {
          await openProjectLocally(context, client, apiKey, projectId, filePath);
        } else {
          await openProjectVfs(context, client, provider, apiKey, projectId, filePath);
        }
      }
    })
  );
}
```

**`openProjectVfs`:**
1. Fetch project metadata to get the name
2. Check if a workspace folder with `authority === projectId` is already open; skip adding if so
3. `updateWorkspaceFolders` to add the VFS root
4. If `filePath` is given, open that file in the editor: `vscode.window.showTextDocument(vscode.Uri.from({ scheme: "formatex", authority: projectId, path: "/" + filePath }))`
5. Show info notification: `"Opened 'My Thesis' in VS Code. Changes sync to FormaTeX automatically."`

**`openProjectLocally`:**
1. Fetch project metadata
2. Call `api.exportProject` to get the ZIP bytes
3. Determine output directory: `settings.localWorkspaceDir || os.tmpdir()`
4. Extract the ZIP to `<dir>/<project-name>-<projectId>/` (use a simple ZIP extraction library or `vscode.workspace.fs`)
5. Open the extracted folder: `vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(extractedPath))`

---

## 12. `commands/cloud.ts` (NEW)

All new cloud-related commands extracted into one file.

### Commands

**`formatex.openProject`** (from tree view context menu or command palette)
- Gets selected `ProjectNode` or prompts user to pick a project with `showQuickPick`
- Calls `openProjectVfs` or `openProjectLocally` depending on `settings.openMode`

**`formatex.openProjectLocally`** (explicit "download" option)
- Same as above but always uses `openProjectLocally` regardless of setting

**`formatex.compileCloudProject`** (compile the currently-open VFS workspace)
- Checks if any open workspace folder has scheme `formatex`
- Extracts `projectId` from the folder URI authority
- Fetches file list, gets `mainFile` from project metadata
- Constructs a `CompileRequest` by reading all project files via VFS provider cache
- Calls existing `runSyncCompile` / `runAsyncCompile` logic

**`formatex.openProjectInBrowser`**
- Opens `https://formatex.io/dashboard/editor?project=<projectId>` in the system browser using `vscode.env.openExternal`

**`formatex.openFile`** (from file node click in tree)
- `vscode.window.showTextDocument(uri)` for the `formatex://` URI

**`formatex.renameFile`**
- `showInputBox` pre-filled with current filename
- Calls `api.renameFile`, refreshes tree

**`formatex.deleteFile`**
- `showWarningMessage` with confirmation
- Calls `api.deleteFile`, refreshes tree, fires VFS delete event

**`formatex.copyProjectId`**
- `vscode.env.clipboard.writeText(projectId)`
- Shows `"Project ID copied to clipboard."` notification

**`formatex.refreshProjectFiles`**
- Clears the tree view cache for the selected project, calls `treeProvider.refresh()`

---

## 13. `package.json` contributions (full diff)

### New `viewsContainers`

```json
"viewsContainers": {
  "activitybar": [
    {
      "id": "formatex",
      "title": "FormaTeX",
      "icon": "media/formatex-activity.svg"
    }
  ]
}
```

### New `views`

```json
"views": {
  "formatex": [
    {
      "id": "formatexProjects",
      "name": "Projects",
      "when": "config.formatex.showProjectsPanel"
    }
  ]
}
```

### New commands

```json
{ "command": "formatex.openProject",         "title": "FormaTeX: Open Project",               "category": "FormaTeX" },
{ "command": "formatex.openProjectLocally",  "title": "FormaTeX: Download Project Locally",    "category": "FormaTeX" },
{ "command": "formatex.compileCloudProject", "title": "FormaTeX: Compile Cloud Project",       "category": "FormaTeX" },
{ "command": "formatex.openProjectInBrowser","title": "FormaTeX: Open in Browser",             "category": "FormaTeX", "icon": "$(link-external)" },
{ "command": "formatex.openFile",            "title": "Open",                                  "category": "FormaTeX" },
{ "command": "formatex.renameFile",          "title": "Rename",                                "category": "FormaTeX" },
{ "command": "formatex.deleteFile",          "title": "Delete",                                "category": "FormaTeX" },
{ "command": "formatex.copyProjectId",       "title": "Copy Project ID",                       "category": "FormaTeX" },
{ "command": "formatex.refreshProjects",     "title": "Refresh",                               "category": "FormaTeX", "icon": "$(refresh)" },
{ "command": "formatex.refreshProjectFiles", "title": "Refresh Files",                         "category": "FormaTeX" }
```

### New menus

```json
"menus": {
  "view/title": [
    {
      "command": "formatex.refreshProjects",
      "when": "view == formatexProjects",
      "group": "navigation"
    }
  ],
  "view/item/context": [
    {
      "command": "formatex.openProject",
      "when": "view == formatexProjects && viewItem == formatexProject",
      "group": "1_open@1"
    },
    {
      "command": "formatex.openProjectLocally",
      "when": "view == formatexProjects && viewItem == formatexProject",
      "group": "1_open@2"
    },
    {
      "command": "formatex.compileCloudProject",
      "when": "view == formatexProjects && viewItem == formatexProject",
      "group": "2_compile@1"
    },
    {
      "command": "formatex.openProjectInBrowser",
      "when": "view == formatexProjects && viewItem == formatexProject",
      "group": "3_external@1"
    },
    {
      "command": "formatex.refreshProjectFiles",
      "when": "view == formatexProjects && viewItem == formatexProject",
      "group": "4_manage@1"
    },
    {
      "command": "formatex.copyProjectId",
      "when": "view == formatexProjects && viewItem == formatexProject",
      "group": "4_manage@2"
    },
    {
      "command": "formatex.openFile",
      "when": "view == formatexProjects && viewItem == formatexFile",
      "group": "1_open@1"
    },
    {
      "command": "formatex.renameFile",
      "when": "view == formatexProjects && viewItem == formatexFile",
      "group": "2_manage@1"
    },
    {
      "command": "formatex.deleteFile",
      "when": "view == formatexProjects && viewItem == formatexFile",
      "group": "2_manage@2"
    }
  ]
}
```

### URI handler scheme

```json
"uriHandlers": [
  {
    "scheme": "vscode",
    "authority": "formatex-io.formatex"
  }
]
```

Actually this is registered in code, not `package.json`. But add `"handleActivationEvents"` so the extension activates on URI:

```json
"activationEvents": [
  "onUri",
  "onView:formatexProjects",
  "onFileSystem:formatex",
  "onLanguage:latex",
  "onCommand:formatex.compileCurrent",
  "onCommand:formatex.compileProject"
]
```

---

## 14. Updated `extension.ts`

The `activate` function needs these additions:

```typescript
import { FormatexFileSystemProvider } from "./vfs-provider";
import { FormatexProjectsTreeProvider } from "./projects-tree";
import { FormatexStatusBar } from "./status-bar";
import { registerUriHandler } from "./uri-handler";
import { registerCloudCommands } from "./commands/cloud";

export function activate(context: vscode.ExtensionContext): void {
  // --- existing setup (outputChannel, diagnostics) ---

  const settings = getSettings();
  const client = new FormatexApiClient(settings);

  // VFS provider
  const vfsProvider = new FormatexFileSystemProvider(context, client);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("formatex", vfsProvider, {
      isCaseSensitive: true,
      isReadonly: false
    })
  );

  // Tree view
  const treeProvider = new FormatexProjectsTreeProvider(context, client);
  const treeView = vscode.window.createTreeView("formatexProjects", {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  // Status bar
  const statusBar = new FormatexStatusBar(context);
  context.subscriptions.push(statusBar);

  // URI handler
  registerUriHandler(context, client, vfsProvider, treeProvider);

  // Cloud commands
  registerCloudCommands(context, client, vfsProvider, treeProvider, statusBar);

  // --- existing command registrations (compile, syntax check, etc.) ---
  // Pass statusBar to compile commands so they can call setCompiling() / setReady()
}
```

---

## 15. Activity Bar Icon

Create `media/formatex-activity.svg` — a simple monochrome SVG icon (VS Code renders it in the activity bar as a silhouette). It should match the FormaTeX brand mark. Use `currentColor` for the fill so VS Code can theme it.

---

## 16. Caching strategy

| Cache | Where | TTL | Invalidated by |
|-------|-------|-----|----------------|
| Project list | `ProjectsTreeProvider` memory | Session | `refresh()` command, `setApiKey` |
| File list per project | `ProjectsTreeProvider` memory | Session | `refreshProjectFiles`, VFS write |
| File content | `VfsProvider` memory | Session | `writeFile`, `deleteFile`, `renameFile` |
| User info | `auth.ts` module-level variable | Session | `clearApiKey` |

No disk caching. Everything is re-fetched on VS Code restart.

---

## 17. Error handling

- All API calls in tree provider: catch errors, show `vscode.window.showErrorMessage`, return empty arrays (don't crash the tree)
- VFS provider: throw `vscode.FileSystemError.FileNotFound()`, `FileSystemError.NoPermissions()`, etc. — the standard VFS error types VS Code understands
- URI handler: silently log to output channel on unknown URI paths; show `showErrorMessage` for actionable failures (missing API key, project not found)
- 401 anywhere: prompt to set API key, clear cached user info

---

## 18. What the web app needs to provide

(For the frontend team to implement separately — not part of this extension spec.)

1. **"Open in VS Code" button** in the project actions menu, generating:
   ```
   vscode://formatex-io.formatex/open?projectId=<id>
   ```

2. **Post-compile nudge**: after the first successful compile in the web editor, show a dismissible tip strip:
   > "Use VS Code? Open this project in VS Code with one click."
   > [Open in VS Code] [Dismiss]

3. **VS Code extension promotion** in the dashboard (sidebar or settings page) — a card linking to the marketplace.

---

## 19. Dependencies to add

```json
"dependencies": {
  "jszip": "^3.10.1"
}
```

`jszip` is needed for extracting the ZIP in `openProjectLocally`. It works in both Node.js and browser contexts and has no native bindings.

---

## 20. Implementation order (suggested)

1. Backend ships the new API endpoints
2. Add new types + API client methods (`types.ts`, `api.ts`)
3. Implement `auth.ts` (extraction + `getCachedUser`)
4. Implement `status-bar.ts`
5. Implement `vfs-provider.ts` (read-only first — `stat`, `readDirectory`, `readFile`)
6. Implement `projects-tree.ts`
7. Wire up tree + VFS in `extension.ts`, test listing + opening files
8. Add write support to `vfs-provider.ts` (`writeFile`, `delete`, `rename`)
9. Implement `uri-handler.ts`
10. Implement `commands/cloud.ts`
11. Add `openProjectLocally` (ZIP download + extraction)
12. Update `package.json` with all new contributions
13. Create activity bar icon SVG
14. Bump version to `0.2.0`, update CHANGELOG, publish to marketplace
