import * as vscode from 'vscode'

export class ReflogContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>()
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.onDidChangeEmitter.event

  setContent(uri: vscode.Uri, content: string): void {
    this.cache.set(uri.toString(), content)
    this.onDidChangeEmitter.fire(uri)
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.cache.get(uri.toString()) ?? ''
  }
}
