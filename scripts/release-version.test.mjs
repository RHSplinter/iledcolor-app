import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeVersion, releaseVersion } from './release-version.mjs';

test('stable versions map to increasing native build numbers', () => {
  const versions = ['0.0.0', '0.1.0', '0.1.1', '0.999.999', '1.0.0', '2099.999.999'];
  const builds = versions.map((version) => releaseVersion(version).build);
  assert.deepEqual(builds, [1, 1001, 1002, 1000000, 1000001, 2100000000]);
  assert.deepEqual([...builds].sort((a, b) => a - b), builds);
});

test('rejects versions unsupported by native release metadata', () => {
  for (const version of ['1.0', '01.2.3', 'v1.2.3', '1.2.3-beta.1', '1.2.3+1', '-1.0.0',
    '1.1000.0', '1.0.1000', '2100.0.0', '999999999999999999.0.0', '', null]) {
    assert.throws(() => releaseVersion(version));
  }
});

for (const [platform, path, field] of [
  ['android', '../android/app/build.gradle', 'versionName "1.2.3"'],
  ['ios', '../ios/App/App.xcodeproj/project.pbxproj', 'MARKETING_VERSION = 1.2.3;'],
]) {
  test(`${platform} version synchronization is complete and idempotent`, () => {
    const original = readFileSync(new URL(path, import.meta.url), 'utf8');
    const version = releaseVersion('1.2.3');
    const updated = nativeVersion(original, platform, version);
    assert.ok(updated.includes(field));
    assert.ok(updated.includes('1002004'));
    assert.equal(nativeVersion(updated, platform, version), updated);
    const old = releaseVersion(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.equal(nativeVersion(updated, platform, old), original);
  });
}

test('fails rather than silently accepting changed project structures', () => {
  assert.throws(() => nativeVersion('', 'android', releaseVersion('1.0.0')));
  assert.throws(() => nativeVersion('MARKETING_VERSION = 1.0;', 'ios', releaseVersion('1.0.0')));
  assert.throws(() => nativeVersion('', 'web', releaseVersion('1.0.0')));
});

test('CLI checks the tag, lockfile and native metadata and synchronizes a version bump', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'led-hat-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'scripts/release-version.mjs', 'package.json', 'package-lock.json',
    'android/app/build.gradle', 'ios/App/App.xcodeproj/project.pbxproj',
  ]) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL('../' + path, import.meta.url), destination);
  }
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/release-version.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, npm_command: '', npm_config_git_tag_version: 'false' },
  });
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.equal(run('--check', '--tag', `v${version}`).status, 0);
  assert.match(run('--check', '--tag', 'v9.9.9').stderr, /must match package.json/);
  assert.notEqual(run('--unknown').status, 0);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.version = '1.2.3';
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  assert.match(run('--check').stderr, /package-lock.json version must match/);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  lock.version = lock.packages[''].version = pkg.version;
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  assert.match(run('--check').stderr, /out of sync/);
  assert.equal(run().status, 0);
  assert.equal(run('--check', '--tag', 'v1.2.3').status, 0);
});

test('Android manual releases validate the tag before checkout', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-android.yml', import.meta.url), 'utf8');
  const validation = workflow.match(/      - name: Validate manual release tag\n([\s\S]*?)      - uses: actions\/checkout@v4/);
  assert.ok(validation, 'manual tag validation must run before checkout');
  assert.ok(validation[1].includes("if: github.event_name == 'workflow_dispatch'"));
  assert.ok(validation[1].includes('RELEASE_TAG: ${{ inputs.tag }}'));
  assert.ok(validation[1].includes('GH_TOKEN: ${{ github.token }}'));
  const script = validation[1].split('        run: |\n')[1].replace(/^          /gm, '');
  const run = (tag, exists) => spawnSync('bash', ['-c', `
    gh() {
      printf 'API request: %s\\n' "$*"
      [[ "$*" == "api --silent repos/example/app/git/ref/tags/$RELEASE_TAG" ]] || exit 99
      return "$TAG_STATUS"
    }
    ${script}
  `], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: 'example/app', TAG_STATUS: exists ? '0' : '1' },
  });
  assert.equal(run('v0.1.0', true).status, 0);
  const missing = run('v0.1.0', false);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Create and push it from the release commit/);
  for (const tag of ['0.1.0', '', 'main', 'v01.2.3', 'v1.2.3-beta.1', 'v1.2.3; exit 0']) {
    const invalid = run(tag, true);
    assert.equal(invalid.status, 1, tag);
    assert.match(invalid.stdout, /Tag must use vMAJOR.MINOR.PATCH/);
    assert.ok(!invalid.stdout.includes('API request:'), 'invalid tags must not reach the API');
  }
});
