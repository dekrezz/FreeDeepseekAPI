const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createUpdater, CHANNELS, RESTART_EXIT_CODE } = require('../lib/updater');

const ROOT = path.resolve(__dirname, '..');

// A fake git: answers by the joined argument list and records every call.
function fakeGit(answers) {
  const calls = [];
  const exec = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    for (const [pattern, answer] of answers) {
      if (pattern instanceof RegExp ? pattern.test(key) : pattern === key) {
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer(key) : answer;
      }
    }
    throw new Error(`unexpected git ${key}`);
  };
  return { exec, calls };
}

function gitFail(message) {
  return Object.assign(new Error(message), { code: 1 });
}

function checkout(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsa-upd-'))) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

const base = (extra = []) => [
  ...extra,
  ['rev-parse --abbrev-ref HEAD', 'stable\n'],
  ['rev-parse HEAD', 'aaaaaaa1111111111111111111111111111111111\n'],
  [/^fetch --quiet origin/, ''],
  ['status --porcelain --untracked-files=no', ''],
];

test('channels are exactly stable and latest', () => {
  assert.deepEqual(CHANNELS, ['stable', 'latest']);
  assert.equal(RESTART_EXIT_CODE, 75);
});

test('a copy without .git cannot update itself and says how to update instead', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsa-upd-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  const { exec } = fakeGit([]);
  const updater = createUpdater({ root: dir, exec, env: {} });
  const status = await updater.status();
  assert.equal(status.version, '0.2.0');
  assert.equal(status.method, 'unavailable');
  assert.equal(status.reason, 'not_a_git_checkout');
  await assert.rejects(updater.check('stable'), err => err.status === 409 && err.type === 'update_unavailable');
});

test('status reports the version, commit, channel and how a restart happens', async () => {
  const { exec } = fakeGit(base());
  const viaLauncher = await createUpdater({ root: checkout(), exec, env: { FDSA_LAUNCHER: '1' } }).status();
  assert.equal(viaLauncher.method, 'git');
  assert.equal(viaLauncher.channel, 'stable');
  assert.equal(viaLauncher.commit, 'aaaaaaa');
  assert.equal(viaLauncher.restart, 'auto');
  const plain = await createUpdater({ root: checkout(), exec, env: {} }).status();
  assert.equal(plain.restart, 'manual');
});

test('an unknown channel is refused before any git call', async () => {
  const { exec, calls } = fakeGit(base());
  const updater = createUpdater({ root: checkout(), exec, env: {} });
  for (const bad of ['main', 'stable; rm -rf /', '', undefined]) {
    await assert.rejects(updater.check(bad), err => err.status === 400 && err.type === 'invalid_channel');
  }
  assert.equal(calls.length, 0);
});

test('a channel that is not published on GitHub yet gives a clear error', async () => {
  const { exec } = fakeGit([
    [/^fetch --quiet origin/, gitFail("git fetch failed: fatal: couldn't find remote ref refs/heads/latest")],
    ...base(),
  ]);
  await assert.rejects(createUpdater({ root: checkout(), exec, env: {} }).check('latest'),
    err => err.status === 404 && err.type === 'channel_missing' && /latest/.test(err.message));
});

test('check reports up to date when the channel has nothing new', async () => {
  const { exec } = fakeGit(base([
    ['rev-parse origin/stable', 'aaaaaaa1111111111111111111111111111111111\n'],
    ['show origin/stable:package.json', JSON.stringify({ version: '0.2.0' })],
    ['log --format=%h%x09%s --max-count=30 HEAD..origin/stable', ''],
    ['merge-base --is-ancestor origin/stable HEAD', ''],
  ]));
  const result = await createUpdater({ root: checkout(), exec, env: {} }).check('stable');
  assert.equal(result.upToDate, true);
  assert.deepEqual(result.changes, []);
});

