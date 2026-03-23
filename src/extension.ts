import * as path from 'node:path'
import * as vscode from 'vscode'
import { listChangedFiles, repoFromWorkspaceFolder, showFileAtSha } from './git'
import { type ReflogEntry } from './models'
import { ReflogContentProvider } from './contentProvider'
import { ReflogItem, ReflogProvider } from './reflogProvider'

interface CompareSelection {
  left?: ReflogEntry
  right?: ReflogEntry
}

function fileLabel(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

function buildSnapshotUri(repoPath: string, sha: string, filePath: string): vscode.Uri {
  const fileName = fileLabel(filePath)
  const fullLabel = `${fileName} @ ${sha.slice(0, 8)}`
  return vscode.Uri.parse(
    `reflog-diff:${encodeURIComponent(repoPath)}/${encodeURIComponent(filePath)}?sha=${encodeURIComponent(
      sha,
    )}&label=${encodeURIComponent(fullLabel)}`,
  )
}

function getWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    return undefined
  }

  return repoFromWorkspaceFolder(folder.uri.fsPath)
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new ReflogProvider()
  const contentProvider = new ReflogContentProvider()
  const selection: CompareSelection = {}

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('reflog-diff', contentProvider),
  )
  context.subscriptions.push(vscode.window.registerTreeDataProvider('reflogDiff.view', provider))

  async function refresh(): Promise<void> {
    const root = getWorkspaceRoot()
    if (!root) {
      void vscode.window.showWarningMessage('Reflog Diff: open a workspace folder first.')
      return
    }

    try {
      await provider.refresh(root)
    } catch (error) {
      void vscode.window.showErrorMessage(`Reflog Diff refresh failed: ${String(error)}`)
    }
  }

  async function openDiffBetweenEntries(left: ReflogEntry, right: ReflogEntry): Promise<void> {
    const repoPath = provider.getRepoPath() || getWorkspaceRoot()
    if (!repoPath) {
      void vscode.window.showWarningMessage('Reflog Diff: cannot resolve repository path.')
      return
    }

    const files = await listChangedFiles(repoPath, left.sha, right.sha)
    if (files.length === 0) {
      void vscode.window.showInformationMessage('No file differences between selected reflog entries.')
      return
    }

    const resources = await Promise.all(
      files.map(async (filePath): Promise<[vscode.Uri, vscode.Uri, vscode.Uri]> => {
        const [leftContent, rightContent] = await Promise.all([
          showFileAtSha(repoPath, left.sha, filePath),
          showFileAtSha(repoPath, right.sha, filePath),
        ])

        const leftUri = buildSnapshotUri(repoPath, left.sha, filePath)
        const rightUri = buildSnapshotUri(repoPath, right.sha, filePath)
        contentProvider.setContent(leftUri, leftContent)
        contentProvider.setContent(rightUri, rightContent)

        const labelUri = vscode.Uri.file(path.join(repoPath, filePath))
        return [labelUri, leftUri, rightUri]
      }),
    )

    const title = `Reflog compare @{${left.index}} ↔ @{${right.index}}`
    await vscode.commands.executeCommand('vscode.changes', title, resources)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.refresh', async () => {
      await refresh()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.pickLeft', (item: ReflogItem) => {
      selection.left = item.entry
      void vscode.window.showInformationMessage(`Left selected: ${item.entry.selector}`)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.pickRight', (item: ReflogItem) => {
      selection.right = item.entry
      void vscode.window.showInformationMessage(`Right selected: ${item.entry.selector}`)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareTwo', async () => {
      if (!selection.left || !selection.right) {
        void vscode.window.showWarningMessage('Pick both left and right reflog entries first.')
        return
      }

      await openDiffBetweenEntries(selection.left, selection.right)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareWithPrevious', async (item: ReflogItem) => {
      const entries = provider.getEntries()
      const current = item.entry
      const previous = entries[current.index + 1]

      if (!previous) {
        void vscode.window.showInformationMessage('No previous reflog entry available.')
        return
      }

      await openDiffBetweenEntries(previous, current)
    }),
  )

  await refresh()
}

export function deactivate(): void {
  // No-op.
}
