import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { type ReflogEntry } from './models'

const execFileAsync = promisify(execFile)

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

export function repoFromWorkspaceFolder(folderFsPath: string): string {
  return path.resolve(folderFsPath)
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return runGit(cwd, ['branch', '--show-current'])
}

export async function getReflogForBranch(cwd: string, branch: string): Promise<ReflogEntry[]> {
  const format = '%H%x1f%gs%x1f%cr%x1f%cd'
  const output = await runGit(cwd, [
    'reflog',
    'show',
    `refs/heads/${branch}`,
    '--date=iso-strict',
    `--format=${format}`,
  ])

  if (!output) {
    return []
  }

  const lines = output.split('\n').filter(Boolean)
  return lines.map((line, index) => {
    const [sha, subject, relTime, isoDate] = line.split('\x1f')
    return {
      selector: `${branch}@{${index}}`,
      sha,
      subject,
      relTime,
      isoDate,
      index,
    }
  })
}

export async function listChangedFiles(cwd: string, leftSha: string, rightSha: string): Promise<string[]> {
  const output = await runGit(cwd, ['diff', '--name-only', `${leftSha}..${rightSha}`])
  if (!output) {
    return []
  }

  return output.split('\n').filter(Boolean)
}

export async function listChangedFilesAgainstWorkingTree(
  cwd: string,
  leftSha: string,
): Promise<string[]> {
  const output = await runGit(cwd, ['diff', '--name-only', leftSha])
  if (!output) {
    return []
  }

  return output.split('\n').filter(Boolean)
}

export async function showFileAtSha(cwd: string, sha: string, filePath: string): Promise<string> {
  try {
    return await runGit(cwd, ['show', `${sha}:${filePath}`])
  } catch {
    return ''
  }
}
