#!/usr/bin/env node
// Live ambient-netplay smoke test — two real clients through the real relay.
//
//   pnpm --filter apps-site test:live
//
// Both clients use the same modules the page uses (`src/lib/bull-pong/*`):
// one settles into an empty pen and plays the bull, the other scans that pen,
// finds a lone human, and takes the bull's paddle. Then input, snapshots,
// promotion and teardown are checked. Runs in a private pen namespace so it
// never collides with whoever is actually playing. Needs network access to the
// relay; exits non-zero on the first failed expectation.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import {
	RELAY_URL,
	penRoom,
	penLabel,
	classifySlot,
	resolvePen,
	otherSide,
	describePen,
} from '../src/lib/bull-pong/netcode.js';
import { createState, resetMatch, step, serialize, deserialize } from '../src/lib/bull-pong/engine.js';

const PREFIX = `bullpong-smoke${Math.floor(Math.random() * 900 + 100)}`;
const PEN = 0;
const ROOM = penRoom(PREFIX, PEN);
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

async function waitFor(fn, { timeout = TIMEOUT, every = 100, label = 'condition' } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value) return value;
		await sleep(every);
	}
	throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
}

function client(name) {
	const doc = new Y.Doc();
	const provider = new WebsocketProvider(RELAY_URL, ROOM, doc, { connect: true, disableBc: true });
	return { name, doc, provider, awareness: provider.awareness, sent: { snapshots: 0, inputs: 0 } };
}

/** What a visitor would decide if it probed this pen right now. */
const probe = (c) => classifySlot(c.awareness.getStates());
const view = (c) => resolvePen(c.awareness.getStates(), c.awareness.clientID);

const a = client('a');
const b = client('b');
let exitCode = 0;

