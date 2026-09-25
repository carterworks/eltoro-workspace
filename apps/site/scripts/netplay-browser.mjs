#!/usr/bin/env node
// Real-browser ambient-netplay test: three Chromium contexts, no clicks, no codes.
//
//   1. the first visitor lands on the page and is already playing the bull
//   2. the second visitor is dropped into that match, taking the bull's paddle
//   3. the third visitor gets a pen of its own instead of stealing a paddle
//   4. when the second visitor leaves, the bull takes its horn back
//
//   python3 -m http.server 8899 --directory dist
//   node scripts/netplay-browser.mjs     # needs `playwright` + a browser
//
// Env: BASE (default below), PLAYWRIGHT_BROWSERS_PATH. Each client uses a
// private pen namespace (`?pen=`), so the test never disturbs live players.

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8899/artifacts/bull-pong/';
const PREFIX = `smoke${Math.floor(Math.random() * 9000 + 1000)}`.toLowerCase();
const PEN_URL = `${BASE}?pen=${PREFIX}`;
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
	const pages = {};
	for (const name of ['first', 'second', 'third']) {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		page.on('pageerror', (err) => errors.push(`${name}: ${err.message}`));
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(`${name} console: ${msg.text()}`);
		});
		pages[name] = { ctx, page };
	}
	const { first, second, third } = pages;

	// --- 1. first visitor: playing the bull before it even settles ------------
	await first.page.goto(PEN_URL, { waitUntil: 'load' });
	check('the page starts playing immediately', /playing the bull/.test(await first.page.evaluate(() => window.__bullpong.status)));
	await first.page.waitForFunction(() => window.__bullpong.networked && window.__bullpong.authority, null, { timeout: 20000 });
	const firstState = await state(first.page);
	check('the first visitor settles into a pen on its own', firstState.pen === 1 && firstState.authority === true, `pen ${firstState.pen}`);
	check('the bull holds the free horn', firstState.botSide === 'left' && firstState.localSide === 'right');
	check('the status line says the horn is up for grabs', /bull has the left horn/.test(firstState.status), firstState.status);
	check('no pen code is ever shown to the player', !/[A-Z0-9]{4}/.test(firstState.status.split('pen')[0] ?? ''), firstState.status);

	// --- 2. second visitor: dropped into the live match, taking the bull's paddle
	await second.page.goto(PEN_URL, { waitUntil: 'load' });
	await second.page.waitForFunction(() => window.__bullpong.networked && !window.__bullpong.authority, null, { timeout: 25000 });
	const secondState = await state(second.page);
	check('the second visitor lands in the same pen', secondState.pen === firstState.pen, `pen ${secondState.pen}`);
	check('it takes the bull paddle (left horn)', secondState.localSide === 'left');
	await second.page.waitForFunction(() => /dropped into pen/.test(window.__bullpong.status), null, { timeout: 20000 });
	check('and the status line says so', true, (await state(second.page)).status);

	await first.page.waitForFunction(() => window.__bullpong.peers === 2, null, { timeout: 20000 });
	await first.page.waitForFunction(() => window.__bullpong.botSide === null, null, { timeout: 20000 });
	check('the bull is off the field: two humans now', (await state(first.page)).botSide === null);

	// --- 3. inputs cross the wire, both directions ----------------------------
	const beforeKeys = (await state(first.page)).snapshot.left.y;
	for (let i = 0; i < 20; i++) await second.page.keyboard.press('ArrowDown');
	await sleep(900);
	const afterKeys = (await state(first.page)).snapshot.left.y;
	check(
		'the second visitor steers the paddle the bull used to hold',
		afterKeys > beforeKeys + 60,
		`authority left.y ${beforeKeys.toFixed(0)} -> ${afterKeys.toFixed(0)}`,
	);

	await first.page.locator('#game').scrollIntoViewIfNeeded();
	const box = await first.page.locator('#game').boundingBox();
	await first.page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.15);
	await sleep(900);
	const remote = (await state(second.page)).snapshot.right;
	check('the first visitor paddle shows up on the second screen', remote.y < 140, `remote right.y ${remote.y.toFixed(0)}`);

	const scoresA = (await state(first.page)).snapshot;
	const scoresB = (await state(second.page)).snapshot;
	check(
		'both players score the same match',
		scoresA.left.score === scoresB.left.score && scoresA.right.score === scoresB.right.score,
		`first ${scoresA.left.score}-${scoresA.right.score} / second ${scoresB.left.score}-${scoresB.right.score}`,
	);
	await second.page.waitForFunction(() => window.__bullpong.seq > 20, null, { timeout: 20000 });
	check('the second player is rendering relayed snapshots', true, `seq ${await second.page.evaluate(() => window.__bullpong.seq)}`);

	// --- 4. a third visitor gets its own pen, not someone's paddle ------------
	await third.page.goto(PEN_URL, { waitUntil: 'load' });
	await third.page.waitForFunction(() => window.__bullpong.networked, null, { timeout: 25000 });
	const thirdState = await state(third.page);
	check('the third visitor opens another pen', thirdState.pen !== firstState.pen && thirdState.authority === true, `pen ${thirdState.pen}`);
	check('and keeps playing the bull while it is alone', thirdState.botSide !== null);
	check('the first pen is untouched by it', (await state(first.page)).peers === 2);

	// --- 5. the second visitor leaves: the bull takes its horn back -----------
	await second.page.close();
	await second.ctx.close();
	await first.page.waitForFunction(() => window.__bullpong.botSide !== null, null, { timeout: 15000 });
	const afterLeave = await state(first.page);
	check('the bull returns to the abandoned horn', afterLeave.botSide === 'left', `bot on ${afterLeave.botSide}`);
	check('and the status line goes back to offering it', /bull has the left horn/.test(afterLeave.status), afterLeave.status);

	check('no page errors in any pen', errors.length === 0, errors.join(' | ') || 'clean console');

	console.log(`\n${passed} browser checks passed for ambient netplay (prefix ${PREFIX}).`);
} catch (err) {
	console.error(`\n✖ browser ambient-netplay test failed: ${err.message}`);
	if (errors.length) console.error(`  page errors: ${errors.join(' | ')}`);
	exitCode = 1;
} finally {
	await browser.close();
	process.exit(exitCode);
}
