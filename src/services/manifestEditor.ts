import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

const JSON_FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/* ---------------------------------- npm ---------------------------------- */

/** Bump a direct dependency in package.json, preserving the existing range style (^ / ~ / exact). */
export function npmUpdateDependency(text: string, name: string, version: string): string {
  const pkg = parseJsonc(text) ?? {};
  const section = ['dependencies', 'devDependencies', 'optionalDependencies'].find(
    (s) => pkg[s]?.[name] !== undefined
  );
  if (!section) {
    throw new Error(`${name} was not found in package.json dependencies`);
  }
  const current: string = pkg[section][name];
  const prefix = /^[\^~]/.test(current) ? current[0] : '';
  return applyEdits(text, modify(text, [section, name], prefix + version, JSON_FORMAT));
}

/** Pin a transitive dependency via the package.json "overrides" field. */
export function npmAddOverride(text: string, name: string, version: string): string {
  return applyEdits(text, modify(text, ['overrides', name], version, JSON_FORMAT));
}

/** Pin a transitive dependency via the pnpm "pnpm.overrides" field (workspace-root package.json). */
export function pnpmAddOverride(text: string, name: string, version: string): string {
  return applyEdits(text, modify(text, ['pnpm', 'overrides', name], version, JSON_FORMAT));
}

/* --------------------------------- NuGet --------------------------------- */

/**
 * Update the Version of an existing <PackageReference> in a project file.
 * Returns undefined when the package has no versioned reference in this file.
 */
export function csprojUpdateVersion(
  xml: string,
  name: string,
  version: string
): string | undefined {
  const escaped = escapeRegExp(name);
  // <PackageReference Include="X" Version="..." />
  const attrRegex = new RegExp(
    `(<PackageReference\\b[^>]*\\bInclude\\s*=\\s*"${escaped}"[^>]*\\bVersion\\s*=\\s*")[^"]*(")`,
    'i'
  );
  if (attrRegex.test(xml)) {
    return xml.replace(attrRegex, `$1${version}$2`);
  }
  // Central Package Management per-project escape hatch:
  // <PackageReference Include="X" VersionOverride="..." />
  const overrideRegex = new RegExp(
    `(<PackageReference\\b[^>]*\\bInclude\\s*=\\s*"${escaped}"[^>]*\\bVersionOverride\\s*=\\s*")[^"]*(")`,
    'i'
  );
  if (overrideRegex.test(xml)) {
    return xml.replace(overrideRegex, `$1${version}$2`);
  }
  // <PackageReference Include="X"><Version>...</Version></PackageReference>
  const elementRegex = new RegExp(
    `(<PackageReference\\b[^>]*\\bInclude\\s*=\\s*"${escaped}"[^>]*>[^<]*<Version>)[^<]*(</Version>)`,
    'i'
  );
  if (elementRegex.test(xml)) {
    return xml.replace(elementRegex, `$1${version}$2`);
  }
  return undefined;
}

export interface CpmMode {
  /** <ManagePackageVersionsCentrally>true</…> — versions live in Directory.Packages.props. */
  enabled: boolean;
  /** <CentralPackageTransitivePinningEnabled>true</…> — a bare PackageVersion pins transitives. */
  transitivePinning: boolean;
}

/** Detect Central Package Management state from the props file + project file contents. */
export function detectCpmMode(propsXml: string, projXml: string): CpmMode {
  const combined = `${propsXml}\n${projXml}`;
  const enabled =
    /<ManagePackageVersionsCentrally>\s*true\s*<\/ManagePackageVersionsCentrally>/i.test(combined);
  const transitivePinning =
    enabled &&
    /<CentralPackageTransitivePinningEnabled>\s*true\s*<\/CentralPackageTransitivePinningEnabled>/i.test(
      combined
    );
  return { enabled, transitivePinning };
}

/**
 * Update an existing <PackageVersion> entry in Directory.Packages.props (Central Package
 * Management). Returns undefined when the package is not listed.
 */
export function propsUpdateVersion(xml: string, name: string, version: string): string | undefined {
  const regex = new RegExp(
    `(<PackageVersion\\b[^>]*\\bInclude\\s*=\\s*"${escapeRegExp(name)}"[^>]*\\bVersion\\s*=\\s*")[^"]*(")`,
    'i'
  );
  return regex.test(xml) ? xml.replace(regex, `$1${version}$2`) : undefined;
}

/** Add a direct <PackageReference> pin for a transitive package (NuGet's direct-wins rule). */
export function csprojAddPackageReference(xml: string, name: string, version?: string): string {
  const versionAttr = version ? ` Version="${version}"` : '';
  return insertIntoItemGroup(
    xml,
    `<PackageReference Include="${name}"${versionAttr} /> <!-- transitive pin -->`,
    'PackageReference'
  );
}

/** Add or update a <PackageVersion> entry in Directory.Packages.props. */
export function propsSetPackageVersion(xml: string, name: string, version: string): string {
  return (
    propsUpdateVersion(xml, name, version) ??
    insertIntoItemGroup(xml, `<PackageVersion Include="${name}" Version="${version}" />`, 'PackageVersion')
  );
}

/** Insert an item into the first ItemGroup containing `siblingTag`, or add a new ItemGroup. */
function insertIntoItemGroup(xml: string, item: string, siblingTag: string): string {
  const siblingIdx = xml.search(new RegExp(`<${siblingTag}\\b`, 'i'));
  if (siblingIdx !== -1) {
    const closeIdx = xml.indexOf('</ItemGroup>', siblingIdx);
    if (closeIdx !== -1) {
      const siblingLineStart = xml.lastIndexOf('\n', siblingIdx) + 1;
      const indent = xml.slice(siblingLineStart).match(/^[ \t]*/)?.[0] ?? '    ';
      const closeLineStart = xml.lastIndexOf('\n', closeIdx) + 1;
      return xml.slice(0, closeLineStart) + `${indent}${item}\n` + xml.slice(closeLineStart);
    }
  }
  const projectClose = xml.lastIndexOf('</Project>');
  if (projectClose === -1) {
    throw new Error('Could not find </Project> element');
  }
  const block = `  <ItemGroup>\n    ${item}\n  </ItemGroup>\n\n`;
  return xml.slice(0, projectClose) + block + xml.slice(projectClose);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
