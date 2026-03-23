import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  listChangedFiles,
  listChangedFilesAgainstWorkingTree,
  repoFromWorkspaceFolder,
  showFileAtSha,
} from './git'
import { type ReflogEntry } from './models'
import { ReflogContentProvider } from './contentProvider'
import { ReflogProvider } from './reflogProvider'
import { ReflogWebviewProvider } from './reflogWebview'

interface CompareSelection {
  left?: ReflogEntry
  right?: ReflogEntry
  rightIsCurrent: boolean
}

type AlertLevel = 'info' | 'warn' | 'error'
const REFRESH_INTERVAL_SETTING = 'reflogDiff.refreshIntervalMs'
const DEFAULT_REFRESH_INTERVAL_MS = 1000

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

function getRefreshIntervalMs(): number {
  const configured = vscode.workspace
    .getConfiguration('reflogDiff')
    .get<number>('refreshIntervalMs', DEFAULT_REFRESH_INTERVAL_MS)
  if (!Number.isFinite(configured)) {
    return DEFAULT_REFRESH_INTERVAL_MS
  }

  return Math.max(250, Math.floor(configured))
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new ReflogProvider()
  const contentProvider = new ReflogContentProvider()
  const selection: CompareSelection = { rightIsCurrent: true }
  let isRefreshing = false
  let refreshInterval: ReturnType<typeof setInterval> | undefined
  const webviewProvider = new ReflogWebviewProvider(
    (index) => {
      if (index < 0) {
        return
      }
      const entry = provider.getEntries().find((candidate) => candidate.index === index)
      if (!entry) {
        return
      }
      selection.left = entry
      webviewProvider.setState(
        provider.getEntries(),
        selection.left?.index,
        selection.rightIsCurrent,
        selection.right?.index,
      )
    },
    (index) => {
      if (index < 0) {
        selection.right = undefined
        selection.rightIsCurrent = true
        webviewProvider.setState(
          provider.getEntries(),
          selection.left?.index,
          selection.rightIsCurrent,
          undefined,
        )
        return
      }

      const entry = provider.getEntries().find((candidate) => candidate.index === index)
      if (!entry) {
        return
      }
      selection.right = entry
      selection.rightIsCurrent = false
      webviewProvider.setState(
        provider.getEntries(),
        selection.left?.index,
        selection.rightIsCurrent,
        selection.right?.index,
      )
    },
    (index) => {
      void vscode.commands.executeCommand('reflogDiff.compareWithPrevious', index)
    },
  )

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('reflog-diff', contentProvider),
  )
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('reflogDiff.view', webviewProvider))

  async function refresh(options?: { silentWhenNoWorkspace?: boolean }): Promise<void> {
    if (isRefreshing) {
      return
    }
    isRefreshing = true

    const root = getWorkspaceRoot()
    if (!root) {
      if (!options?.silentWhenNoWorkspace) {
        alert('Reflog Diff: open a workspace folder first.', 'warn')
      }
      isRefreshing = false
      return
    }

    try {
      await provider.refresh(root)
      const entries = provider.getEntries()
      const preservedLeft = selection.left
        ? entries.find((entry) => entry.index === selection.left?.index)
        : undefined
      const preservedRight = selection.right
        ? entries.find((entry) => entry.index === selection.right?.index)
        : undefined
      if (entries.length === 0) {
        selection.left = undefined
        selection.right = undefined
        selection.rightIsCurrent = true
      } else {
        selection.right = selection.rightIsCurrent ? undefined : preservedRight ?? entries[0]
        selection.left = preservedLeft ?? entries[1] ?? entries[0]
      }
      webviewProvider.setState(
        entries,
        selection.left?.index,
        selection.rightIsCurrent,
        selection.right?.index,
      )
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

  async function openDiffAgainstWorkingTree(left: ReflogEntry): Promise<void> {
    const repoPath = provider.getRepoPath() || getWorkspaceRoot()
    if (!repoPath) {
      alert('Reflog Diff: cannot resolve repository path.', 'warn')
      return
    }

    const files = await listChangedFilesAgainstWorkingTree(repoPath, left.sha)
    if (files.length === 0) {
      alert('No file differences between selected reflog entry and working tree.')
      return
    }

    const resources = await Promise.all(
      files.map(async (filePath): Promise<[vscode.Uri, vscode.Uri, vscode.Uri]> => {
        const leftContent = await showFileAtSha(repoPath, left.sha, filePath)
        const leftUri = buildSnapshotUri(repoPath, left.sha, filePath)
        contentProvider.setContent(leftUri, leftContent)

        const rightUri = vscode.Uri.file(path.join(repoPath, filePath))
        const labelUri = vscode.Uri.file(path.join(repoPath, filePath))
        return [labelUri, leftUri, rightUri]
      }),
    )

    const title = `Reflog compare @{${left.index}} ↔ current`
    await vscode.commands.executeCommand('vscode.changes', title, resources)
  }

  async function openSingleFileDiffAgainstWorkingTree(
    left: ReflogEntry,
    filePath: string,
  ): Promise<void> {
    const repoPath = provider.getRepoPath() || getWorkspaceRoot()
    if (!repoPath) {
      alert('Reflog Diff: cannot resolve repository path.', 'warn')
      return
    }

    const leftContent = await showFileAtSha(repoPath, left.sha, filePath)
    const leftUri = buildSnapshotUri(repoPath, left.sha, filePath)
    contentProvider.setContent(leftUri, leftContent)

    const rightUri = vscode.Uri.file(path.join(repoPath, filePath))
    const title = `${path.basename(filePath)} (@{${left.index}} ↔ current)`
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

  async function compareWorkingTreeWithLatest(): Promise<void> {
    const latest = provider.getEntries()[0]
    if (!latest) {
      alert('No reflog entry available to compare with working tree.')
      return
    }

    await openDiffAgainstWorkingTree(latest)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.refresh', async () => {
      await refresh()
    }),
  )

  const applyRefreshInterval = (): void => {
    if (refreshInterval) {
      clearInterval(refreshInterval)
    }

    refreshInterval = setInterval(() => {
      void refresh({ silentWhenNoWorkspace: true })
    }, getRefreshIntervalMs())
  }

  applyRefreshInterval()
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(REFRESH_INTERVAL_SETTING)) {
        applyRefreshInterval()
      }
    }),
  )
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (refreshInterval) {
        clearInterval(refreshInterval)
      }
    }),
  )

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
      webviewProvider.setState(
        provider.getEntries(),
        selection.left?.index,
        selection.rightIsCurrent,
        selection.right?.index,
      )
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
      selection.rightIsCurrent = false
      webviewProvider.setState(
        provider.getEntries(),
        selection.left?.index,
        selection.rightIsCurrent,
        selection.right?.index,
      )
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareTwo', async () => {
      if (!selection.left) {
        alert('Pick a left reflog entry first.', 'warn')
        return
      }

      if (selection.rightIsCurrent) {
        await openDiffAgainstWorkingTree(selection.left)
        return
      }

      if (!selection.right) {
        alert('Pick a right reflog entry first.', 'warn')
        return
      }

      await openDiffBetweenEntries(selection.left, selection.right)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareFile', async () => {
      if (!selection.left) {
        alert('Pick a left reflog entry first.', 'warn')
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

      if (selection.rightIsCurrent) {
        await openSingleFileDiffAgainstWorkingTree(selection.left, relativeFilePath)
        return
      }

      if (!selection.right) {
        alert('Pick a right reflog entry first.', 'warn')
        return
      }

      await openSingleFileDiff(selection.left, selection.right, relativeFilePath)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('reflogDiff.compareWithPrevious', async (index?: number) => {
      if (index === -1) {
        await compareWorkingTreeWithLatest()
        return
      }

      if (typeof index !== 'number' && selection.rightIsCurrent) {
        await compareWorkingTreeWithLatest()
        return
      }

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