try {
	await waitFor(() => a.provider.wsconnected || a.provider.connected, { label: `${RELAY_URL} to answer` });

	// --- an empty pen: the first arrival settles in as the authority ----------
	check('an untouched pen scans as empty', probe(a).kind === 'empty', ROOM);
	a.awareness.setLocalState({ r: 'host', side: 'right' });
	const soloView = await waitFor(() => {
		const v = view(a);
		return v.seated && v.selfIsAuthority ? v : null;
	}, { label: 'the first client to seat itself' });
	check('the first client is the authority with the bull on the other horn', soloView.botSide === 'left' && soloView.otherId === null);
	check(
		'its status line offers the free paddle',
		/bull has the left horn/.test(describePen({ networked: true, penIndex: PEN, localSide: 'right', authority: true, picture: soloView })),
		describePen({ networked: true, penIndex: PEN, localSide: 'right', authority: true, picture: soloView }),
	);

	// --- the second arrival scans, finds a lone human, takes the bull's paddle -
	const beforeJoin = await waitFor(() => {
		const c = probe(b);
		return c.kind === 'join' ? c : null;
	}, { label: 'the pen to read as joinable' });
	check('a visitor sees one human and a free paddle', beforeJoin.kind === 'join' && beforeJoin.freeSide === 'left', JSON.stringify(beforeJoin.kind));
	b.awareness.setLocalState({ r: 'guest', side: beforeJoin.freeSide });

	const bothSeated = await waitFor(() => {
		const av = view(a);
		const bv = view(b);
		return av.otherId != null && !bv.selfIsAuthority && bv.seated ? { av, bv } : null;
	}, { label: 'both clients to be seated' });
	check(
		'the visitor replaces the bull: no bot left on the field',
		bothSeated.av.botSide === null && bothSeated.av.otherSide === 'left',
		`authority botSide=${bothSeated.av.botSide}`,
	);
	check('the visitor knows it is a player, not the authority', bothSeated.bv.selfIsAuthority === false && bothSeated.bv.hasAuthority === true);
	check(
		'both sides agree who plays which paddle',
		bothSeated.bv.otherSide === 'right' && bothSeated.av.otherSide === 'left' && bothSeated.bv.selfSide === 'left',
	);

	// --- the match itself: authority simulates, player reports its paddle ------
	const state = createState(11);
	resetMatch(state);
	state.left.touchY = 120; // as if the visitor moved its paddle there
	step(state, { ai: 'none' });
	check('the authority applies the visitor paddle straight away', Math.abs(state.left.y + state.left.h / 2 - 120) < 1);

	b.awareness.setLocalStateField('i', { y: 90 });
	const seenInput = await waitFor(() => {
		const other = a.awareness.getStates().get(bothSeated.av.otherId);
		const y = Number(other?.i?.y);
		return y === 90 ? y : null;
	}, { label: 'the visitor paddle to reach the authority over the relay' });
	state.left.touchY = seenInput;
	step(state, { ai: 'none' });
	check('the visitor paddle arrives over the relay', Math.abs(state.left.y + state.left.h / 2 - 90) < 1);

	let lastSnap = null;
	let seenSeq = -1;
	b.awareness.on('update', () => {
		const hostState = b.awareness.getStates().get(bothSeated.bv.authorityId);
		if (hostState?.r === 'host' && hostState.s && hostState.s.n > seenSeq) {
			lastSnap = hostState.s;
			seenSeq = hostState.s.n;
		}
	});
	a.awareness.setLocalStateField('s', serialize(state));
	await waitFor(() => lastSnap != null, { label: 'the first snapshot to reach the visitor' });

	const started = Date.now();
	while (Date.now() - started < 1500) {
		for (let i = 0; i < 4; i++) step(state, { ai: 'none' });
		a.awareness.setLocalStateField('s', serialize(state));
		await sleep(1000 / SNAPSHOT_HZ);
	}
	const visitorView = deserialize(lastSnap, Date.now());
	check(
		'the visitor renders the authority match',
		visitorView.left.score === state.left.score && visitorView.right.score === state.right.score,
		`authority ${state.left.score}-${state.right.score} / visitor ${visitorView.left.score}-${visitorView.right.score}, seq ${lastSnap.n}`,
	);
	check('the snapshot stream keeps flowing', seenSeq > 10, `${seenSeq} snapshots`);

	// --- rematch request -------------------------------------------------------
	b.awareness.setLocalStateField('q', 1);
	const asked = await waitFor(() => Number(a.awareness.getStates().get(bothSeated.av.otherId)?.q) === 1, { label: 'the rematch request' });
	check('the visitor can ask for a rematch', asked === true);

	// --- the authority leaves: the visitor keeps its paddle and gets the bull --
	a.awareness.setLocalState(null);
	a.provider.destroy();
	const orphaned = await waitFor(() => {
		const v = view(b);
		return v.hasAuthority === false ? v : null;
	}, { label: 'the authority to disappear' });
	check('the visitor sees its opponent vanish', orphaned.hasAuthority === false && orphaned.selfSide === 'left');
	check('the bull comes back for the empty horn', orphaned.botSide === 'right', `bot on ${orphaned.botSide}`);

	b.awareness.setLocalStateField('r', 'host'); // promotion, as the page does
	const promoted = await waitFor(() => {
		const v = view(b);
		return v.selfIsAuthority ? v : null;
	}, { label: 'the visitor to be promoted' });
	check('the visitor takes over as the authority, keeping its paddle', promoted.selfIsAuthority && promoted.selfSide === 'left' && promoted.botSide === 'right');
	check(
		'it can be joined in turn',
		classifySlot(b.awareness.getStates()).kind === 'join',
		JSON.stringify(classifySlot(b.awareness.getStates()).kind),
	);
	check('pen label reads back for the status line', penLabel(PEN) === '#1' && otherSide('left') === 'right');

	b.provider.destroy();
	console.log(`\n${passed} live ambient-netplay checks passed against ${RELAY_URL} (${ROOM}).`);
} catch (err) {
	console.error(`\n✖ live ambient-netplay test failed: ${err.message}`);
	exitCode = 1;
} finally {
	for (const c of [a, b]) {
		try {
			c.awareness.setLocalState(null);
			c.provider.destroy();
		} catch {
			/* already gone */
		}
	}
	setTimeout(() => process.exit(exitCode), 250).unref();
}
