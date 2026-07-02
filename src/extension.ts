import * as vscode from 'vscode';
import { NpmProvider } from './providers/npmProvider';
import { NugetProvider } from './providers/nugetProvider';
import { DependencyTreeProvider } from './tree/dependencyTree';
import { OsvService } from './services/osvService';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const osv = new OsvService();
  const providers = [new NpmProvider(osv), new NugetProvider(osv)];
  const tree = new DependencyTreeProvider(providers, osv);

  context.subscriptions.push(
    vscode.window.createTreeView('dependencyExplorer.tree', {
      treeDataProvider: tree,
      showCollapseAll: true,
    })
  );
  registerCommands(context, tree);

  // Refresh when manifests or lock/assets files change (e.g. after npm install / dotnet restore).
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{package.json,package-lock.json,*.csproj,*.fsproj,*.vbproj,project.assets.json,Directory.Packages.props}'
  );
  let debounce: NodeJS.Timeout | undefined;
  const scheduleRefresh = (uri: vscode.Uri) => {
    if (uri.fsPath.includes('node_modules')) {
      return;
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => tree.refresh(), 1500);
  };
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);

  tree.refresh();
}

export function deactivate(): void {}
