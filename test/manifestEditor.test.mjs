// Pure text-editor tests for manifestEditor.js — the functions that rewrite users' package.json /
// .csproj / Directory.Packages.props on disk. These are the highest-stakes pure functions in the
// codebase (a bad edit corrupts a real manifest), so they get exhaustive coverage. manifestEditor is
// deliberately vscode-free, so it loads directly from the compiled output.
//
// Run with:  npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const {
  npmUpdateDependency,
  npmAddOverride,
  pnpmAddOverride,
  csprojUpdateVersion,
  detectCpmMode,
  propsUpdateVersion,
  propsSetPackageVersion,
  csprojAddPackageReference,
  escapeRegExp,
} = await import(new URL('manifestEditor.js', OUT));

const pkg = (obj) => JSON.stringify(obj, null, 2);

// ---------------------------------------------------------------------------
// npmUpdateDependency
// ---------------------------------------------------------------------------
test('npmUpdateDependency preserves an existing caret range on a bare version', () => {
  const text = pkg({ dependencies: { lodash: '^4.17.20' } });
  const out = JSON.parse(npmUpdateDependency(text, 'lodash', '4.17.21'));
  assert.equal(out.dependencies.lodash, '^4.17.21');
});

test('npmUpdateDependency preserves a tilde range', () => {
  const text = pkg({ dependencies: { lodash: '~4.17.20' } });
  const out = JSON.parse(npmUpdateDependency(text, 'lodash', '4.17.21'));
  assert.equal(out.dependencies.lodash, '~4.17.21');
});

test('npmUpdateDependency keeps an exact pin exact', () => {
  const text = pkg({ dependencies: { lodash: '4.17.20' } });
  const out = JSON.parse(npmUpdateDependency(text, 'lodash', '4.17.21'));
  assert.equal(out.dependencies.lodash, '4.17.21');
});

test('npmUpdateDependency writes an explicit range verbatim (no double operator)', () => {
  const text = pkg({ dependencies: { lodash: '^4.17.20' } });
  const out = JSON.parse(npmUpdateDependency(text, 'lodash', '^4.18.0'));
  assert.equal(out.dependencies.lodash, '^4.18.0');
});

test('npmUpdateDependency in literal mode drops the inherited prefix', () => {
  const text = pkg({ dependencies: { lodash: '^4.17.20' } });
  const out = JSON.parse(npmUpdateDependency(text, 'lodash', '4.18.0', true));
  assert.equal(out.dependencies.lodash, '4.18.0');
});

test('npmUpdateDependency finds the package in devDependencies', () => {
  const text = pkg({ devDependencies: { typescript: '~5.4.0' } });
  const out = JSON.parse(npmUpdateDependency(text, 'typescript', '5.5.0'));
  assert.equal(out.devDependencies.typescript, '~5.5.0');
});

test('npmUpdateDependency throws when the package is absent', () => {
  const text = pkg({ dependencies: { a: '^1.0.0' } });
  assert.throws(() => npmUpdateDependency(text, 'missing', '1.0.0'), /not been? found|not found/i);
});

// ---------------------------------------------------------------------------
// npmAddOverride
// ---------------------------------------------------------------------------
test('npmAddOverride adds a plain overrides entry for a purely transitive package', () => {
  const text = pkg({ dependencies: { a: '^1.0.0' } });
  const out = JSON.parse(npmAddOverride(text, 'nested', '2.0.1'));
  assert.equal(out.overrides.nested, '2.0.1');
});

test('npmAddOverride bumps the direct range AND points the override at it with $name', () => {
  // npm rejects (EOVERRIDE) an override whose key is also a direct dep unless it uses $name syntax.
  const text = pkg({ dependencies: { lodash: '^4.17.20' } });
  const out = JSON.parse(npmAddOverride(text, 'lodash', '4.17.21'));
  assert.equal(out.dependencies.lodash, '^4.17.21', 'direct range bumped');
  assert.equal(out.overrides.lodash, '$lodash', 'override references the direct dep');
});

