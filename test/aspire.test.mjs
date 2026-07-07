// .NET / Aspire helper tests: run against the compiled out/services/*.js (manifestEditor + aspire
// are deliberately free of any vscode import, so they run under plain node). Covers the pure string
// editors and detection helpers that back the "Bump .NET & Aspire Versions" / "Bump .NET Version"
// commands.
//
// Run with:  npm test   (compiles first, then `node --test test/`)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const OUT = new URL('../out/services/', import.meta.url);
const {
  csprojReadTargetFrameworks,
  csprojUpdateTargetFramework,
  csprojReadAspireSdkVersion,
  csprojUpdateAspireSdkVersion,
} = await import(new URL('manifestEditor.js', OUT));
const { isAspirePackage, targetFrameworkOptions } = await import(new URL('aspire.js', OUT));

// ---------------------------------------------------------------------------
// isAspirePackage
// ---------------------------------------------------------------------------
test('isAspirePackage matches first-party Aspire packages only', () => {
  assert.ok(isAspirePackage('Aspire.Hosting.AppHost'));
  assert.ok(isAspirePackage('Aspire.Npgsql'));
  assert.ok(isAspirePackage('Aspire.StackExchange.Redis'));
  assert.ok(isAspirePackage('aspire.hosting.azure')); // case-insensitive

  assert.ok(!isAspirePackage('CommunityToolkit.Aspire.Hosting.Ollama'));
  assert.ok(!isAspirePackage('Microsoft.Extensions.ServiceDiscovery'));
  assert.ok(!isAspirePackage('AspireX')); // must be the `Aspire.` prefix, not just "Aspire"
  assert.ok(!isAspirePackage('MyAspire.Thing'));
});

// ---------------------------------------------------------------------------
// targetFrameworkOptions
// ---------------------------------------------------------------------------
test('targetFrameworkOptions leads with current, dedupes case-insensitively', () => {
  assert.deepEqual(targetFrameworkOptions(['net8.0']), ['net8.0', 'net10.0', 'net9.0']);
  // A current framework already in the common list isn't duplicated.
  assert.deepEqual(targetFrameworkOptions(['net9.0']), ['net9.0', 'net10.0', 'net8.0']);
  // An unusual current framework is offered first, then the common ones.
  assert.deepEqual(targetFrameworkOptions(['net7.0']), ['net7.0', 'net10.0', 'net9.0', 'net8.0']);
  assert.deepEqual(targetFrameworkOptions([]), ['net10.0', 'net9.0', 'net8.0']);
});

// ---------------------------------------------------------------------------
// <TargetFramework> read / update
// ---------------------------------------------------------------------------
test('reads and updates a single <TargetFramework>', () => {
  const xml = `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n`;
  assert.deepEqual(csprojReadTargetFrameworks(xml), { plural: false, values: ['net8.0'] });

  const updated = csprojUpdateTargetFramework(xml, 'net9.0');
  assert.ok(updated.includes('<TargetFramework>net9.0</TargetFramework>'));
  assert.ok(!updated.includes('net8.0'));
});

test('multi-target <TargetFrameworks> reads plural and refuses a single-value update', () => {
  const xml = `<Project><PropertyGroup><TargetFrameworks>net8.0;net9.0</TargetFrameworks></PropertyGroup></Project>`;
  assert.deepEqual(csprojReadTargetFrameworks(xml), { plural: true, values: ['net8.0', 'net9.0'] });
  // Only <TargetFramework> (singular) is editable; a multi-target project is left for the user.
  assert.equal(csprojUpdateTargetFramework(xml, 'net9.0'), undefined);
});

test('an inherited TFM (no element in this file) is undefined', () => {
  const xml = `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup></ItemGroup></Project>`;
  assert.equal(csprojReadTargetFrameworks(xml), undefined);
  assert.equal(csprojUpdateTargetFramework(xml, 'net9.0'), undefined);
});

// ---------------------------------------------------------------------------
// Aspire.AppHost.Sdk version read / update
// ---------------------------------------------------------------------------
test('reads and updates the Aspire.AppHost.Sdk version (Name before Version)', () => {
  const xml = `<Project Sdk="Microsoft.NET.Sdk">\n  <Sdk Name="Aspire.AppHost.Sdk" Version="9.0.0" />\n</Project>`;
  assert.equal(csprojReadAspireSdkVersion(xml), '9.0.0');

  const updated = csprojUpdateAspireSdkVersion(xml, '9.4.1');
  assert.ok(updated.includes('Version="9.4.1"'));
  assert.ok(updated.includes('Name="Aspire.AppHost.Sdk"'));
  assert.ok(!updated.includes('9.0.0'));
});

test('handles Version before Name attribute order', () => {
  const xml = `<Sdk Version="9.0.0" Name="Aspire.AppHost.Sdk" />`;
  assert.equal(csprojReadAspireSdkVersion(xml), '9.0.0');
  const updated = csprojUpdateAspireSdkVersion(xml, '9.4.1');
  assert.ok(updated.includes('Version="9.4.1"'));
  assert.ok(updated.includes('Name="Aspire.AppHost.Sdk"'));
});

test('leaves a project without the Aspire SDK untouched', () => {
  const xml = `<Project Sdk="Microsoft.NET.Sdk"><Sdk Name="Some.Other.Sdk" Version="1.0.0" /></Project>`;
  assert.equal(csprojReadAspireSdkVersion(xml), undefined);
  assert.equal(csprojUpdateAspireSdkVersion(xml, '9.4.1'), undefined);
});
