#!/usr/bin/env node
// Live netplay smoke test — two real clients through the real relay.
//
//   pnpm --filter apps-site test:live
//
// Host and guest are plain Node clients using the same modules the page uses
// (`src/lib/bull-pong/*`), so this exercises the actual protocol: awareness
// handshake, seating, host snapshots, guest paddle input, rematch requests,
// and cleanup when someone leaves. Needs network access to the relay; exits
// non-zero on the first failed expectation.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import {
	RELAY_URL,
	normalizeCode,
	roomName,
	resolveRoom,
	acceptSnapshot,
	describeRoom,
} from '../src/lib/bull-pong/netcode.js';
import { createState, resetMatch, step, serialize, deserialize } from '../src/lib/bull-pong/engine.js';

const ROOM = `SMOKE${Math.floor(Math.random() * 900 + 100)}`;
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT ?? 25000);
const SNAPSHOT_HZ = 25;
let passed = 0;

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

async function waitFor(fn, { timeout = TIMEOUT, step: stepMs = 100, label = 'condition' } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value) return value;
		await sleep(stepMs);
	}
	throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
}

const host = { doc: new Y.Doc() };
host.provider = new WebsocketProvider(RELAY_URL, roomName(ROOM), host.doc, { connect: true, disableBc: true });
const guest = { doc: new Y.Doc() };
guest.provider = new WebsocketProvider(RELAY_URL, roomName(ROOM), guest.doc, { connect: true, disableBc: true });

let exitCode = 0;

try {
	host.provider.awareness.setLocalState({ r: 'host' });
	guest.provider.awareness.setLocalState({ r: 'guest' });

	await waitFor(
		() => (host.provider.wsconnected || host.provider.connected) && (guest.provider.wsconnected || guest.provider.connected),
		{ label: `both clients to reach ${RELAY_URL}` },
	);
	check('both clients connect to the relay', true, RELAY_URL);

	const states = await waitFor(
		() => {
			const hostStates = host.provider.awareness.getStates();
			const guestStates = guest.provider.awareness.getStates();
			return hostStates.size > 1 && guestStates.size > 1 ? { hostStates, guestStates } : null;
		},
		{ label: 'awareness exchange' },
	);
	check('the two clients see each other in the room', states.hostStates.size === 2 && states.guestStates.size === 2);

	const hostView = resolveRoom(states.hostStates, host.provider.awareness.clientID);
	const guestView = resolveRoom(states.guestStates, guest.provider.awareness.clientID);
	check(
		'host and guest agree on the seating',
		hostView.selfIsHost && guestView.selfIsGuest && hostView.guestId != null && hostView.guestId === guestView.guestId,
		`host=${hostView.hostId} guest=${hostView.guestId}`,
	);
	const line = describeRoom({ mode: 'host', room: ROOM, picture: hostView, relayUp: true });
	check('the room reads as ready to play', line.includes('opponent in the pen'), line);

	// --- guest -> host paddle input -------------------------------------------
	const state = createState(7);
	resetMatch(state);
	guest.provider.awareness.setLocalStateField('i', { y: 120 });
	const guestY = await waitFor(
		() => {
			const guestState = host.provider.awareness.getStates().get(hostView.guestId);
			return Number(guestState?.i?.y) === 120 ? 120 : null;
		},
		{ label: 'guest input to reach the host' },
	);
	check('guest paddle input reaches the host', guestY === 120);
	state.left.touchY = guestY;
	step(state, { ai: 'none' });
	check(
		'the host applies the guest paddle position',
		Math.abs(state.left.y + state.left.h / 2 - 120) < 1,
		`paddle centre ${(state.left.y + state.left.h / 2).toFixed(1)}`,
	);

	// --- host -> guest snapshots ----------------------------------------------
	let seenSeq = -1;
	let lastSnap = null;
	let publishedAt = 0;
	let receivedAt = 0;
	guest.provider.awareness.on('update', () => {
		const hostState = guest.provider.awareness.getStates().get(guestView.hostId);
		if (acceptSnapshot(hostState, 'guest', seenSeq)) {
			lastSnap = hostState.s;
			seenSeq = hostState.s.n;
			receivedAt = Date.now();
		}
	});

	const publish = () => {
		publishedAt = Date.now();
		host.provider.awareness.setLocalStateField('s', serialize(state));
	};
	publish();
	await waitFor(() => lastSnap != null, { label: 'first host snapshot' });
	check('host snapshots reach the guest', lastSnap != null, `seq ${lastSnap.n}`);

	// play ~2s of a real match at snapshot rate, then compare guest vs host
	const started = Date.now();
	while (Date.now() - started < 2000) {
		for (let i = 0; i < 4; i++) step(state, { ai: 'none' });
		publish();
		await sleep(1000 / SNAPSHOT_HZ);
	}
	const guestRender = deserialize(lastSnap, Date.now());
	check(
		'the guest view tracks the host match',
		guestRender.left.score === state.left.score && guestRender.right.score === state.right.score,
		`host ${state.left.score}-${state.right.score} / guest ${guestRender.left.score}-${guestRender.right.score}, seq ${lastSnap.n}`,
	);
	check('the snapshot stream keeps flowing', seenSeq > 10, `${seenSeq} snapshots applied`);
	console.log(`  · host publish → guest apply lag sample: ${receivedAt - publishedAt}ms`);

	// --- rematch request -------------------------------------------------------
	guest.provider.awareness.setLocalStateField('q', 1);
	const reqSeen = await waitFor(() => {
		const guestState = host.provider.awareness.getStates().get(hostView.guestId);
		return Number(guestState?.q) === 1 ? 1 : null;
	}, { label: 'rematch request' });
	check('guest rematch requests reach the host', reqSeen === 1);

	// --- safety rails ----------------------------------------------------------
	check('a guest never accepts snapshots from a non-host', acceptSnapshot({ r: 'guest', s: { n: 9999 } }, 'guest', 0) === false);
	check('stale snapshots are ignored', acceptSnapshot({ r: 'host', s: { n: 5 } }, 'guest', 6) === false);
	check('room codes are validated before joining', normalizeCode('zz') === null && normalizeCode('abcd') === 'ABCD');

	// --- teardown --------------------------------------------------------------
	guest.provider.destroy();
	await waitFor(() => (host.provider.awareness.getStates().size <= 1 ? true : null), {
		label: 'the guest to leave the room',
	});
	check('leaving the room removes the guest from the host view', true);
	host.provider.destroy();

	console.log(`\n${passed} live netplay checks passed against ${RELAY_URL} (room ${roomName(ROOM)}).`);
} catch (err) {
	console.error(`\n✖ live netplay test failed: ${err.message}`);
	exitCode = 1;
} finally {
	try {
		host.provider.destroy();
		guest.provider.destroy();
	} catch {
		/* already gone */
	}
	// don't let y-websocket's reconnect timers hold the process open
	setTimeout(() => process.exit(exitCode), 250).unref();
}