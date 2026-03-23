import * as vscode from 'vscode'
import { type ReflogEntry } from './models'

interface WebviewMessage {
  type: 'setLeft' | 'setRight'
  index: number
}

interface WebviewStateMessage {
  type: 'state'
  entries: ReflogEntry[]
  leftIndex?: number
  rightIndex?: number
}

export class ReflogWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView
  private entries: ReflogEntry[] = []
  private leftIndex?: number
  private rightIndex?: number

  constructor(
    private readonly onSetLeft: (index: number) => void,
    private readonly onSetRight: (index: number) => void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
    }
    webviewView.webview.html = this.getHtml(webviewView.webview)
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === 'setLeft') {
        this.onSetLeft(message.index)
        return
      }

      if (message.type === 'setRight') {
        this.onSetRight(message.index)
      }
    })
    this.pushState()
  }

  setState(entries: ReflogEntry[], leftIndex?: number, rightIndex?: number): void {
    this.entries = entries
    this.leftIndex = leftIndex
    this.rightIndex = rightIndex
    this.pushState()
  }

  private pushState(): void {
    if (!this.view) {
      return
    }

    const payload: WebviewStateMessage = {
      type: 'state',
      entries: this.entries,
      leftIndex: this.leftIndex,
      rightIndex: this.rightIndex,
    }
    void this.view.webview.postMessage(payload)
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now())
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 2px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    td {
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
      padding: 2px 2px;
      vertical-align: middle;
    }
    .col-left, .col-right {
      width: 20px;
      text-align: center;
    }
    input[type="radio"] {
      margin: 0;
      transform: scale(0.9);
    }
    .entry-line {
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .sha {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-descriptionForeground);
      flex: 0 0 auto;
    }
    .subject {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1 1 auto;
    }
    .time {
      flex: 0 0 auto;
      margin-left: 8px;
      color: var(--vscode-descriptionForeground);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 4px 2px;
    }
  </style>
</head>
<body>
  <table class="table" aria-label="Reflog entries">
    <tbody id="rows"></tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const rows = document.getElementById('rows');

    function renderState(state) {
      const { entries, leftIndex, rightIndex } = state;
      if (!entries.length) {
        rows.innerHTML = '<tr><td colspan="3" class="empty">No reflog entries found.</td></tr>';
        return;
      }

      rows.innerHTML = entries.map((entry) => {
        const leftChecked = leftIndex === entry.index ? 'checked' : '';
        const rightChecked = rightIndex === entry.index ? 'checked' : '';
        const safeSubject = escapeHtml(entry.subject);
        const safeTime = escapeHtml(entry.relTime);
        const shortSha = entry.sha.slice(0, 8);
        return '<tr>' +
          '<td class="col-left"><input type="radio" name="left" data-index="' + entry.index + '" ' + leftChecked + ' aria-label="Set left @{'+ entry.index +'}"></td>' +
          '<td class="col-right"><input type="radio" name="right" data-index="' + entry.index + '" ' + rightChecked + ' aria-label="Set right @{'+ entry.index +'}"></td>' +
          '<td>' +
            '<div class="entry-line"><span class="sha">[' + shortSha + ']</span><span class="subject">' + safeSubject + '</span><span class="time">' + safeTime + '</span></div>' +
          '</td>' +
        '</tr>';
      }).join('');

      for (const input of rows.querySelectorAll('input[name="left"]')) {
        input.addEventListener('change', (event) => {
          const target = event.target;
          if (target && target.checked) {
            vscode.postMessage({ type: 'setLeft', index: Number(target.dataset.index) });
          }
        });
      }

      for (const input of rows.querySelectorAll('input[name="right"]')) {
        input.addEventListener('change', (event) => {
          const target = event.target;
          if (target && target.checked) {
            vscode.postMessage({ type: 'setRight', index: Number(target.dataset.index) });
          }
        });
      }
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'state') {
        renderState(event.data);
      }
    });
  </script>
</body>
</html>`
  }
}