test('check lists what is new and allows installing a fast-forward', async () => {
  const { exec, calls } = fakeGit(base([
    ['rev-parse origin/stable', 'bbbbbbb2222222222222222222222222222222222\n'],
    ['show origin/stable:package.json', JSON.stringify({ version: '0.3.0' })],
    ['log --format=%h%x09%s --max-count=30 HEAD..origin/stable', 'bbbbbbb\tSafer retries\nccccccc\tNew dashboard\n'],
    ['merge-base --is-ancestor origin/stable HEAD', gitFail('not ancestor')],
    ['rev-parse --verify --quiet refs/heads/stable', 'aaaaaaa1111111111111111111111111111111111\n'],
    ['merge-base --is-ancestor refs/heads/stable origin/stable', ''],
  ]));
  const result = await createUpdater({ root: checkout(), exec, env: {} }).check('stable');
  assert.equal(result.upToDate, false);
  assert.equal(result.available.version, '0.3.0');
  assert.equal(result.available.commit, 'bbbbbbb');
  assert.deepEqual(result.changes, [{ commit: 'bbbbbbb', subject: 'Safer retries' }, { commit: 'ccccccc', subject: 'New dashboard' }]);
  assert.equal(result.canInstall, true);
  assert.ok(calls.some(c => c.startsWith('fetch --quiet origin')), 'fetches before comparing');
});

test('local edits block installing and the manual command is offered', async () => {
  const { exec } = fakeGit([
    ['status --porcelain --untracked-files=no', ' M server.js\n'],
    ...base([
      ['rev-parse origin/latest', 'bbbbbbb2222222222222222222222222222222222\n'],
      ['show origin/latest:package.json', JSON.stringify({ version: '0.3.0' })],
      [/^log /, 'bbbbbbb\tSafer retries\n'],
      ['merge-base --is-ancestor origin/latest HEAD', gitFail('no')],
      ['rev-parse --verify --quiet refs/heads/latest', gitFail('missing')],
    ]),
  ]);
  const updater = createUpdater({ root: checkout(), exec, env: {} });
  const result = await updater.check('latest');
  assert.equal(result.canInstall, false);
  assert.equal(result.blockedReason, 'local_changes');
  assert.match(result.manualCommand, /git fetch origin/);
  assert.match(result.manualCommand, /latest/);
  await assert.rejects(updater.install('latest'), err => err.status === 409 && err.type === 'local_changes');
});

test('a local channel branch with its own commits is never overwritten', async () => {
  const { exec } = fakeGit(base([
    ['rev-parse origin/stable', 'bbbbbbb2222222222222222222222222222222222\n'],
    ['show origin/stable:package.json', JSON.stringify({ version: '0.3.0' })],
    [/^log /, 'bbbbbbb\tSafer retries\n'],
    ['merge-base --is-ancestor origin/stable HEAD', gitFail('no')],
    ['rev-parse --verify --quiet refs/heads/stable', 'ddddddd\n'],
    ['merge-base --is-ancestor refs/heads/stable origin/stable', gitFail('diverged')],
  ]));
  const result = await createUpdater({ root: checkout(), exec, env: {} }).check('stable');
  assert.equal(result.canInstall, false);
  assert.equal(result.blockedReason, 'diverged');
});

test('install fast-forwards an existing channel branch', async () => {
  const { exec, calls } = fakeGit(base([
    ['rev-parse origin/stable', 'bbbbbbb2222222222222222222222222222222222\n'],
    ['show origin/stable:package.json', JSON.stringify({ version: '0.3.0' })],
    [/^log /, 'bbbbbbb\tSafer retries\n'],
    ['merge-base --is-ancestor origin/stable HEAD', gitFail('no')],
    ['rev-parse --verify --quiet refs/heads/stable', 'aaaaaaa\n'],
    ['merge-base --is-ancestor refs/heads/stable origin/stable', ''],
    ['switch stable', ''],
    ['merge --ff-only origin/stable', ''],
  ]));
  const result = await createUpdater({ root: checkout(), exec, env: { FDSA_LAUNCHER: '1' } }).install('stable');
  assert.equal(result.installed.version, '0.3.0');
  assert.equal(result.restart, 'auto');
  const order = calls.filter(c => c === 'switch stable' || c === 'merge --ff-only origin/stable');
  assert.deepEqual(order, ['switch stable', 'merge --ff-only origin/stable']);
  assert.ok(!calls.some(c => /reset|--force|-B /.test(c)), 'never resets or forces');
});

