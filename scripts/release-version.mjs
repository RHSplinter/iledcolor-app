import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Release versions must use MAJOR.MINOR.PATCH without prerelease/build suffixes.');
  }
  const [major, minor, patch] = version.split('.').map(Number);
  const build = major * 1_000_000 + minor * 1_000 + patch + 1;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(build) || build > 2_100_000_000) {
    throw new Error('Version exceeds native build-number limits (minor/patch <= 999, build <= 2100000000).');
  }
  return { version, build };
}

export function nativeVersion(content, platform, { version, build }) {
  const fields = platform === 'android'
    ? [
        [/\bversionCode \d+/g, `versionCode ${build}`, 1],
        [/\bversionName "[^"]+"/g, `versionName "${version}"`, 1],
      ]
    : platform === 'ios'
      ? [
          [/\bCURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`, 2],
          [/\bMARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`, 2],
        ]
      : null;
  if (!fields) throw new Error(`Unsupported platform: ${platform}`);
  for (const [pattern, replacement, count] of fields) {
    if ([...content.matchAll(pattern)].length !== count) {
      throw new Error(`Unexpected ${platform} version fields; update the version synchronizer.`);
    }
    content = content.replace(pattern, replacement);
  }
  return content;
}

function main() {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  if (args.length && !(check && (args.length === 1 || (args.length === 3 && args[1] === '--tag')))) {
    throw new Error('Usage: node scripts/release-version.mjs [--check [--tag vMAJOR.MINOR.PATCH]]');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const release = releaseVersion(readJson('package.json').version);
  const lock = readJson('package-lock.json');
  if (lock.version !== release.version || lock.packages[''].version !== release.version) {
    throw new Error('package-lock.json version must match package.json. Use npm version to update both.');
  }
  if (args[1] === '--tag' && args[2] !== `v${release.version}`) {
    throw new Error(`Release tag ${args[2]} must match package.json: v${release.version}`);
  }
  const files = [
    ['android', 'android/app/build.gradle'],
    ['ios', 'ios/App/App.xcodeproj/project.pbxproj'],
  ].map(([platform, path]) => {
    const fullPath = join(root, path);
    const current = readFileSync(fullPath, 'utf8');
    return { fullPath, path, current, expected: nativeVersion(current, platform, release) };
  });
  for (const file of files) {
    if (file.current === file.expected) continue;
    if (check) throw new Error(`${file.path} is out of sync. Run npm run version.`);
    writeFileSync(file.fullPath, file.expected);
  }
  // npm version commits its own manifests, but native files must be staged by the hook.
  if (!check && process.env.npm_command === 'version' && process.env.npm_config_git_tag_version !== 'false') {
    execFileSync('git', ['add', '--', ...files.map((file) => file.path)], { cwd: root, stdio: 'inherit' });
  }
  console.log(`Version ${release.version}, native build ${release.build}${check ? ' verified' : ' synchronized'}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
