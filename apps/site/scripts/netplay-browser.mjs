#!/usr/bin/env node
// Real-browser netplay test: two Chromium contexts play a match through the
// live relay, driven by the page's own `window.__bullpong` hook.
//
//   playwright install chromium           # or bring your own browser
//   node scripts/netplay-browser.mjs
//
// Env: BASE (default the local preview below), PLAYWRIGHT_BROWSERS_PATH.
// Needs a built site served locally:  python3 -m http.server 8899 --directory dist
// On NixOS, `nix build nixpkgs#playwright-driver.browsers` plus a matching
// `npm i playwright@<same version>` gives a browser the sandbox can run.
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8899/artifacts/bull-pong/';
let passed = 0;
const errors = [];

function check(label, ok, detail = '') {
	if (ok) {
		passed++;
		console.log(`✔ ${label}${detail ? ` — ${detail}` : ''}`);
	} else {
		console.error(`✖ ${label}${detail ? ` — ${detail}` : ''}`);
		throw new Error(label);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (page) => page.evaluate(() => ({ ...window.__bullpong, snapshot: window.__bullpong.snapshot }));

const browser = await chromium.launch();
let exitCode = 0;

try {
	const hostCtx = await browser.newContext();
	const guestCtx = await browser.newContext();
	const host = await hostCtx.newPage();
	const guest = await guestCtx.newPage();
	for (const [name, page] of [
		['host', host],
		['guest', guest],
	]) {
		page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(`${name} console: ${msg.text()}`);
		});
	}

	await host.goto(BASE, { waitUntil: 'load' });
	check('page loads with no AI-mode errors yet', (await host.evaluate(() => window.__bullpong.mode)) === 'ai');

	// --- host creates a room ---------------------------------------------------
	await host.click('#btn-host');
	await host.waitForFunction(() => window.__bullpong.mode === 'host' && !!window.__bullpong.room, null, { timeout: 15000 });
	const code = await host.evaluate(() => window.__bullpong.room);
	check('host creates a room and shows a code', /^[A-Z0-9]{4}$/.test(code), `code ${code}`);
	await host.waitForFunction(() => window.__bullpong.relayUp === true, null, { timeout: 20000 });
	check('host is connected to the relay', true);
	check(
		'host waits for an opponent with a share link',
		(await host.evaluate(() => window.__bullpong.status)).includes(`${BASE}?room=${code}`),
	);

	// --- guest joins by code ---------------------------------------------------
	await guest.goto(`${BASE}?room=${code}`, { waitUntil: 'load' });
	await guest.waitForFunction(() => window.__bullpong.mode === 'guest', null, { timeout: 15000 });
	await host.waitForFunction(() => window.__bullpong.peers === 2, null, { timeout: 20000 });
	await guest.waitForFunction(() => window.__bullpong.peers === 2, null, { timeout: 20000 });
	check('both clients see each other in the room', true);
	await guest.waitForFunction(() => window.__bullpong.relayUp === true, null, { timeout: 20000 });
	check('guest is connected to the relay', true);

	await host.waitForFunction(() => window.__bullpong.status.includes('in the pen'), null, { timeout: 20000 });
	await guest.waitForFunction(() => window.__bullpong.status.includes('in the pen'), null, { timeout: 20000 });
	check('both sides report a live match', true, await host.evaluate(() => window.__bullpong.status));

	await guest.waitForFunction(() => window.__bullpong.seq > 0, null, { timeout: 20000 });
	check('guest receives host snapshots', true, `seq ${await guest.evaluate(() => window.__bullpong.seq)}`);

	// --- guest paddle -> host (keyboard) ---------------------------------------
	const hostBefore = (await state(host)).snapshot.left.y;
	for (let i = 0; i < 20; i++) await guest.keyboard.press('ArrowDown');
	await sleep(700);
	const hostAfterKeys = (await state(host)).snapshot.left.y;
	check(
		'guest paddle input (keys) moves the host-side left paddle',
		hostAfterKeys > hostBefore + 60,
		`left.y ${hostBefore.toFixed(0)} -> ${hostAfterKeys.toFixed(0)}`,
	);

	// --- guest paddle -> host (mouse) -----------------------------------------
	await guest.locator('#game').scrollIntoViewIfNeeded();
	const guestBox = await guest.locator('#game').boundingBox();
	const guestViewY = await guest.evaluate(() => window.innerHeight);
	const targetY = guestBox.y + Math.min(guestBox.height * 0.85, guestViewY - guestBox.y - 20);
	await guest.mouse.move(guestBox.x + guestBox.width * 0.5, targetY);
	await sleep(700);
	const hostAfterMouse = (await state(host)).snapshot.left.y;
	check(
		'guest paddle input (mouse) moves the host-side left paddle',
		hostAfterMouse > hostAfterKeys + 40,
		`left.y ${hostAfterKeys.toFixed(0)} -> ${hostAfterMouse.toFixed(0)}`,
	);

	// --- host paddle -> guest --------------------------------------------------
	await host.locator('#game').scrollIntoViewIfNeeded();
	const hostBox = await host.locator('#game').boundingBox();
	await host.mouse.move(hostBox.x + hostBox.width * 0.5, hostBox.y + hostBox.height * 0.15);
	await sleep(700);
	const guestView = (await state(guest)).snapshot;
	check(
		'host paddle moves the guest-side view of the right paddle',
		guestView.right.y < 140,
		`guest right.y ${guestView.right.y.toFixed(0)}`,
	);

	// --- the two views agree ---------------------------------------------------
	const hostView = (await state(host)).snapshot;
	check(
		'scores agree on both screens',
		hostView.left.score === guestView.left.score && hostView.right.score === guestView.right.score,
		`host ${hostView.left.score}-${hostView.right.score} / guest ${guestView.left.score}-${guestView.right.score}`,
	);
	// the guest renders from relayed snapshots, so its bull trails the host by the
	// relay latency — check it sits on the host's recent path (not frozen, not
	// somewhere else on the field)
	const trail = [];
	for (let i = 0; i < 12; i++) {
		trail.push((await state(host)).snapshot.balls[0]);
		await sleep(60);
	}
	const guestBall = (await state(guest)).snapshot.balls[0];
	const nearest = Math.min(...trail.map((b) => Math.hypot(b.x - guestBall.x, b.y - guestBall.y)));
	check(
		'the bull is on the same path for both players',
		nearest < 70,
		`guest (${guestBall.x},${guestBall.y}) is ${nearest.toFixed(0)}px from the host's recent path`,
	);
	const guestBall2 = await guest.evaluate(async () => {
		const a = window.__bullpong.snapshot.balls[0];
		await new Promise((r) => setTimeout(r, 150));
		const b = window.__bullpong.snapshot.balls[0];
		return { moved: Math.hypot(b.x - a.x, b.y - a.y) };
	});
	check('the guest view is actually animating', guestBall2.moved > 5, `bull moved ${guestBall2.moved.toFixed(0)}px in 150ms`);

	// --- a spectator is not seated --------------------------------------------
	const specCtx = await browser.newContext();
	const spectator = await specCtx.newPage();
	spectator.on('pageerror', (err) => errors.push(`spectator: ${err.message}`));
	await spectator.goto(`${BASE}?room=${code}`, { waitUntil: 'load' });
	await spectator.waitForFunction(() => window.__bullpong.mode === 'guest', null, { timeout: 15000 });
	await spectator.waitForFunction(() => window.__bullpong.status.includes('spectating'), null, { timeout: 20000 });
	check('a third player is told they are spectating', true, await spectator.evaluate(() => window.__bullpong.status));
	const hostPaddleBefore = (await state(host)).snapshot.left.y;
	await spectator.locator('#game').scrollIntoViewIfNeeded();
	const specBox = await spectator.locator('#game').boundingBox();
	const specViewY = await spectator.evaluate(() => window.innerHeight);
	await spectator.mouse.move(
		specBox.x + specBox.width * 0.5,
		specBox.y + Math.min(specBox.height * 0.15, specViewY - specBox.y - 20),
	);
	await sleep(700);
	const hostPaddleAfter = (await state(host)).snapshot.left.y;
	check(
		'a spectator cannot steer the seated guest paddle',
		Math.abs(hostPaddleAfter - hostPaddleBefore) < 5,
		`left.y ${hostPaddleBefore.toFixed(0)} -> ${hostPaddleAfter.toFixed(0)}`,
	);

	// --- leaving frees the seat ------------------------------------------------
	await spectator.close();
	await specCtx.close();
	await guest.close();
	await host.waitForFunction(() => window.__bullpong.status.includes('waiting for an opponent'), null, { timeout: 30000 });
	check('the host goes back to waiting when the guest leaves', true);

	check('no page errors in any client', errors.length === 0, errors.join(' | ') || 'clean console');

	console.log(`\n${passed} browser netplay checks passed against ${BASE} (room ${code}).`);
} catch (err) {
	console.error(`\n✖ browser netplay test failed: ${err.message}`);
	if (errors.length) console.error(`  page errors: ${errors.join(' | ')}`);
	exitCode = 1;
} finally {
	await browser.close();
	process.exit(exitCode);
}
