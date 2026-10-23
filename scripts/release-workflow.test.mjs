import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const script = workflow.split('          BUMP: ${{ inputs.bump }}')[1]
  .split('        run: |\n')[1].split('\n  android:')[0].replace(/^          /gm, '');

test('release preparation is retry-safe and never overwrites conflicting refs (mocked Git/npm)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'led-hat-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const scenario of [
    { name: 'new release', exists: 'false', status: 0, push: true },
    { name: 'same-run retry', exists: 'true', status: 0, push: false },
    { name: 'conflicting tag', exists: 'true', message: 'another run', status: 1, push: false },
    { name: 'different source', exists: 'true', parent: 'other-sha', status: 1, push: false },
    { name: 'stale branch', exists: 'false', pushStatus: '1', status: 1, push: true },
    { name: 'invalid bump', bump: 'invalid', exists: 'false', status: 1, push: false },
  ]) {
    const result = spawnSync('bash', ['-c', `
      npm() { printf 'npm %s\\n' "$*"; }
      node() { printf '1.2.3\\n'; }
      git() {
        case "$1" in
          show-ref) [[ "$TAG_EXISTS" == true ]] ;;
          log) printf '%s\\n' "$TAG_MESSAGE" ;;
          rev-parse) printf '%s\\n' "$TAG_PARENT" ;;
          push) printf 'git %s\\n' "$*"; return "$PUSH_STATUS" ;;
          *) printf 'git %s\\n' "$*" ;;
        esac
      }
      ${script}
    `], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        BUMP: scenario.bump || 'patch',
        RELEASE_BRANCH: 'main',
        SOURCE_COMMIT: 'source-sha',
        GITHUB_RUN_ID: '123',
        GITHUB_OUTPUT: 'output',
        GITHUB_STEP_SUMMARY: 'summary',
        TAG_EXISTS: scenario.exists,
        TAG_MESSAGE: scenario.message || 'chore: release v1.2.3 (Actions run 123)',
        TAG_PARENT: scenario.parent || 'source-sha',
        PUSH_STATUS: scenario.pushStatus || '0',
      },
    });
    assert.equal(result.status, scenario.status, `${scenario.name}: ${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.includes('git push'), scenario.push, scenario.name);
    assert.doesNotMatch(result.stdout, /--force|--clobber/);
    if (scenario.push) {
      assert.match(result.stdout, /git push --atomic origin HEAD:refs\/heads\/main refs\/tags\/v1.2.3/);
      assert.match(result.stdout, /git add -- package.json package-lock.json android\/app\/build.gradle ios\/App\/App.xcodeproj\/project.pbxproj/);
      assert.match(result.stdout, /npm run test:release/);
    }
    if (scenario.status === 0) {
      assert.match(readFileSync(join(root, 'output'), 'utf8'), /tag=v1.2.3/);
    }
  }
});

test('orchestration calls both existing platform workflows with the same prepared tag', () => {
  assert.match(workflow, /options: \[patch, minor, major\]/);
  assert.match(workflow, /options: \[android, android-and-ios\]/);
  assert.match(workflow, /if: inputs.platforms == 'android-and-ios'/);
  assert.equal(workflow.match(/tag: \$\{\{ needs.prepare.outputs.tag \}\}/g)?.length, 2);
  for (const platform of ['android', 'ios']) {
    assert.ok(workflow.includes(`uses: ./.github/workflows/release-${platform}.yml`));
    const reusable = readFileSync(new URL(`../.github/workflows/release-${platform}.yml`, import.meta.url), 'utf8');
    assert.match(reusable, /workflow_call:/);
    assert.ok(reusable.includes("inputs.tag && format('refs/tags/{0}', inputs.tag)"));
  }
  assert.ok(workflow.indexOf('Check required signing secrets') < workflow.indexOf('git push --atomic'));
});
