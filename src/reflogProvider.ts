import { getCurrentBranch, getReflogForBranch } from './git'
import { type ReflogEntry } from './models'

export class ReflogProvider {
  private entries: ReflogEntry[] = []
  private branch = ''
  private repoPath = ''

  async refresh(repoPath: string): Promise<void> {
    this.repoPath = repoPath
    this.branch = await getCurrentBranch(repoPath)
    this.entries = await getReflogForBranch(repoPath, this.branch)
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
