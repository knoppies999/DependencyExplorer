import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

const JSON_FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/* ---------------------------------- npm ---------------------------------- */

/**
 * True when `version` is already a full range spec the caller wants written verbatim — i.e. it
 * carries an explicit operator (`^`, `~`, `>=`, `<`, `=`) or a `*` wildcard, or the caller forced
 * literal mode. A bare version like `1.2.3` is not literal, so the existing `^`/`~` style is kept.
 */
function isLiteralSpec(version: string, literal: boolean): boolean {
  return literal || /^[\^~<>=]/.test(version) || version.includes('*');
}

/**
 * Bump a direct dependency in package.json. A bare version preserves the existing range style
 * (^ / ~ / exact); an explicit range (or `literal`) is written exactly as given.
 */
export function npmUpdateDependency(
  text: string,
  name: string,
  version: string,
  literal = false
): string {
  const pkg = parseJsonc(text) ?? {};
  const section = ['dependencies', 'devDependencies', 'optionalDependencies'].find(
    (s) => pkg[s]?.[name] !== undefined
  );
  if (!section) {
    throw new Error(`${name} was not found in package.json dependencies`);
  }
  const current: string = pkg[section][name];
  const prefix = isLiteralSpec(version, literal) ? '' : /^[\^~]/.test(current) ? current[0] : '';
  return applyEdits(text, modify(text, [section, name], prefix + version, JSON_FORMAT));
}

const NPM_DIRECT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Pin a transitive dependency via the package.json "overrides" field.
 *
 * npm rejects (`EOVERRIDE`) an override whose key is also a direct dependency unless the override
 * value references that dependency with npm's `$name` syntax. So when the package is *also* a direct
 * dependency here, bump the direct range to the safe version and point the override at it with
 * `$name` (forcing every nested copy to the same resolution); otherwise write the literal version.
 */
export function npmAddOverride(text: string, name: string, version: string, literal = false): string {
  const pkg = parseJsonc(text) ?? {};
  const directSection = NPM_DIRECT_SECTIONS.find((s) => pkg[s]?.[name] !== undefined);
  if (directSection) {
    const current: string = pkg[directSection][name];
    const prefix = isLiteralSpec(version, literal) ? '' : /^[\^~]/.test(current) ? current[0] : '';
    const bumped = applyEdits(
      text,
      modify(text, [directSection, name], prefix + version, JSON_FORMAT)
    );
    return applyEdits(bumped, modify(bumped, ['overrides', name], '$' + name, JSON_FORMAT));
  }
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

/** True if the project file already declares a <PackageReference Include="name" …>. */
function hasPackageReference(xml: string, name: string): boolean {
  return new RegExp(
    `<PackageReference\\b[^>]*\\bInclude\\s*=\\s*"${escapeRegExp(name)}"`,
    'i'
  ).test(xml);
}

/**
 * Add a direct <PackageReference> pin for a transitive package (NuGet's direct-wins rule).
 *
 * If the project already references the package directly, update that reference in place instead of
 * inserting a second one: NuGet rejects duplicate PackageReference items (`NU1504`) at restore. With
 * a version we bump the existing reference (adding a Version attribute if it had none); a versionless
 * call (CPM transitive-pin promotion) is a no-op when the reference is already present.
 */
export function csprojAddPackageReference(xml: string, name: string, version?: string): string {
  if (hasPackageReference(xml, name)) {
    if (!version) {
      return xml; // already a direct reference; nothing to promote.
    }
    const updated = csprojUpdateVersion(xml, name, version);
    if (updated !== undefined) {
      return updated;
    }
    // Existing reference has no Version — add one so the pin takes effect.
    return xml.replace(
      new RegExp(`(<PackageReference\\b[^>]*\\bInclude\\s*=\\s*"${escapeRegExp(name)}")`, 'i'),
      `$1 Version="${version}"`
    );
  }
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

/* ----------------------------- .NET / Aspire ----------------------------- */

// `<TargetFramework>net8.0</TargetFramework>`. The trailing `>` (not `s`) keeps this from matching
// the plural `<TargetFrameworks>` element — the two are handled distinctly on purpose.
const TFM_SINGLE = /<TargetFramework\s*>([^<]*)<\/TargetFramework\s*>/i;
const TFM_PLURAL = /<TargetFrameworks\s*>([^<]*)<\/TargetFrameworks\s*>/i;

/**
 * Read a project's declared target framework(s) from its own .csproj. Returns the single
 * `<TargetFramework>` value (`plural: false`), or the `;`-separated `<TargetFrameworks>` list
 * (`plural: true`), or undefined when neither is declared here (e.g. inherited from
 * Directory.Build.props).
 */
export function csprojReadTargetFrameworks(
  xml: string
): { plural: boolean; values: string[] } | undefined {
  const single = TFM_SINGLE.exec(xml);
  if (single) {
    return { plural: false, values: [single[1].trim()] };
  }
  const plural = TFM_PLURAL.exec(xml);
  if (plural) {
    return {
      plural: true,
      values: plural[1]
        .split(';')
        .map((v) => v.trim())
        .filter(Boolean),
    };
  }
  return undefined;
}

/**
 * Rewrite a project's single `<TargetFramework>` to `tfm`. Returns undefined when the element is
 * absent (the TFM is inherited, so there's nothing to edit here) or when only the multi-target
 * `<TargetFrameworks>` form is present — the caller surfaces both as "skipped" rather than guessing
 * which framework in a multi-target list to change.
 */
export function csprojUpdateTargetFramework(xml: string, tfm: string): string | undefined {
  if (!TFM_SINGLE.test(xml)) {
    return undefined;
  }
  return xml.replace(TFM_SINGLE, `<TargetFramework>${tfm}</TargetFramework>`);
}

// `<Sdk Name="Aspire.AppHost.Sdk" Version="9.0.0" />` — attribute order-independent, mirroring the
// PackageReference matchers above (Name may precede or follow Version).
function aspireSdkVersionRegex(): RegExp {
  return /(<Sdk\b[^>]*\bName\s*=\s*"Aspire\.AppHost\.Sdk"[^>]*\bVersion\s*=\s*")[^"]*(")/i;
}
function aspireSdkVersionRegexVersionFirst(): RegExp {
  return /(<Sdk\b[^>]*\bVersion\s*=\s*")[^"]*("[^>]*\bName\s*=\s*"Aspire\.AppHost\.Sdk")/i;
}

/** Read the `Aspire.AppHost.Sdk` version from an AppHost .csproj, or undefined when not declared. */
export function csprojReadAspireSdkVersion(xml: string): string | undefined {
  const forward = /<Sdk\b[^>]*\bName\s*=\s*"Aspire\.AppHost\.Sdk"[^>]*\bVersion\s*=\s*"([^"]*)"/i.exec(xml);
  if (forward) {
    return forward[1];
  }
  const reversed = /<Sdk\b[^>]*\bVersion\s*=\s*"([^"]*)"[^>]*\bName\s*=\s*"Aspire\.AppHost\.Sdk"/i.exec(xml);
  return reversed ? reversed[1] : undefined;
}

/** Rewrite the `Aspire.AppHost.Sdk` version. Returns undefined when the SDK isn't declared here. */
export function csprojUpdateAspireSdkVersion(xml: string, version: string): string | undefined {
  const forward = aspireSdkVersionRegex();
  if (forward.test(xml)) {
    return xml.replace(forward, `$1${version}$2`);
  }
  const reversed = aspireSdkVersionRegexVersionFirst();
  if (reversed.test(xml)) {
    return xml.replace(reversed, `$1${version}$2`);
  }
  return undefined;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
