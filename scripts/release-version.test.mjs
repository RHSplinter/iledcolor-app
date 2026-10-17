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

test('Android setup uses supported SDK packages without the removed tools package', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-android.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const setup = workflow.match(/      - uses: android-actions\/setup-android@v3\n([\s\S]*?)(?=      - )/);
  assert.ok(setup, 'Android SDK setup must be present');
  assert.match(setup[1], /packages: platform-tools\n/);
  assert.ok(workflow.includes('sdkmanager "platforms;android-36" "build-tools;35.0.0"'));
});

test('Android manual releases normalize and validate the tag before checkout', (t) => {
  const workflow = readFileSync(new URL('../.github/workflows/release-android.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const validation = workflow.match(/      - name: Validate manual release tag\n([\s\S]*?)      - uses: actions\/checkout@v4/);
  assert.ok(validation, 'manual tag validation must run before checkout');
  assert.ok(validation[1].includes("if: github.event_name == 'workflow_dispatch'"));
  assert.ok(validation[1].includes('RELEASE_TAG: ${{ inputs.tag }}'));
  assert.ok(validation[1].includes('GH_TOKEN: ${{ github.token }}'));
  assert.ok(validation[1].includes('id: release_tag'));
  assert.ok(workflow.includes("ref: ${{ steps.release_tag.outputs.tag && format('refs/tags/{0}', steps.release_tag.outputs.tag) || github.ref }}"));
  assert.ok(workflow.includes('RELEASE_TAG: ${{ steps.release_tag.outputs.tag || github.ref_name }}'));
  const script = validation[1].split('        run: |\n')[1].replace(/^          /gm, '');
  const root = mkdtempSync(join(tmpdir(), 'led-hat-release-tag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'output');
  const run = (tag, exists) => {
    writeFileSync(output, '');
    return spawnSync('bash', ['-c', `
    gh() {
      printf 'API request: %s\\n' "$*"
      [[ "$*" == "api --silent repos/example/app/git/ref/tags/v0.2.0" ]] || exit 99
      return "$TAG_STATUS"
    }
    ${script}
  `], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: 'example/app',
      GITHUB_OUTPUT: output, TAG_STATUS: exists ? '0' : '1' },
  });
  };
  for (const tag of ['0.2.0', 'v0.2.0']) {
    assert.equal(run(tag, true).status, 0, tag);
    assert.equal(readFileSync(output, 'utf8'), 'tag=v0.2.0\n');
    const missing = run(tag, false);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /Cannot find release tag v0.2.0/);
    assert.match(missing.stdout, /Create and push it from the release commit/);
    assert.equal(readFileSync(output, 'utf8'), '');
  }
  for (const tag of ['', 'main', '01.2.3', 'v01.2.3', 'vv1.2.3', 'v1.2.3-beta.1',
    '1.2.3+build', 'v1.2.3; exit 0', '1.2.3\nmain']) {
    const invalid = run(tag, true);
    assert.equal(invalid.status, 1, tag);
    assert.match(invalid.stdout, /Release must use MAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH/);
    assert.ok(!invalid.stdout.includes('API request:'), 'invalid tags must not reach the API');
    assert.equal(readFileSync(output, 'utf8'), '');
  }
});
