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

test('Android publishing creates and verifies the tag at the validated build commit', (t) => {
  const workflow = readFileSync(new URL('../.github/workflows/release-android.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('commit: ${{ steps.version.outputs.commit }}'));
  assert.ok(workflow.includes('echo "commit=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"'));
  assert.ok(workflow.includes('RELEASE_COMMIT: ${{ needs.android.outputs.commit }}'));
  const publication = workflow.split('      - name: Publish Android app with checksums\n')[1];
  assert.ok(publication);
  const script = publication.split('        run: |\n')[1].replace(/^          /gm, '');
  const root = mkdtempSync(join(tmpdir(), 'led-hat-release-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'led-hat-v0.2.0-android.apk'), 'test artifact');
  for (const scenario of [
    { tagExists: false, tagCommit: 'built-commit-sha', releaseExists: false },
    { tagExists: true, tagCommit: 'built-commit-sha', releaseExists: true },
  ]) {
    const result = spawnSync('bash', ['-c', `
      gh() {
        if [[ "$1" == "api" ]]; then
          printf '%s\\n' "$*" >&2
        else
          printf '%s\\n' "$*"
        fi
        if [[ "$1 $2" == "api repos/example/app/git/ref/tags/v0.2.0" ]]; then
          [[ "$TAG_EXISTS" == "true" ]]
          return
        fi
        if [[ "$1 $2" == "api --method" ]]; then
          [[ "$3 $4 $5 $6 $7 $8" == "POST repos/example/app/git/refs -f ref=refs/tags/v0.2.0 -f sha=built-commit-sha" ]] || exit 99
          [[ "$TAG_EXISTS" == "false" ]] || exit 98
          TAG_EXISTS=true
          return
        fi
        if [[ "$1 $2" == "api repos/example/app/commits/v0.2.0" ]]; then
          printf '%s\\n' "$TAG_COMMIT"
          return
        fi
        if [[ "$1 $2" == "release view" ]]; then
          return "$RELEASE_STATUS"
        fi
        if [[ "$1 $2" == "release create" ]]; then
          [[ "$3 $4 $5" == "v0.2.0 --verify-tag --draft" ]] || exit 99
        fi
      }
      ${script}
    `], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, RELEASE_TAG: 'v0.2.0', RELEASE_COMMIT: 'built-commit-sha',
        GH_REPO: 'example/app', TAG_EXISTS: String(scenario.tagExists),
        TAG_COMMIT: scenario.tagCommit, RELEASE_STATUS: scenario.releaseExists ? '0' : '1' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr.includes('--method POST'), !scenario.tagExists);
    assert.equal(result.stdout.includes('release create'), !scenario.releaseExists);
    assert.match(result.stdout, /release upload v0.2.0 led-hat-v0.2.0-android.apk SHA256SUMS-android.txt --clobber/);
    assert.match(result.stdout, /release edit v0.2.0 --draft=false --latest/);
    assert.match(readFileSync(join(root, 'SHA256SUMS-android.txt'), 'utf8'), /^[a-f0-9]{64}  led-hat-v0.2.0-android.apk\n$/);
  }
  const mismatch = spawnSync('bash', ['-c', `
    gh() {
      if [[ "$1 $2" == "api repos/example/app/git/ref/tags/v0.2.0" ]]; then return 0; fi
      if [[ "$1 $2" == "api repos/example/app/commits/v0.2.0" ]]; then
        printf 'different-commit-sha\\n'
        return 0
      fi
      printf 'unexpected publication request: %s\\n' "$*" >&2
      exit 99
    }
    ${script}
  `], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: 'v0.2.0', RELEASE_COMMIT: 'built-commit-sha',
      GH_REPO: 'example/app' },
  });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /expected built-commit-sha/);
  assert.doesNotMatch(mismatch.stdout, /release upload/);
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

test('Android manual releases derive the tag from validated project files', (t) => {
  const workflow = readFileSync(new URL('../.github/workflows/release-android.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('  workflow_dispatch:\n\npermissions:'));
  assert.ok(!workflow.includes('inputs.tag'));
  assert.ok(workflow.includes('ref: ${{ github.sha }}'));
  const validation = workflow.match(/      - name: Resolve manual release tag\n([\s\S]*?)      - uses: actions\/checkout@v4/);
  assert.ok(validation);
  assert.ok(workflow.indexOf('uses: actions/checkout@v4') < validation.index);
  assert.ok(workflow.indexOf('uses: actions/setup-node@v4') < validation.index);
  assert.ok(validation[1].includes("if: github.event_name == 'workflow_dispatch'"));
  assert.ok(validation[1].includes('GH_TOKEN: ${{ github.token }}'));
  assert.ok(validation[1].includes('RELEASE_COMMIT: ${{ github.sha }}'));
  assert.ok(validation[1].includes('id: release_tag'));
  assert.ok(workflow.includes('ref: ${{ steps.release_tag.outputs.ref }}'));
  assert.ok(workflow.includes('RELEASE_TAG: ${{ steps.release_tag.outputs.tag || github.ref_name }}'));
  const script = validation[1].split('        run: |\n')[1].replace(/^          /gm, '');
  const root = mkdtempSync(join(tmpdir(), 'led-hat-release-tag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'scripts/release-version.mjs', 'package.json', 'package-lock.json',
    'android/app/build.gradle', 'ios/App/App.xcodeproj/project.pbxproj',
  ]) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL('../' + path, import.meta.url), destination);
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const output = join(root, 'output');
  const run = (exists, apiStatus = 0) => {
    writeFileSync(output, '');
    return spawnSync('bash', ['-c', `
    gh() {
      printf 'API request: %s\\n' "$*" >&2
      [[ "$1 $2" == "api repos/example/app/git/matching-refs/tags/v${version}" ]] || exit 99
      [[ "$3" == "--jq" ]] || exit 99
      [[ "$4" == '.[] | select(.ref == "refs/tags/v${version}") | .ref' ]] || exit 99
      if [[ "$TAG_EXISTS" == "true" ]]; then
        printf 'refs/tags/v${version}\\n'
      fi
      return "$API_STATUS"
    }
    ${script}
  `], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'example/app',
      GITHUB_OUTPUT: output, TAG_EXISTS: String(exists), API_STATUS: String(apiStatus),
      RELEASE_COMMIT: 'selected-commit-sha' },
  });
  };
  assert.equal(run(true).status, 0);
  assert.equal(readFileSync(output, 'utf8'), `tag=v${version}\nref=refs/tags/v${version}\n`);
  const missing = run(false);
  assert.equal(missing.status, 0);
  assert.equal(readFileSync(output, 'utf8'), `tag=v${version}\nref=selected-commit-sha\n`);
  assert.equal(run(false, 1).status, 1, 'API failures must not fall back to a new tag');
  assert.equal(readFileSync(output, 'utf8'), '');
  for (const value of ['', 'main', '01.2.3', 'v1.2.3', '1.2.3-beta.1',
    '1.2.3+build', '1.2.3; exit 0', '1.2.3\nmain', '9.9.9']) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, version: value }));
    const invalid = run(true);
    assert.notEqual(invalid.status, 0, value);
    assert.ok(!invalid.stderr.includes('API request:'), 'invalid tags must not reach the API');
    assert.equal(readFileSync(output, 'utf8'), '');
  }
});

test('Android setup uses supported SDK packages without the removed tools package', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-android.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const setup = workflow.match(/      - uses: android-actions\/setup-android@v3\n([\s\S]*?)(?=      - )/);
  assert.ok(setup, 'Android SDK setup must be present');
  assert.match(setup[1], /packages: platform-tools\n/);
  assert.ok(workflow.includes('sdkmanager "platforms;android-36" "build-tools;35.0.0"'));
});
