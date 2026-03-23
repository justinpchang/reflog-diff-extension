import * as path from 'node:path'
import * as vscode from 'vscode'
import { listChangedFiles, repoFromWorkspaceFolder, showFileAtSha } from './git'
import { type ReflogEntry } from './models'
import { ReflogContentProvider } from './contentProvider'
import { ReflogProvider } from './reflogProvider'
import { ReflogWebviewProvider } from './reflogWebview'

interface CompareSelection {
  left?: ReflogEntry
  right?: ReflogEntry
}

type AlertLevel = 'info' | 'warn' | 'error'

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

function toRepoRelativeFilePath(repoPath: string, fileFsPath: string): string | undefined {
  const relativePath = path.relative(repoPath, fileFsPath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined
  }

  return relativePath.split(path.sep).join('/')
}

function alert(message: string, level: AlertLevel = 'info'): void {
  const icon = level === 'error' ? '$(error)' : level === 'warn' ? '$(warning)' : '$(info)'
  void vscode.window.setStatusBarMessage(`${icon} ${message}`, 3000)
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new ReflogProvider()
  const contentProvider = new ReflogContentProvider()
  const selection: CompareSelection = {}
  let isRefreshing = false
  const webviewProvider = new ReflogWebviewProvider(
    (index) => {
      const entry = provider.getEntries().find((candidate) => candidate.index === index)
      if (!entry) {
        return
      }
      selection.left = entry
      webviewProvider.setState(provider.getEntries(), selection.left?.index, selection.right?.index)
    },
    (index) => {
      const entry = provider.getEntries().find((candidate) => candidate.index === index)
      if (!entry) {
        return
      }
      selection.right = entry
      webviewProvider.setState(provider.getEntries(), selection.left?.index, selection.right?.index)
    },
    (index) => {
      void vscode.commands.executeCommand('reflogDiff.compareWithPrevious', index)
    },
  )

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('reflog-diff', contentProvider),
  )
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('reflogDiff.view', webviewProvider))

  async function refresh(): Promise<void> {
    if (isRefreshing) {
      return
    }
    isRefreshing = true

    const root = getWorkspaceRoot()
    if (!root) {
      alert('Reflog Diff: open a workspace folder first.', 'warn')
      isRefreshing = false
      return
    }

    try {
      await provider.refresh(root)
      const entries = provider.getEntries()
      if (entries.length === 0) {
        selection.left = undefined
        selection.right = undefined
      } else {
        selection.right = entries[0]
        selection.left = entries[1] ?? entries[0]
      }
      webviewProvider.setState(entries, selection.left?.index, selection.right?.index)
    } catch (error) {
      alert(`Reflog Diff refresh failed: ${String(error)}`, 'error')
    } finally {
      isRefreshing = false
    }
  }

  async function openDiffBetweenEntries(left: ReflogEntry, right: ReflogEntry): Promise<void> {
    const repoPath = provider.getRepoPath() || getWorkspaceRoot()
    if (!repoPath) {
      alert('Reflog Diff: cannot resolve repository path.', 'warn')
      return
    }

    const files = await listChangedFiles(repoPath, left.sha, right.sha)
    if (files.length === 0) {
      alert('No file differences between selected reflog entries.')
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

  async function openSingleFileDiff(
    left: ReflogEntry,
    right: ReflogEntry,
    filePath: string,
  ): Promise<void> {
    const repoPath = provider.getRepoPath() || getWorkspaceRoot()
    if (!repoPath) {
      alert('Reflog Diff: cannot resolve repository path.', 'warn')
      return
    }

    const [leftContent, rightContent] = await Promise.all([
      showFileAtSha(repoPath, left.sha, filePath),
      showFileAtSha(repoPath, right.sha, filePath),
    ])

    const leftUri = buildSnapshotUri(repoPath, left.sha, filePath)
    const rightUri = buildSnapshotUri(repoPath, right.sha, filePath)
    contentProvider.setContent(leftUri, leftContent)
    contentProvider.setContent(rightUri, rightContent)

    const title = `${path.basename(filePath)} (@{${left.index}} ↔ @{${right.index}})`
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: false,
    })
  }

  async function compareCurrentWithPrevious(current: ReflogEntry): Promise<void> {
    const previous = provider.getEntries()[current.index + 1]
    if (!previous) {
      alert('No previous reflog entry available.')
      return
    }

    await openDiffBetweenEntries(previous, current)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.refresh', async () => {
      await refresh()
    }),
  )
  const refreshInterval = setInterval(() => {
    void refresh()
  }, 1000)
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(refreshInterval)))

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.pickLeft', async () => {
      const picked = await vscode.window.showQuickPick(
        provider.getEntries().map((entry) => ({
          label: `${entry.sha.slice(0, 8)} ${entry.subject}`,
          description: `@{${entry.index}}  ${entry.relTime}`,
          entry,
        })),
        { title: 'Set left side' },
      )
      if (!picked) {
        return
      }

      selection.left = picked.entry
      webviewProvider.setState(provider.getEntries(), selection.left?.index, selection.right?.index)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.pickRight', async () => {
      const picked = await vscode.window.showQuickPick(
        provider.getEntries().map((entry) => ({
          label: `${entry.sha.slice(0, 8)} ${entry.subject}`,
          description: `@{${entry.index}}  ${entry.relTime}`,
          entry,
        })),
        { title: 'Set right side' },
      )
      if (!picked) {
        return
      }

      selection.right = picked.entry
      webviewProvider.setState(provider.getEntries(), selection.left?.index, selection.right?.index)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareTwo', async () => {
      if (!selection.left || !selection.right) {
        alert('Pick both left and right reflog entries first.', 'warn')
        return
      }

      await openDiffBetweenEntries(selection.left, selection.right)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareFile', async () => {
      if (!selection.left || !selection.right) {
        alert('Pick both left and right reflog entries first.', 'warn')
        return
      }

      const editor = vscode.window.activeTextEditor
      const editorUri = editor?.document.uri
      if (!editorUri || editorUri.scheme !== 'file') {
        alert('Open a file in the editor to compare that file.', 'warn')
        return
      }

      const repoPath = provider.getRepoPath() || getWorkspaceRoot()
      if (!repoPath) {
        alert('Reflog Diff: cannot resolve repository path.', 'warn')
        return
      }

      const relativeFilePath = toRepoRelativeFilePath(repoPath, editorUri.fsPath)
      if (!relativeFilePath) {
        alert('The active file is outside the current repository workspace.', 'warn')
        return
      }

      await openSingleFileDiff(selection.left, selection.right, relativeFilePath)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareWithPrevious', async (index?: number) => {
      const entries = provider.getEntries()
      const current = typeof index === 'number' ? entries.find((entry) => entry.index === index) : selection.right
      if (!current) {
        alert('Choose a right-side reflog entry first.', 'warn')
        return
      }

      await compareCurrentWithPrevious(current)
    }),
  )

  await refresh()
}

export function deactivate(): void {
  // No-op.
}
