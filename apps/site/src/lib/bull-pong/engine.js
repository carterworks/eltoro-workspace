// Bull Pong — pure simulation engine.
//
// No DOM, no canvas, no globals: everything lives in a state object so the
// same code can run in a browser (AI mode + authoritative host) and in Node
// (tests). One `step()` call advances exactly one 60 Hz frame, which is the
// unit the original single-player artifact was tuned against.

export const W = 900;
export const H = 560;

export const PADDLE_W = 14;
export const BASE_PADDLE_H = 92;
export const WIDE_PADDLE_H = BASE_PADDLE_H * 1.6;
export const PADDLE_SPEED = 6.2;
export const BALL_R = 20;
export const WIN_SCORE = 7;
export const PEN = 22; // playfield inset — keeps the bull inside the pen rails
export const FRAME_MS = 1000 / 60;

export const TYPES = {
	horns: { glyph: '♉', color: '#d4a24e', label: 'HORNS' },
	tranq: { glyph: '❄', color: '#7cc4e8', label: 'TRANQ' },
	rage: { glyph: '🔥', color: '#c1483b', label: 'RAGE' },
	herd: { glyph: '🐄', color: '#b08850', label: 'HERD' },
	fence: { glyph: '🚧', color: '#e8c547', label: 'FENCE' },
};

