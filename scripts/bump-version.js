const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function versionAt(commit) {
  return JSON.parse(git('show', `${commit}:package.json`)).version;
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

function nextVersion(version, messages) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported package version: ${version}`);
  }

  let [major, minor, patch] = match.slice(1).map(Number);
  let bump = 'none';

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
const version = nextVersion(baselineVersion, messages);

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

if (packageJson.version !== version || packageLock.version !== version) {
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[''].version = version;
  fs.writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`);
}

console.log(`Versione applicazione: ${version}`);
