import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	W,
	H,
	PEN,
	BASE_PADDLE_H,
	WIDE_PADDLE_H,
	BALL_R,
	WIN_SCORE,
	FRAME_MS,
	createState,
	resetMatch,
	step,
	serialize,
	deserialize,
} from '../src/lib/bull-pong/engine.js';

function ball(state, over = {}) {
	return { x: W / 2, y: H / 2, vx: 7, vy: 0, speed: 7.4, spin: 0, rot: 0, extra: false, deadline: 0, ...over };
}

function fresh() {
	const s = createState(42);
	resetMatch(s);
	return s;
}

test('a fresh match serves one bull toward a random side', () => {
	const s = fresh();
	assert.equal(s.balls.length, 1);
	assert.equal(s.left.score, 0);
	assert.equal(s.right.score, 0);
	assert.equal(s.winner, null);
	assert.ok(Math.abs(s.balls[0].vx) > 5, 'ball travels horizontally');
});

test('the clock advances one 60 Hz frame per step', () => {
	const s = fresh();
	step(s, { ai: 'none' });
	assert.equal(Math.round(s.now), Math.round(FRAME_MS));
	assert.equal(s.seq, 2); // reset + step
});

test('a bull that leaves the left edge scores for the right paddle and re-serves', () => {
	const s = fresh();
	s.balls = [ball(s, { x: -45, vx: -7 })];
	step(s, { ai: 'none' });
	assert.equal(s.right.score, 1);
	assert.equal(s.balls.length, 1, 'a replacement bull is served');
});

test('a bull that leaves the right edge scores for the left paddle', () => {
	const s = fresh();
	s.balls = [ball(s, { x: W + 45, vx: 7 })];
	step(s, { ai: 'none' });
	assert.equal(s.left.score, 1);
});

test(`first to ${WIN_SCORE} wins and stops the match`, () => {
	const s = fresh();
	for (let i = 0; i < WIN_SCORE; i++) {
		s.balls = [ball(s, { x: W + 45, vx: 7 })];
		step(s, { ai: 'none' });
	}
	assert.equal(s.left.score, WIN_SCORE);
	assert.equal(s.winner, 'left');
	const frozenScore = s.left.score;
	s.balls = [ball(s, { x: W + 45, vx: 7 })];
	step(s, { ai: 'none' });
	assert.equal(s.left.score, frozenScore, 'no more scoring after the win');
});

test('extra herd bulls expire but normal bulls do not', () => {
	const s = fresh();
	s.balls = [ball(s, { extra: true, deadline: s.now - 1 }), ball(s)];
	step(s, { ai: 'none' });
	assert.equal(s.balls.length, 1);
	assert.equal(s.balls[0].extra, false);
});

test('horns widen the collecting side for ~8s', () => {
	const s = fresh();
	s.lastTouch = 'right';
	s.powerups = [{ x: W / 2, y: H / 2, r: 16, type: 'horns' }];
	s.balls = [ball(s, { x: W / 2, y: H / 2 })];
	step(s, { ai: 'none' });
	assert.equal(s.powerups.length, 0, 'the bull ate the pickup');
	assert.ok(s.side.right.wideUntil > s.now);
	step(s, { ai: 'none' });
	assert.equal(s.right.h, WIDE_PADDLE_H, 'wide paddle applies on the next frame');
});

test('tranq and rage are mutually exclusive bull moods', () => {
	const s = fresh();
	s.balls = [ball(s, { x: W / 2, y: H / 2 })];
	s.powerups = [{ x: W / 2, y: H / 2, r: 16, type: 'tranq' }];
	step(s, { ai: 'none' });
	assert.ok(s.fx.slowUntil > s.now);
	s.powerups = [{ x: W / 2, y: H / 2, r: 16, type: 'rage' }];
	s.balls = [ball(s, { x: W / 2, y: H / 2 })];
	step(s, { ai: 'none' });
	assert.ok(s.fx.rageUntil > s.now);
	assert.equal(s.fx.slowUntil, 0, 'rage cancels tranq');
});

test('a fence saves a goal once and then shatters', () => {
	const s = fresh();
	s.side.left.fence = true;
	s.balls = [ball(s, { x: BALL_R / 2, vx: -8 })];
	step(s, { ai: 'none' });
	assert.equal(s.left.score, 0, 'the goal was saved');
	assert.equal(s.side.left.fence, false, 'the fence shattered');
	assert.ok(s.balls[0].vx > 0, 'the bull was sent back into the pen');
	assert.ok(s.toasts.some((t) => t.text.includes('FENCE SAVE')));
});

test('powerups never spawn while two are already on the field', () => {
	const s = fresh();
	s.nextSpawnAt = 0;
	s.powerups = [
		{ x: 300, y: 100, r: 16, type: 'horns' },
		{ x: 400, y: 400, r: 16, type: 'rage' },
	];
	step(s, { ai: 'none' });
	assert.equal(s.powerups.length, 2);
});

test('a paddle is clamped inside the bull-pen rails', () => {
	const s = fresh();
	s.right.touchY = -500;
	step(s, { ai: 'none' });
	assert.equal(s.right.y, PEN);
	s.right.touchY = H + 500;
	step(s, { ai: 'none' });
	assert.equal(s.right.y, H - s.right.h - PEN);
});

test('the AI chases the nearest incoming bull', () => {
	const s = fresh();
	s.balls = [ball(s, { x: 600, y: 90, vx: -7, vy: 0 })];
	const before = Math.abs(s.left.y + s.left.h / 2 - (90 + 28)); // + wobble headroom
	for (let i = 0; i < 30; i++) step(s, { ai: 'left' });
	const after = Math.abs(s.left.y + s.left.h / 2 - s.balls[0].y);
	assert.ok(after < before, `AI closed the gap (${before.toFixed(1)} -> ${after.toFixed(1)})`);
});

test('snapshots round-trip: scores, effects, toasts and paddles survive the wire', () => {
	const s = fresh();
	s.lastTouch = 'right';
	s.powerups = [{ x: W / 2, y: H / 2, r: 16, type: 'fence' }];
	s.balls = [ball(s, { x: W / 2, y: H / 2 })];
	step(s, { ai: 'none' });
	s.left.score = 3;
	s.right.score = 5;
	const snap = serialize(s);
	const peer = deserialize(snap, 1000);

	assert.equal(peer.left.score, 3);
	assert.equal(peer.right.score, 5);
	assert.equal(peer.balls.length, 1);
	assert.equal(peer.powerups.length, 0);
	assert.equal(peer.left.h, s.left.h);
	assert.equal(peer.side.right.fence, true, 'the fence the bull collected shows for the guest');
	const snap2 = JSON.parse(JSON.stringify(snap));
	assert.ok(snap2.sloo >= 0 && snap2.rage >= 0 && snap2.wl >= 0 && snap2.wr >= 0);
});

test('snapshot payloads stay small enough for a 25 Hz feed', () => {
	const s = fresh();
	const bytes = Buffer.byteLength(JSON.stringify(serialize(s)));
	assert.ok(bytes < 700, `snapshot is ${bytes} bytes`);
});