/** Mulberry32 — small seeded PRNG so a host's match can be replayed in tests. */
export function createRng(seed = 1) {
	let a = seed >>> 0;
	return function rng() {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makePaddle(x) {
	return { x, y: H / 2 - BASE_PADDLE_H / 2, h: BASE_PADDLE_H, score: 0, up: false, down: false, touchY: null };
}

export function createState(seed = 1) {
	return {
		now: 0,
		seq: 0,
		rng: createRng(seed),
		left: makePaddle(34),
		right: makePaddle(W - 34 - PADDLE_W),
		balls: [],
		powerups: [],
		toasts: [],
		lastTouch: null,
		winner: null,
		fx: { slowUntil: 0, rageUntil: 0 },
		side: { left: { wideUntil: 0, fence: false }, right: { wideUntil: 0, fence: false } },
		nextSpawnAt: 0,
	};
}

function clampPaddle(p) {
	p.y = Math.max(PEN, Math.min(H - p.h - PEN, p.y));
}

function makeBall(state, dir, extra = false, deadline = 0) {
	const angle = state.rng() * 0.6 - 0.3; // -0.3..0.3 rad
	const speed = 7.4;
	return {
		x: W / 2,
		y: H / 2,
		vx: Math.cos(angle) * speed * dir,
		vy: Math.sin(angle) * speed,
		speed,
		spin: 0,
		rot: 0,
		extra,
		deadline,
	};
}

export function resetMatch(state) {
	state.left.score = 0;
	state.right.score = 0;
	state.left.h = BASE_PADDLE_H;
	state.right.h = BASE_PADDLE_H;
	state.winner = null;
	state.balls = [makeBall(state, state.rng() < 0.5 ? 1 : -1)];
	state.powerups = [];
	state.toasts = [];
	state.lastTouch = null;
	state.fx.slowUntil = 0;
	state.fx.rageUntil = 0;
	state.side.left.wideUntil = 0;
	state.side.left.fence = false;
	state.side.right.wideUntil = 0;
	state.side.right.fence = false;
	state.nextSpawnAt = state.now + 5000;
	state.seq++;
}

export function toast(state, text, color = '#e8e2d6') {
	state.toasts.push({ text, color, t0: state.now });
	if (state.toasts.length > 4) state.toasts.shift();
}

function movePaddle(p) {
	if (p.up) p.y -= PADDLE_SPEED;
	if (p.down) p.y += PADDLE_SPEED;
	clampPaddle(p);
}

function aiMove(state, p) {
	// chase the nearest incoming ball with a little laziness
	const incoming = state.balls.filter((b) => (p === state.left ? b.vx < 0 : b.vx > 0));
	const target0 = incoming.length
		? incoming.reduce((a, b) => (Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a))
		: state.balls[0];
	if (!target0) return;
	const target = target0.y - p.h / 2 + Math.sin(state.now / 500) * 14;
	const delta = target - p.y;
	p.y += Math.sign(delta) * Math.min(Math.abs(delta), PADDLE_SPEED * 0.82);
	clampPaddle(p);
}

function hitPaddle(state, b, p, dir) {
	const rel = (b.y - (p.y + p.h / 2)) / (p.h / 2); // -1..1
	const angle = rel * 0.9; // max ~51°
	b.speed = Math.min(b.speed * 1.05, 14); // ramp
	b.vx = Math.cos(angle) * b.speed * dir;
	b.vy = Math.sin(angle) * b.speed;
	b.spin = rel * 0.25;
	state.lastTouch = dir === 1 ? 'left' : 'right';
}

function trySpawn(state) {
	const keys = Object.keys(TYPES);
	for (let i = 0; i < 5; i++) {
		const x = W * 0.32 + state.rng() * W * 0.36;
		const y = 40 + state.rng() * (H - 80);
		if (state.balls.every((b) => Math.hypot(b.x - x, b.y - y) > 110)) {
			const type = keys[(state.rng() * keys.length) | 0];
			state.powerups.push({ x, y, r: 16, type, ...TYPES[type] });
			state.nextSpawnAt = state.now + 8000 + state.rng() * 5000;
			return;
		}
	}
	state.nextSpawnAt = state.now + 1500; // crowded — retry soon
}

function collect(state, pu) {
	const now = state.now;
	const who = state.lastTouch ?? (state.rng() < 0.5 ? 'left' : 'right');
	const name = who === 'right' ? 'YOU' : 'BULL';
	const s = state.side[who];
	if (pu.type === 'horns') {
		s.wideUntil = now + 8000;
		toast(state, `♉ LONG HORNS → ${name}`, pu.color);
	} else if (pu.type === 'tranq') {
		state.fx.slowUntil = now + 5000;
		state.fx.rageUntil = 0;
		toast(state, '❄ TRANQ DART — the bull slows down', pu.color);
	} else if (pu.type === 'rage') {
		state.fx.rageUntil = now + 5000;
		state.fx.slowUntil = 0;
		toast(state, '🔥 RAGE — the bull is furious', pu.color);
	} else if (pu.type === 'herd') {
		if (!state.balls.some((b) => b.extra)) {
			const dir = who === 'right' ? -1 : 1; // send it at the opponent
			state.balls.push(makeBall(state, dir, true, now + 14000));
			toast(state, `🐄 HERD — extra bull for ${name}`, pu.color);
		}
	} else if (pu.type === 'fence') {
		s.fence = true;
		toast(state, `🚧 FENCE → ${name}`, pu.color);
	}
}

function score(state, conceder, b) {
	const scorer = conceder === 'left' ? state.right : state.left;
	scorer.score++;
	const idx = state.balls.indexOf(b);
	if (idx >= 0) state.balls.splice(idx, 1);
	if (scorer.score >= WIN_SCORE) {
		state.winner = scorer === state.right ? 'right' : 'left';
		state.powerups = [];
		return;
	}
	if (!b.extra) state.balls.unshift(makeBall(state, conceder === 'left' ? 1 : -1));
}

/**
 * Advance one 60 Hz frame.
 * `inputs` selects what drives each paddle:
 *   { ai: 'left' | 'right' | 'both' | 'none', aim: { left?: y, right?: y } }
 * `aim` is a paddle centre in playfield pixels (used by network play / mouse).
 */
export function step(state, inputs = {}) {
	const now = state.now;
	if (state.winner) {
		state.seq++;
		return state;
	}

	// wide paddles decay
	state.left.h = now < state.side.left.wideUntil ? WIDE_PADDLE_H : BASE_PADDLE_H;
	state.right.h = now < state.side.right.wideUntil ? WIDE_PADDLE_H : BASE_PADDLE_H;

	const ai = inputs.ai ?? 'none';
	const aim = inputs.aim ?? {};

	for (const side of ['left', 'right']) {
		const p = state[side];
		if (ai === side || ai === 'both') {
			if (p.touchY != null) {
				p.y = p.touchY - p.h / 2;
				clampPaddle(p);
			} else {
				aiMove(state, p);
			}
		} else {
			if (p.touchY != null) {
				p.y = p.touchY - p.h / 2;
			} else {
				movePaddle(p);
			}
			clampPaddle(p);
		}
		if (aim[side] != null && !(ai === side || ai === 'both')) {
			p.y = aim[side] - p.h / 2;
			clampPaddle(p);
		}
	}

	// spawn powerups
	if (now > state.nextSpawnAt && state.powerups.length < 2) trySpawn(state);

	const speedMul = now < state.fx.rageUntil ? 1.35 : now < state.fx.slowUntil ? 0.55 : 1;

	for (const b of [...state.balls]) {
		// ease current speed toward target (ramp × powerup multiplier)
		const mag = Math.hypot(b.vx, b.vy) || 1;
		const cur = mag + (b.speed * speedMul - mag) * 0.12;
		b.vx = (b.vx / mag) * cur;
		b.vy = (b.vy / mag) * cur;

		b.x += b.vx;
		b.y += b.vy;

		// walls (inside the pen rails)
		if (b.y - BALL_R < PEN) {
			b.y = PEN + BALL_R;
			b.vy = Math.abs(b.vy);
		}
		if (b.y + BALL_R > H - PEN) {
			b.y = H - PEN - BALL_R;
			b.vy = -Math.abs(b.vy);
		}

		// paddles
		for (const [p, dir] of [
			[state.left, 1],
			[state.right, -1],
		]) {
			const inX =
				(dir === 1 && b.x - BALL_R < p.x + PADDLE_W && b.x > p.x) ||
				(dir === -1 && b.x + BALL_R > p.x && b.x < p.x + PADDLE_W);
			const inY = b.y + BALL_R > p.y && b.y - BALL_R < p.y + p.h;
			if (inX && inY && Math.sign(b.vx) !== dir) {
				b.x = dir === 1 ? p.x + PADDLE_W + BALL_R : p.x - BALL_R;
				hitPaddle(state, b, p, dir);
			}
		}

		// powerup pickup
		for (const pu of [...state.powerups]) {
			if (Math.hypot(b.x - pu.x, b.y - pu.y) < BALL_R + pu.r) {
				state.powerups.splice(state.powerups.indexOf(pu), 1);
				collect(state, pu);
			}
		}

		// goals (fences save once at the edge)
		if (b.vx < 0) {
			if (b.x - BALL_R < 2 && state.side.left.fence) {
				state.side.left.fence = false;
				b.x = BALL_R + 2;
				b.vx = Math.abs(b.vx);
				b.vy *= 0.5;
				toast(state, '🚧 FENCE SAVE', '#e8c547');
			} else if (b.x < -40) {
				score(state, 'left', b);
				continue;
			}
		} else if (b.vx > 0) {
			if (b.x + BALL_R > W - 2 && state.side.right.fence) {
				state.side.right.fence = false;
				b.x = W - BALL_R - 2;
				b.vx = -Math.abs(b.vx);
				b.vy *= 0.5;
				toast(state, '🚧 FENCE SAVE', '#e8c547');
			} else if (b.x > W + 40) {
				score(state, 'right', b);
				continue;
			}
		}
	}

	// herd bulls expire
	state.balls = state.balls.filter((b) => !b.extra || now < b.deadline);

	// spin the sprites + age the toasts (drawing reads these, so keep them here
	// and the guest renderer gets the same numbers over the wire)
	for (const b of state.balls) b.rot += 0.03 + b.spin;
	state.toasts = state.toasts.filter((t) => now - t.t0 < 1400);

	state.now += FRAME_MS;
	state.seq++;
	return state;
}

/** Remaining-effect snapshot: durations only, so guests never need clock sync. */
export function serialize(state) {
	return {
		n: state.seq,
		l: { y: r2(state.left.y), h: state.left.h, s: state.left.score },
		r: { y: r2(state.right.y), h: state.right.h, s: state.right.score },
		b: state.balls.map((b) => ({ x: r2(b.x), y: r2(b.y), rot: r2(b.rot), e: b.extra ? 1 : 0 })),
		p: state.powerups.map((p) => ({ x: r2(p.x), y: r2(p.y), t: p.type })),
		sloo: Math.max(0, state.fx.slowUntil - state.now) | 0,
		rage: Math.max(0, state.fx.rageUntil - state.now) | 0,
		wl: Math.max(0, state.side.left.wideUntil - state.now) | 0,
		wr: Math.max(0, state.side.right.wideUntil - state.now) | 0,
		fl: state.side.left.fence ? 1 : 0,
		fr: state.side.right.fence ? 1 : 0,
		tc: state.lastTouch,
		win: state.winner,
		t: state.toasts.map((t) => ({ x: t.text, c: t.color, a: (state.now - t.t0) | 0 })),
	};
}

/** Rebuild a render-ready state on the guest from a host snapshot. */
export function deserialize(snap, now = 0) {
	return {
		now,
		seq: snap.n,
		left: { x: 34, y: snap.l.y, h: snap.l.h, score: snap.l.s, up: false, down: false, touchY: null },
		right: {
			x: W - 34 - PADDLE_W,
			y: snap.r.y,
			h: snap.r.h,
			score: snap.r.s,
			up: false,
			down: false,
			touchY: null,
		},
		balls: snap.b.map((b) => ({ x: b.x, y: b.y, vx: 0, vy: 0, rot: b.rot, spin: 0, extra: !!b.e })),
		powerups: snap.p.map((p) => ({ x: p.x, y: p.y, r: 16, type: p.t, ...TYPES[p.t] })),
		fx: { slowUntil: now + snap.sloo, rageUntil: now + snap.rage },
		side: {
			left: { wideUntil: now + snap.wl, fence: !!snap.fl },
			right: { wideUntil: now + snap.wr, fence: !!snap.fr },
		},
		lastTouch: snap.tc,
		winner: snap.win,
		toasts: snap.t.map((t) => ({ text: t.x, color: t.c, t0: now - t.a })),
	};
}

function r2(n) {
	return Math.round(n * 100) / 100;
}
