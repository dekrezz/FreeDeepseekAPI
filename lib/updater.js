'use strict';

// Self-update for a git checkout of FreeDeepseekAPI.
//
// Two channels are branches on origin: `latest` gets every release, `stable` gets a
// release once the maintainer has promoted it. An update only ever fast-forwards:
// local edits, a channel branch with its own commits, or a copy without .git block the
// install and the caller gets the command to run by hand instead. Nothing is reset.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CHANNELS = ['stable', 'latest'];
// Exit code that asks scripts/start.js to start the server again (EX_TEMPFAIL).
const RESTART_EXIT_CODE = 75;
const GIT_TIMEOUT_MS = 60000;
const MAX_CHANGES = 30;

function updateError(status, type, message) {
    return Object.assign(new Error(message), { status, type });
}

function runGit(root) {
    return (args) => new Promise((resolve, reject) => {
        execFile('git', args, { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const detail = String(stderr || err.message || '').trim();
                return reject(Object.assign(new Error(`git ${args.join(' ')} failed: ${detail}`), { code: err.code }));
            }
            resolve(String(stdout));
        });
    });
}

function readVersion(root) {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch (e) { return null; }
}

function manualCommand(channel) {
    return `git fetch origin && git switch ${channel} && git merge --ff-only origin/${channel}`;
}

function createUpdater({ root, exec = runGit(root), env = process.env } = {}) {
    const git = (...args) => exec(args);
    const ok = async (...args) => { try { await git(...args); return true; } catch (e) { return false; } };
    const restart = env.FDSA_LAUNCHER === '1' ? 'auto' : 'manual';
    const isCheckout = () => fs.existsSync(path.join(root, '.git'));

    function requireChannel(channel) {
        if (!CHANNELS.includes(channel)) {
            throw updateError(400, 'invalid_channel', `Unknown update channel ${JSON.stringify(channel)}. Use ${CHANNELS.join(' or ')}.`);
        }
    }

    async function status() {
        const version = readVersion(root);
        if (!isCheckout()) {
            return { version, commit: null, branch: null, channel: null, method: 'unavailable', reason: 'not_a_git_checkout', restart };
        }
        const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
        const commit = (await git('rev-parse', 'HEAD')).trim().slice(0, 7);
        return { version, commit, branch, channel: CHANNELS.includes(branch) ? branch : null, method: 'git', reason: null, restart };
    }

    async function check(channel) {
        requireChannel(channel);
        const current = await status();
        if (current.method !== 'git') {
            throw updateError(409, 'update_unavailable', 'This copy was not installed with git clone (a container image or a downloaded archive), so it cannot update itself. Pull a new image or download the new release.');
        }
        const remote = `origin/${channel}`;
        try {
            await git('fetch', '--quiet', 'origin', `+refs/heads/${channel}:refs/remotes/origin/${channel}`);
        } catch (e) {
            if (/couldn't find remote ref/i.test(e.message)) {
                throw updateError(404, 'channel_missing', `The ${channel} channel is not published on GitHub yet, so there is nothing to update to.`);
            }
            throw updateError(502, 'fetch_failed', `Could not reach GitHub to check for updates: ${e.message}`);
        }
        const remoteCommit = (await git('rev-parse', remote)).trim();
        let remoteVersion = null;
        try { remoteVersion = JSON.parse(await git('show', `${remote}:package.json`)).version || null; } catch (e) { remoteVersion = null; }
        const changes = (await git('log', '--format=%h%x09%s', `--max-count=${MAX_CHANGES}`, `HEAD..${remote}`))
            .split('\n').filter(Boolean).map((line) => {
                const tab = line.indexOf('\t');
                return { commit: line.slice(0, tab), subject: line.slice(tab + 1) };
            });
        // Up to date: already on this channel and nothing on it that HEAD lacks.
        const upToDate = current.channel === channel && await ok('merge-base', '--is-ancestor', remote, 'HEAD');

        let blockedReason = null;
        if ((await git('status', '--porcelain', '--untracked-files=no')).trim()) blockedReason = 'local_changes';
        else if (await ok('rev-parse', '--verify', '--quiet', `refs/heads/${channel}`)
            && !await ok('merge-base', '--is-ancestor', `refs/heads/${channel}`, remote)) blockedReason = 'diverged';

        return {
            channel,
            current: { version: current.version, commit: current.commit, channel: current.channel },
            available: { version: remoteVersion, commit: remoteCommit.slice(0, 7) },
            upToDate,
            changes,
            canInstall: !upToDate && !blockedReason,
            blockedReason: upToDate ? null : blockedReason,
            manualCommand: manualCommand(channel),
            restart,
        };
    }

    async function install(channel) {
        const result = await check(channel);
        if (result.upToDate) throw updateError(409, 'up_to_date', `Already on the newest ${channel} release.`);
        if (result.blockedReason === 'local_changes') {
            throw updateError(409, 'local_changes', `This copy has uncommitted changes to tracked files, so the update would overwrite them. Commit or stash them, or update by hand: ${result.manualCommand}`);
        }
        if (result.blockedReason === 'diverged') {
            throw updateError(409, 'diverged', `The local ${channel} branch has commits that are not on origin/${channel}, so it cannot be fast-forwarded. Update by hand after deciding what to keep.`);
        }
        if (await ok('rev-parse', '--verify', '--quiet', `refs/heads/${channel}`)) {
            await git('switch', channel);
            await git('merge', '--ff-only', `origin/${channel}`);
        } else {
            await git('switch', '-c', channel, '--track', `origin/${channel}`);
        }
        return { installed: { version: result.available.version || readVersion(root), commit: result.available.commit, channel }, restart };
    }

    return { status, check, install };
}

module.exports = { createUpdater, CHANNELS, RESTART_EXIT_CODE, manualCommand };
