const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function versionAt(commit) {
  return JSON.parse(git('show', `${commit}:package.json`)).version;
}

function changedFiles(...args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function normalizedPackageFile(file, content) {
  const json = JSON.parse(content);
  delete json.version;

  if (file === 'package.json') {
    delete json.scripts.prebuild;
    delete json.scripts['version:bump'];
  } else {
    delete json.packages[''].version;
  }

  return JSON.stringify(json);
}

function hasLocalChanges() {
  const files = new Set([
    ...changedFiles('diff', 'HEAD', '--name-only', '-z'),
    ...changedFiles('ls-files', '--others', '--exclude-standard', '-z'),
  ]);

  for (const file of files) {
    if (file === 'scripts/bump-version.js' || file === 'android/app/build.gradle') {
      continue;
    }

    if (file === 'package.json' || file === 'package-lock.json') {
      if (!fs.existsSync(file)) {
        return true;
      }

      const committed = git('show', `HEAD:${file}`);
      const working = fs.readFileSync(file, 'utf8');
      if (normalizedPackageFile(file, committed) !== normalizedPackageFile(file, working)) {
        return true;
      }
      continue;
    }

    return true;
  }

  return false;
}

function latestVersionCommit(commits) {
  for (const commit of commits) {
    const revision = git('rev-list', '--parents', '-n', '1', commit).split(' ');
    const parent = revision[1];
    if (!parent) {
      return commit;
    }

    if (versionAt(commit) !== versionAt(parent)) {
      return commit;
    }
  }

  return commits.at(-1);
}

function nextVersion(version, messages, hasUncommittedChanges) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported package version: ${version}`);
  }

  let [major, minor, patch] = match.slice(1).map(Number);
  let bump = hasUncommittedChanges ? 'patch' : 'none';

  for (const message of messages) {
    const [header, ...body] = message.split('\n');
    const conventional = header.match(/^([a-z]+)(?:\([^)]+\))?(!)?:\s/);
    if (!conventional) {
      continue;
    }

    const isBreaking =
      conventional[2] ||
      body.some((line) => /^BREAKING CHANGE:\s/.test(line));

    if (isBreaking) {
      bump = 'major';
    } else if (conventional[1] === 'feat' && bump !== 'major') {
      bump = 'minor';
    } else if (
      ['fix', 'perf'].includes(conventional[1]) &&
      bump !== 'major' &&
      bump !== 'minor'
    ) {
      bump = 'patch';
    }
  }

  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else if (bump === 'patch') {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

const commits = git('log', '--format=%H', '--', 'package.json')
  .split('\n')
  .filter(Boolean);

if (commits.length === 0) {
  throw new Error('Cannot determine the version baseline from Git history.');
}

const baseline = latestVersionCommit(commits);
const baselineVersion = versionAt(baseline);
const messages = git('log', '--format=%B%x00', `${baseline}..HEAD`)
  .split('\0')
  .filter(Boolean);
const version = nextVersion(baselineVersion, messages, hasLocalChanges());

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

if (packageJson.version !== version || packageLock.version !== version) {
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[''].version = version;
  fs.writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`);
}

const androidBuildGradlePath = 'android/app/build.gradle';
const androidBuildGradle = fs.readFileSync(androidBuildGradlePath, 'utf8');
const versionCodeMatch = androidBuildGradle.match(/^\s*versionCode\s+(\d+)\s*$/m);
if (!versionCodeMatch) {
  throw new Error('Cannot determine the Android versionCode.');
}
if (!/^\s*versionName\s+"[^"]+"\s*$/m.test(androidBuildGradle)) {
  throw new Error('Cannot determine the Android versionName.');
}

const nextAndroidVersionCode = Number(versionCodeMatch[1]) + 1;
const updatedAndroidBuildGradle = androidBuildGradle
  .replace(/^\s*versionCode\s+\d+\s*$/m, `        versionCode ${nextAndroidVersionCode}`)
  .replace(/^\s*versionName\s+"[^"]+"\s*$/m, `        versionName "${version}"`);

if (updatedAndroidBuildGradle !== androidBuildGradle) {
  fs.writeFileSync(androidBuildGradlePath, updatedAndroidBuildGradle);
}

console.log(`Versione applicazione: ${version}`);
