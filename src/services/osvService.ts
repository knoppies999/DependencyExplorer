import * as vscode from 'vscode';
import { Ecosystem, PackageId, VulnInfo } from '../types';

interface OsvQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const BATCH_SIZE = 500;

export class OsvService {
  private cache = new Map<string, VulnInfo[]>();
  private warned = false;

  private key(ecosystem: Ecosystem, name: string, version: string): string {
    return `${ecosystem}:${name}@${version}`;
  }

  getVulns(ecosystem: Ecosystem, name: string, version: string): VulnInfo[] {
    return this.cache.get(this.key(ecosystem, name, version)) ?? [];
  }

  /**
   * Query OSV.dev for all packages not already cached.
   * Returns true when new results were fetched (callers should refresh the UI).
   */
  async query(packages: OsvQuery[]): Promise<boolean> {
    const pending = new Map<string, OsvQuery>();
    for (const pkg of packages) {
      const k = this.key(pkg.ecosystem, pkg.name, pkg.version);
      if (!this.cache.has(k) && !pending.has(k)) {
        pending.set(k, pkg);
      }
    }
    if (pending.size === 0) {
      return false;
    }

    const queries = [...pending.values()];
    try {
      for (let i = 0; i < queries.length; i += BATCH_SIZE) {
        const chunk = queries.slice(i, i + BATCH_SIZE);
        const res = await fetch(OSV_BATCH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            queries: chunk.map((q) => ({
              package: { name: q.name, ecosystem: q.ecosystem },
              version: q.version,
            })),
          }),
        });
        if (!res.ok) {
          throw new Error(`OSV API returned ${res.status}`);
        }
        const data = (await res.json()) as {
          results: { vulns?: { id: string }[] }[];
        };
        chunk.forEach((q, idx) => {
          const vulns = (data.results[idx]?.vulns ?? []).map((v) => ({ id: v.id }));
          this.cache.set(this.key(q.ecosystem, q.name, q.version), vulns);
        });
      }
      return true;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        vscode.window.showWarningMessage(
          `Dependency Explorer: vulnerability check via OSV.dev failed (${err instanceof Error ? err.message : err}). The tree still works, but packages won't be flagged.`
        );
      }
      return false;
    }
  }
}

export function packagesToQueries(ecosystem: Ecosystem, packages: PackageId[]): OsvQuery[] {
  return packages.map((p) => ({ ecosystem, name: p.name, version: p.version }));
}
