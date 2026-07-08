import * as vscode from 'vscode';
import { BumpPreview, ChangeStatus, DepChange } from '../services/previewService';
import { BumpRisk, riskLabel } from '../services/semverRisk';
import { Ecosystem } from '../types';

export interface BumpPreviewOptions {
  ecosystem: Ecosystem;
  name: string;
  currentVersion: string;
  targetVersion: string;
  isDirect: boolean;
  preview: BumpPreview;
  /** How many projects the change will apply to (for the informational note). */
  projectCount: number;
  /** Semver distance of the bump, for the risk badge. */
  risk?: BumpRisk;
  /** Deprecation message when the target version is deprecated, '' when deprecated without a message. */
  deprecatedMessage?: string;
}

/**
 * Show the transitive-dependency impact of a version bump in a webview and resolve to
 * true when the user confirms, false when they cancel or close the panel.
 */
export function confirmBump(opts: BumpPreviewOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'dependencyExplorer.preview',
      `Preview: ${opts.name} → ${opts.targetVersion}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true }
    );

    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
      panel.dispose();
    };

    panel.webview.html = renderHtml(panel.webview, opts);
    panel.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg?.command === 'apply') {
        finish(true);
      } else if (msg?.command === 'cancel') {
        finish(false);
      }
    });
    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
  });
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  changed: 'changed',
  added: 'added',
  removed: 'removed',
  unchanged: 'unchanged',
};

const STATUS_SYMBOL: Record<ChangeStatus, string> = {
  changed: '~',
  added: '+',
  removed: '−',
  unchanged: '=',
};

function renderHtml(webview: vscode.Webview, opts: BumpPreviewOptions): string {
  const nonce = makeNonce();
  const { changes } = opts.preview;
  const counts = countByStatus(changes);
  const impactful = changes.filter((c) => c.status !== 'unchanged');

  const summaryChips = (['changed', 'added', 'removed', 'unchanged'] as ChangeStatus[])
    .filter((s) => counts[s] > 0)
    .map((s) => `<span class="chip ${s}">${counts[s]} ${STATUS_LABEL[s]}</span>`)
    .join('');

  const rows =
    changes.length === 0
      ? `<tr><td colspan="3" class="muted">This version declares no dependencies.</td></tr>`
      : changes
          .map(
            (c) => `<tr class="row ${c.status}">
              <td class="dep"><span class="sym ${c.status}">${STATUS_SYMBOL[c.status]}</span>${escapeHtml(c.name)}${c.optional ? '<span class="tag">optional</span>' : ''}</td>
              <td class="ver">${escapeHtml(c.current ?? '—')}</td>
              <td class="ver">${escapeHtml(c.target ?? '—')}</td>
            </tr>`
          )
          .join('');

  const kind = opts.isDirect ? 'Update' : 'Override';
  const riskText = opts.risk ? riskLabel(opts.risk) : '';
  const riskBanner =
    opts.risk === 'major'
      ? `<p class="note warn">⚠️ This is a <b>major</b> version bump — it may include breaking changes. Check the changelog before applying.</p>`
      : riskText
        ? `<p class="note">Version change: <b>${escapeHtml(riskText)}</b>.</p>`
        : '';
  const deprecationBanner =
    opts.deprecatedMessage !== undefined
      ? `<p class="note warn">⛔ The target version <code>${escapeHtml(opts.targetVersion)}</code> is <b>deprecated</b>${opts.deprecatedMessage ? `: ${escapeHtml(opts.deprecatedMessage)}` : '.'}</p>`
      : '';
  const projectNote =
    opts.projectCount > 1
      ? `<p class="note">This package is used by <b>${opts.projectCount}</b> projects — you'll choose whether to apply to all of them after confirming.</p>`
      : '';
  const currentNote = opts.preview.currentUnavailable
    ? `<p class="note warn">Couldn't load the current version's dependencies, so everything below is shown relative to an empty set.</p>`
    : '';
  const frameworkNote = opts.preview.framework
    ? `<p class="note">Dependencies shown for target framework <code>${escapeHtml(opts.preview.framework)}</code>.</p>`
    : '';
  const impactSummary = impactful.length === 0
    ? `<p class="note ok">No transitive dependency requirements change between these versions.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 4px; }
  h1 { font-size: 1.25em; margin: 0 0 2px; }
  h1 .ver { font-family: var(--vscode-editor-font-family, monospace); }
  .arrow { opacity: .7; margin: 0 6px; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
  .chips { margin: 4px 0 14px; }
  .chip { display: inline-block; border-radius: 10px; padding: 1px 9px; margin-right: 6px; font-size: .82em; }
  .chip.changed { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
  .chip.added { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
  .chip.removed { background: var(--vscode-editorError-foreground); color: #fff; }
  .chip.unchanged { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: .85em; }
  td.ver { font-family: var(--vscode-editor-font-family, monospace); font-size: .9em; white-space: nowrap; }
  td.dep { width: 55%; }
  .sym { display: inline-block; width: 1.2em; font-weight: 700; }
  .sym.changed { color: var(--vscode-editorWarning-foreground); }
  .sym.added { color: var(--vscode-testing-iconPassed, #388a34); }
  .sym.removed { color: var(--vscode-editorError-foreground); }
  .sym.unchanged { color: var(--vscode-descriptionForeground); }
  tr.unchanged td { color: var(--vscode-descriptionForeground); }
  tr.removed .dep { text-decoration: line-through; }
  .tag { font-size: .72em; margin-left: 6px; padding: 0 5px; border-radius: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .note { color: var(--vscode-descriptionForeground); font-size: .88em; margin: 8px 0 0; }
  .note.warn { color: var(--vscode-editorWarning-foreground); }
  .note.ok { color: var(--vscode-testing-iconPassed, #388a34); }
  .muted { color: var(--vscode-descriptionForeground); }
  .actions { position: sticky; bottom: 0; background: var(--vscode-editor-background); padding: 14px 0 10px; margin-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
  button { font-family: inherit; font-size: .95em; padding: 6px 16px; margin-right: 10px; border: none; border-radius: 3px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <h1>${kind} ${escapeHtml(opts.name)}</h1>
  <p class="sub"><span class="ver">${escapeHtml(opts.currentVersion)}</span><span class="arrow">→</span><span class="ver">${escapeHtml(opts.targetVersion)}</span> · ${opts.ecosystem} · ${opts.isDirect ? 'direct dependency' : 'transitive override'}</p>
  ${riskBanner}
  ${deprecationBanner}

  <p class="sub">How this version's declared dependencies compare to your current version:</p>
  <div class="chips">${summaryChips || '<span class="muted">no dependencies</span>'}</div>
  ${impactSummary}

  <table>
    <thead><tr><th>Dependency</th><th>Current requires</th><th>New requires</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${frameworkNote}
  ${currentNote}
  ${projectNote}
  <p class="note">Note: these are the package's <i>declared</i> requirements. Exact resolved versions are finalized when you run ${opts.ecosystem === 'npm' ? 'npm install' : 'dotnet restore'}.</p>

  <div class="actions">
    <button class="primary" id="apply">Apply ${escapeHtml(opts.targetVersion)}</button>
    <button class="secondary" id="cancel">Cancel</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('apply').addEventListener('click', () => vscode.postMessage({ command: 'apply' }));
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  </script>
</body>
</html>`;
}

function countByStatus(changes: DepChange[]): Record<ChangeStatus, number> {
  const counts: Record<ChangeStatus, number> = { changed: 0, added: 0, removed: 0, unchanged: 0 };
  for (const c of changes) {
    counts[c.status]++;
  }
  return counts;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
