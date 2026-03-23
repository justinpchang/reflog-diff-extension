import * as vscode from 'vscode'
import { getCurrentBranch, getReflogForBranch } from './git'
import { type ReflogEntry } from './models'

export class ReflogItem extends vscode.TreeItem {
  constructor(public readonly entry: ReflogEntry) {
    super(`${entry.sha.slice(0, 8)}  ${entry.subject}`, vscode.TreeItemCollapsibleState.None)
    const shortSelector = `@{${entry.index}}`
    this.description = `${shortSelector}  ${entry.relTime}`
    this.tooltip = `${shortSelector}\n${entry.sha}\n${entry.isoDate}\n${entry.subject}`
    this.contextValue = 'reflogEntry'
  }
}

export class ReflogProvider implements vscode.TreeDataProvider<ReflogItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event

  private entries: ReflogEntry[] = []
  private branch = ''
  private repoPath = ''

  async refresh(repoPath: string): Promise<void> {
    this.repoPath = repoPath
    this.branch = await getCurrentBranch(repoPath)
    this.entries = await getReflogForBranch(repoPath, this.branch)
    this.onDidChangeTreeDataEmitter.fire()
  }

  getTreeItem(element: ReflogItem): vscode.TreeItem {
    return element
  }

  getChildren(): Thenable<ReflogItem[]> {
    return Promise.resolve(this.entries.map((entry) => new ReflogItem(entry)))
  }

  getEntries(): ReflogEntry[] {
    return this.entries
  }

  getBranch(): string {
    return this.branch
  }

  getRepoPath(): string {
    return this.repoPath
  }
}