// ---------------------------------------------------------------------------
// pnpmAddOverride
// ---------------------------------------------------------------------------
test('pnpmAddOverride writes under pnpm.overrides', () => {
  const text = pkg({ name: 'root', dependencies: {} });
  const out = JSON.parse(pnpmAddOverride(text, 'nested', '2.0.1'));
  assert.equal(out.pnpm.overrides.nested, '2.0.1');
});

// ---------------------------------------------------------------------------
// csprojUpdateVersion — three declaration shapes, plus VersionOverride
// ---------------------------------------------------------------------------
test('csprojUpdateVersion updates a Version attribute (Include before Version)', () => {
  const xml = `<Project><ItemGroup>\n  <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />\n</ItemGroup></Project>`;
  const out = csprojUpdateVersion(xml, 'Newtonsoft.Json', '13.0.3');
  assert.ok(out.includes('Version="13.0.3"'));
  assert.ok(!out.includes('12.0.1'));
});

test('csprojUpdateVersion updates a VersionOverride (CPM per-project escape hatch)', () => {
  const xml = `<PackageReference Include="Serilog" VersionOverride="3.0.0" />`;
  const out = csprojUpdateVersion(xml, 'Serilog', '3.1.1');
  assert.ok(out.includes('VersionOverride="3.1.1"'));
});

test('csprojUpdateVersion updates a child <Version> element', () => {
  const xml = `<PackageReference Include="Serilog"><Version>3.0.0</Version></PackageReference>`;
  const out = csprojUpdateVersion(xml, 'Serilog', '3.1.1');
  assert.ok(out.includes('<Version>3.1.1</Version>'));
});

test('csprojUpdateVersion returns undefined when the package has no versioned reference', () => {
  const xml = `<PackageReference Include="Serilog" />`;
  assert.equal(csprojUpdateVersion(xml, 'Serilog', '3.1.1'), undefined);
  assert.equal(csprojUpdateVersion(xml, 'NotThere', '1.0.0'), undefined);
});

test('csprojUpdateVersion does not confuse a similarly-named package', () => {
  const xml = `<PackageReference Include="Serilog.Sinks.Console" Version="4.0.0" />\n<PackageReference Include="Serilog" Version="3.0.0" />`;
  const out = csprojUpdateVersion(xml, 'Serilog', '3.1.1');
  assert.ok(out.includes('Include="Serilog.Sinks.Console" Version="4.0.0"'), 'sibling untouched');
  assert.ok(out.includes('Include="Serilog" Version="3.1.1"'));
});

// ---------------------------------------------------------------------------
// detectCpmMode
// ---------------------------------------------------------------------------
test('detectCpmMode reads central management + transitive pinning from either file', () => {
  const props = `<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>`;
  assert.deepEqual(detectCpmMode(props, ''), { enabled: true, transitivePinning: false });

  const withPinning = `<PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally><CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled></PropertyGroup>`;
  assert.deepEqual(detectCpmMode(withPinning, ''), { enabled: true, transitivePinning: true });
});

test('detectCpmMode: transitive pinning only counts when CPM is enabled', () => {
  const onlyPinning = `<CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>`;
  assert.deepEqual(detectCpmMode(onlyPinning, ''), { enabled: false, transitivePinning: false });
});

test('detectCpmMode is false for a classic project', () => {
  assert.deepEqual(detectCpmMode('', '<Project></Project>'), { enabled: false, transitivePinning: false });
});

// ---------------------------------------------------------------------------
// propsUpdateVersion / propsSetPackageVersion
// ---------------------------------------------------------------------------
test('propsUpdateVersion edits an existing PackageVersion, undefined when absent', () => {
  const xml = `<Project><ItemGroup>\n  <PackageVersion Include="Polly" Version="7.0.0" />\n</ItemGroup></Project>`;
  const out = propsUpdateVersion(xml, 'Polly', '8.4.1');
  assert.ok(out.includes('Version="8.4.1"'));
  assert.equal(propsUpdateVersion(xml, 'Missing', '1.0.0'), undefined);
});