test('install creates a tracking branch when switching to a new channel', async () => {
  const { exec, calls } = fakeGit(base([
    ['rev-parse origin/latest', 'bbbbbbb2222222222222222222222222222222222\n'],
    ['show origin/latest:package.json', JSON.stringify({ version: '0.3.0' })],
    [/^log /, 'bbbbbbb\tSafer retries\n'],
    ['merge-base --is-ancestor origin/latest HEAD', gitFail('no')],
    ['rev-parse --verify --quiet refs/heads/latest', gitFail('missing')],
    ['switch -c latest --track origin/latest', ''],
  ]));
  await createUpdater({ root: checkout(), exec, env: {} }).install('latest');
  assert.ok(calls.includes('switch -c latest --track origin/latest'));
});

test('the launcher restarts the server after exit code 75 and stops on any other code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsa-launch-'));
  const counter = path.join(dir, 'runs');
  const entry = path.join(dir, 'fake-server.js');
  fs.writeFileSync(entry, `
    const fs = require('fs');
    const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1;
    fs.writeFileSync(${JSON.stringify(counter)}, String(n));
    process.stdout.write('run ' + n + ' launcher=' + process.env.FDSA_LAUNCHER + ' restarted=' + (process.env.FDSA_RESTARTED || '') + '\\n');
    process.exit(n === 1 ? ${RESTART_EXIT_CODE} : 3);
  `);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'start.js')], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, FDSA_SERVER_ENTRY: entry }, timeout: 20000,
  });
  assert.equal(fs.readFileSync(counter, 'utf8'), '2');
  assert.match(res.stdout, /run 1 launcher=1 restarted=\n/);
  assert.match(res.stdout, /run 2 launcher=1 restarted=1\n/);
  assert.equal(res.status, 3, 'exits with the server\'s own code');
});

test('with real git: check sees a new release, install fast-forwards and switches channels, local edits are kept', async (t) => {
  const has = spawnSync('git', ['--version']);
  if (has.status !== 0) { t.skip('git is not installed'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsa-git-'));
  const g = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = path.join(tmp, 'origin.git');
  const dev = path.join(tmp, 'dev');
  const user = path.join(tmp, 'user');
  g(tmp, 'init', '--bare', origin);
  g(tmp, 'clone', origin, dev);
  fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  g(dev, 'add', '.'); g(dev, 'commit', '-m', 'Release 0.2.0');
  g(dev, 'push', 'origin', 'HEAD:main', 'HEAD:stable', 'HEAD:latest');
  g(tmp, 'clone', '--branch', 'stable', origin, user);

  const updater = createUpdater({ root: user, env: {} });
  assert.equal((await updater.check('stable')).upToDate, true);

  fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  g(dev, 'commit', '-am', 'Safer retries');
  g(dev, 'push', 'origin', 'HEAD:main', 'HEAD:latest');

  const onLatest = await updater.check('latest');
  assert.equal(onLatest.upToDate, false);
  assert.equal(onLatest.available.version, '0.3.0');
  assert.deepEqual(onLatest.changes.map(c => c.subject), ['Safer retries']);
  assert.equal(onLatest.canInstall, true);

  // A local edit to a tracked file blocks the install and survives it.
  fs.writeFileSync(path.join(user, 'package.json'), JSON.stringify({ version: '0.2.0', mine: true }));
  await assert.rejects(updater.install('latest'), err => err.type === 'local_changes');
  assert.match(fs.readFileSync(path.join(user, 'package.json'), 'utf8'), /"mine":true/);
  g(user, 'checkout', '--', 'package.json');

  const done = await updater.install('latest');
  assert.equal(done.installed.version, '0.3.0');
  assert.equal(g(user, 'rev-parse', '--abbrev-ref', 'HEAD'), 'latest');
  assert.equal(JSON.parse(fs.readFileSync(path.join(user, 'package.json'), 'utf8')).version, '0.3.0');
  assert.equal((await updater.status()).channel, 'latest');
  assert.equal((await updater.check('latest')).upToDate, true);
});
