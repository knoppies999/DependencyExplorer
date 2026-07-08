import * as vscode from 'vscode';
import { Project } from '../types';
import { WhyResult } from '../services/whyService';

export interface WhyPanelOptions {
  project: Project;
  name: string;
  /** Resolved version of the node the user asked about. */
  version: string;
  isDirect: boolean;
  result: WhyResult;
}

/** Show every dependency chain that pulls a package into a project ("why is this here?"). */
export function showWhyPanel(opts: WhyPanelOptions): void {
  const panel = vscode.window.createWebviewPanel(
    'dependencyExplorer.why',
    `Why: ${opts.name}`,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {} // static content, no scripts
  );
  panel.webview.html = renderHtml(opts);
}

function renderHtml(opts: WhyPanelOptions): string {
  const { result } = opts;
  const count = result.paths.length;

  const directNote = opts.isDirect
    ? `<p class="note ok">✔ Declared directly in <b>${escapeHtml(opts.project.name)}</b>'s manifest${
        count > 1 ? ' — and also pulled in by the chains below.' : '.'
      }</p>`
    : '';

  const versionsNote =
    result.targetVersions.length > 1
      ? `<p class="note warn">This package resolves to <b>${result.targetVersions.length}</b> different versions in this project: ${result.targetVersions
          .map((v) => `<code>${escapeHtml(v)}</code>`)
          .join(', ')}.</p>`
      : '';

  const truncatedNote = result.truncated
    ? `<p class="note warn">Showing the first ${count} chains — more exist.</p>`
    : '';

  const rows =
    count === 0
      ? `<li class="muted">No chain from a direct dependency reaches this package — the lockfile may be out of date (run install/restore and refresh).</li>`
      : result.paths.map((p) => {
          const chain = p.steps
            .map((s, i) => {
              const last = i === p.steps.length - 1;
              const ver = s.version ? `<span class="v">${escapeHtml(s.version)}</span>` : '';
              return `<span class="pkg ${last ? 'target' : ''}">${escapeHtml(s.name)} ${ver}</span>`;
            })
            .join('<span class="sep">›</span>');
          const dev = p.isDev ? `<span class="tag">dev</span>` : '';
          return `<li>${chain}${dev}</li>`;
        }).join('\n');

  const summary =
    count === 0
      ? ''
      : `<p class="sub">${count === 1 ? '1 dependency chain leads' : `${count} dependency chains lead`} here from your direct dependencies (shortest first). To move this package, update the <b>first</b> link of a chain — or pin/override the package itself.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 4px; }
  h1 { font-size: 1.25em; margin: 0 0 2px; }
  h1 code, .v { font-family: var(--vscode-editor-font-family, monospace); }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
  ul { list-style: none; padding: 0; margin: 10px 0; }
  li { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); line-height: 1.9; }
  .pkg { white-space: nowrap; }
  .pkg .v { font-size: .85em; color: var(--vscode-descriptionForeground); margin-left: 2px; }
  .pkg.target { font-weight: 700; }
  .pkg.target .v { color: var(--vscode-foreground); }
  .sep { opacity: .55; margin: 0 8px; }
  .tag { font-size: .72em; margin-left: 8px; padding: 0 5px; border-radius: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); vertical-align: middle; }
  .note { color: var(--vscode-descriptionForeground); font-size: .88em; margin: 8px 0 0; }
  .note.warn { color: var(--vscode-editorWarning-foreground); }
  .note.ok { color: var(--vscode-testing-iconPassed, #388a34); }
  .muted { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>Why is <code>${escapeHtml(opts.name)}</code> here?</h1>
  <p class="sub"><code>${escapeHtml(opts.version)}</code> · ${escapeHtml(opts.project.name)} · ${opts.project.ecosystem}</p>
  ${directNote}
  ${versionsNote}
  ${summary}
  <ul>${rows}</ul>
  ${truncatedNote}
</body>
</html>`;
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