test('propsSetPackageVersion updates in place when present', () => {
  const xml = `<Project><ItemGroup>\n  <PackageVersion Include="Polly" Version="7.0.0" />\n</ItemGroup></Project>`;
  const out = propsSetPackageVersion(xml, 'Polly', '8.4.1');
  assert.ok(out.includes('Version="8.4.1"'));
  assert.ok(!out.includes('7.0.0'));
});

test('propsSetPackageVersion inserts a new entry into the existing ItemGroup', () => {
  const xml = `<Project>\n  <ItemGroup>\n    <PackageVersion Include="Polly" Version="7.0.0" />\n  </ItemGroup>\n</Project>\n`;
  const out = propsSetPackageVersion(xml, 'Serilog', '3.1.1');
  assert.ok(out.includes('<PackageVersion Include="Polly" Version="7.0.0" />'), 'existing kept');
  assert.ok(out.includes('<PackageVersion Include="Serilog" Version="3.1.1" />'), 'new inserted');
  assert.equal((out.match(/<ItemGroup>/g) || []).length, 1, 'reused the existing ItemGroup');
});

// ---------------------------------------------------------------------------
// csprojAddPackageReference — insert, dedupe (NU1504), version promotion
// ---------------------------------------------------------------------------
test('csprojAddPackageReference inserts a versioned pin with a transitive-pin comment', () => {
  const xml = `<Project>\n  <ItemGroup>\n    <PackageReference Include="A" Version="1.0.0" />\n  </ItemGroup>\n</Project>\n`;
  const out = csprojAddPackageReference(xml, 'B', '2.0.0');
  assert.ok(out.includes('<PackageReference Include="B" Version="2.0.0" />'));
  assert.ok(out.includes('transitive pin'));
});

test('csprojAddPackageReference creates an ItemGroup when the project has none', () => {
  const xml = `<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n`;
  const out = csprojAddPackageReference(xml, 'B', '2.0.0');
  assert.ok(out.includes('<ItemGroup>'));
  assert.ok(out.includes('<PackageReference Include="B" Version="2.0.0" />'));
  assert.ok(out.trimEnd().endsWith('</Project>'));
});

test('csprojAddPackageReference updates in place instead of adding a duplicate (NU1504)', () => {
  const xml = `<PackageReference Include="B" Version="1.0.0" />`;
  const out = csprojAddPackageReference(xml, 'B', '2.0.0');
  assert.equal((out.match(/Include="B"/g) || []).length, 1, 'no second reference');
  assert.ok(out.includes('Version="2.0.0"'));
});

test('csprojAddPackageReference adds a Version to an existing versionless reference', () => {
  const xml = `<PackageReference Include="B" />`;
  const out = csprojAddPackageReference(xml, 'B', '2.0.0');
  assert.ok(out.includes('Version="2.0.0"'));
});

test('csprojAddPackageReference versionless call is a no-op when already referenced (CPM promotion)', () => {
  const xml = `<PackageReference Include="B" />`;
  assert.equal(csprojAddPackageReference(xml, 'B'), xml);
});

// ---------------------------------------------------------------------------
// escapeRegExp
// ---------------------------------------------------------------------------
test('escapeRegExp escapes regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b+c'), 'a\\.b\\+c');
  assert.equal(escapeRegExp('Foo.Bar'), 'Foo\\.Bar');
  // Proof it makes package names with dots match literally, not as "any char".
  const xml = `<PackageReference Include="AxBxC" Version="1.0.0" />`;
  assert.equal(csprojUpdateVersion(xml, 'A.B.C', '2.0.0'), undefined, 'dot must not match x');
});
