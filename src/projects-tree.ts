import * as vscode from "vscode";
import { FormatexApiClient, FormatexApiError } from "./api";
import { getCachedUser, getApiKey } from "./auth";
import { Project, ProjectFile, UserInfo } from "./types";

export interface HeaderNode {
  kind: "header";
  label: string;
}

export interface ProjectNode {
  kind: "project";
  project: Project;
}

export interface FolderNode {
  kind: "folder";
  projectId: string;
  folderPath: string;
  label: string;
}

export interface FileNode {
  kind: "file";
  projectId: string;
  file: ProjectFile;
}

export type TreeNode = HeaderNode | ProjectNode | FolderNode | FileNode;

type ProjectChildrenCache = {
  files: ProjectFile[];
  fetchedAt: number;
};

function isProjectNode(node: TreeNode): node is ProjectNode {
  return node.kind === "project";
}

function isFolderNode(node: TreeNode): node is FolderNode {
  return node.kind === "folder";
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

function parentPrefix(folderPath: string): string {
  return folderPath.length > 0 && folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
}

function buildHeaderLabel(user: UserInfo | null): string {
  if (!user) {
    return "FormaTeX Projects";
  }

  return `${user.name} (${user.email}) - ${user.plan}`;
}

export class FormatexProjectsTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private projectsCache: Project[] | null = null;
  private readonly projectFilesCache = new Map<string, ProjectChildrenCache>();
  private readonly userCache = new Map<string, UserInfo | null>();
  private loadError: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: FormatexApiClient
  ) {}

  public refresh(projectId?: string): void {
    if (projectId) {
      this.projectFilesCache.delete(projectId);
    } else {
      this.projectsCache = null;
      this.projectFilesCache.clear();
      this.userCache.clear();
      this.loadError = null;
    }

    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "header") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("account");
      item.contextValue = "formatexHeader";
      item.description = "Connected account";
      return item;
    }

    if (isProjectNode(element)) {
      const item = new vscode.TreeItem(element.project.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder-library");
      item.contextValue = "formatexProject";
      item.description = `${element.project.fileCount} files`;
      item.tooltip = `${element.project.name}\nMain file: ${element.project.mainFile}`;
      item.command = {
        command: "formatex.openProject",
        title: "Open FormaTeX Project",
        arguments: [element]
      };
      return item;
    }

    if (isFolderNode(element)) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "formatexFolder";
      item.tooltip = element.folderPath;
      return item;
    }

    const item = new vscode.TreeItem(basename(element.file.path), vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("file");
    item.contextValue = "formatexFile";
    item.description = element.file.path.includes("/") ? element.file.path.slice(0, element.file.path.lastIndexOf("/")) : undefined;
    item.tooltip = `${element.file.path}\n${element.file.mimeType}`;
    item.command = {
      command: "formatex.openFile",
      title: "Open FormaTeX File",
      arguments: [element]
    };
    return item;
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      const user = await this.getUser();
      const projects = await this.getProjects();
      const headerLabel = this.loadError ?? buildHeaderLabel(user);

      return [
        { kind: "header", label: headerLabel },
        ...projects.map((project): ProjectNode => ({ kind: "project", project }))
      ];
    }

    if (element.kind === "header") {
      return [];
    }

    if (isProjectNode(element)) {
      const files = await this.getProjectFiles(element.project.id);
      return this.buildChildren(element.project.id, files, "");
    }

    if (isFolderNode(element)) {
      const files = await this.getProjectFiles(element.projectId);
      return this.buildChildren(element.projectId, files, parentPrefix(element.folderPath));
    }

    return [];
  }

  private async getUser(): Promise<UserInfo | null> {
    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      return null;
    }

    if (this.userCache.has(apiKey)) {
      return this.userCache.get(apiKey) ?? null;
    }

    const user = await getCachedUser(this.context, this.client);
    this.userCache.set(apiKey, user);
    return user;
  }

  private async getProjects(): Promise<Project[]> {
    if (this.projectsCache) {
      return this.projectsCache;
    }

    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      return [];
    }

    try {
      const response = await this.client.listProjects(apiKey);
      this.loadError = null;
      this.projectsCache = response.data.projects;
      return this.projectsCache;
    } catch (error) {
      if (error instanceof FormatexApiError && error.status === 404) {
        this.loadError = "Cloud projects API not available on this server";
        return [];
      }

      this.loadError = "Failed to load cloud projects";
      return [];
    }
  }

  private async getProjectFiles(projectId: string): Promise<ProjectFile[]> {
    const cached = this.projectFilesCache.get(projectId);
    if (cached) {
      return cached.files;
    }

    const apiKey = await getApiKey(this.context);
    if (!apiKey) {
      return [];
    }

    try {
      const response = await this.client.listFiles(projectId, apiKey);
      this.projectFilesCache.set(projectId, {
        files: response.data.files,
        fetchedAt: Date.now()
      });
      return response.data.files;
    } catch (error) {
      if (error instanceof FormatexApiError && error.status === 404) {
        return [];
      }

      return [];
    }
  }

  private buildChildren(projectId: string, files: ProjectFile[], prefix: string): TreeNode[] {
    const folderNames = new Set<string>();
    const fileNodes: FileNode[] = [];

    for (const file of files) {
      if (!file.path.startsWith(prefix)) {
        continue;
      }

      const relativePath = file.path.slice(prefix.length);
      if (!relativePath) {
        continue;
      }

      const separatorIndex = relativePath.indexOf("/");
      if (separatorIndex === -1) {
        fileNodes.push({ kind: "file", projectId, file });
        continue;
      }

      folderNames.add(relativePath.slice(0, separatorIndex));
    }

    const folders: FolderNode[] = Array.from(folderNames)
      .sort((left, right) => left.localeCompare(right))
      .map((label) => ({ kind: "folder", projectId, folderPath: `${prefix}${label}`, label }));

    const filesSorted = fileNodes.sort((left, right) => basename(left.file.path).localeCompare(basename(right.file.path)));
    return [...folders, ...filesSorted];
  }
}
