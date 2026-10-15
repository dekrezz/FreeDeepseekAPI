#!/usr/bin/env node
'use strict';

// Runs server.js and starts it again when it exits with RESTART_EXIT_CODE (after the
// dashboard installed an update). Any other exit ends the launcher with that code.
// The child shares this terminal, so Ctrl-C reaches it directly.

const path = require('path');
const { spawn } = require('child_process');
const { RESTART_EXIT_CODE } = require('../lib/updater');

const entry = process.env.FDSA_SERVER_ENTRY || path.join(__dirname, '..', 'server.js');
const args = process.argv.slice(2);
const QUICK_RUN_MS = 5000;
const MAX_QUICK_RESTARTS = 5;
let restarts = 0;
let quickRestarts = 0;
let stopping = false;
let child = null;

function run() {
    const env = { ...process.env, FDSA_LAUNCHER: '1' };
    // A restart skips the start menu and does not open another browser tab.
    if (restarts > 0) Object.assign(env, { FDSA_RESTARTED: '1', SKIP_ACCOUNT_MENU: '1' });
    const startedAt = Date.now();
    child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env, windowsHide: true });
    child.on('error', (err) => {
        console.error(`[launcher] Could not start ${entry}: ${err.message}`);
        process.exit(1);
    });
    child.on('exit', (code, signal) => {
        if (code === RESTART_EXIT_CODE && !stopping) {
            restarts += 1;
            quickRestarts = Date.now() - startedAt < QUICK_RUN_MS ? quickRestarts + 1 : 0;
            if (quickRestarts >= MAX_QUICK_RESTARTS) {
                console.error(`[launcher] ${entry} exited with the restart code ${quickRestarts} times in a row within ${QUICK_RUN_MS / 1000}s of starting; giving up.`);
                process.exit(1);
            }
            console.log('[launcher] Restarting with the update…');
            run();
            return;
        }
        process.exit(signal ? 1 : (code == null ? 1 : code));
    });
}

// Pass stop signals on (kill, systemd) and wait for the server to exit with its own code.
// A Ctrl-C reaches the server twice that way, which its shutdown handler tolerates.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopping = true; if (child && child.exitCode === null) child.kill(sig); });

run();
