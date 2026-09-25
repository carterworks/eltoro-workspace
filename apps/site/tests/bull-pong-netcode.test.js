import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	RELAY_URL,
	PEN_PREFIX,
	PEN_SLOTS,
	penRoom,
	normalizePenPrefix,
	penPrefixFromUrl,
	penLabel,
	otherSide,
	readClients,
	classifySlot,
	pickSlot,
	resolvePen,
	acceptSnapshot,
	describePen,
} from '../src/lib/bull-pong/netcode.js';

const host = (side = 'right') => ({ r: 'host', side });
const guest = (side = 'left') => ({ r: 'guest', side });

test('the relay endpoint is the y-websocket demo server', () => {
	assert.equal(RELAY_URL, 'wss://demos.yjs.dev/ws');
});

test('pens are a fixed pool of named relay rooms', () => {
	assert.equal(PEN_SLOTS, 8);
	assert.equal(penRoom(PEN_PREFIX, 0), 'bullpong-pen-1');
	assert.equal(penRoom(PEN_PREFIX, 7), 'bullpong-pen-8');
	assert.equal(penLabel(0), '#1');
	assert.equal(penLabel(7), '#8');
});

test('a pen prefix can be overridden for a private or test pen', () => {
	assert.equal(normalizePenPrefix(undefined), PEN_PREFIX);
	assert.equal(normalizePenPrefix('Party Time!'), 'bullpong-partytime');
	assert.equal(normalizePenPrefix('ab'), PEN_PREFIX, 'too short to be useful');
	assert.equal(penPrefixFromUrl('https://x/artifacts/bull-pong/?pen=TEST99'), 'bullpong-test99');
	assert.equal(penPrefixFromUrl('https://x/artifacts/bull-pong/'), PEN_PREFIX);
	assert.equal(penPrefixFromUrl('nonsense'), PEN_PREFIX);
	assert.equal(otherSide('left'), 'right');
	assert.equal(otherSide('right'), 'left');
});

test('only seated clients count, and sides never collide', () => {
	assert.deepEqual(readClients(new Map()), []);
	assert.deepEqual(readClients(new Map([[1, { r: 'wat' }], [2, null], [3, 'x']])), []);
	const clients = readClients(
		new Map([
			[9, host('right')],
			[4, guest('right')],
			[7, { r: 'host', side: 'left' }],
		]),
	);
	assert.deepEqual(
		clients.map((c) => ({ id: c.id, side: c.side, authority: c.authority })),
		[
			{ id: 4, side: 'right', authority: false },
			{ id: 7, side: 'left', authority: true },
			{ id: 9, side: null, authority: true },
		],
		'oldest client keeps its side, a later one flips, a third has nowhere to sit',
	);
});

test('an empty pen invites a new authority', () => {
	const c = classifySlot(new Map());
	assert.equal(c.kind, 'empty');
	assert.equal(c.freeSide, 'right');
});

test('a pen holding one human with the bot is joinable by taking the bot paddle', () => {
	const c = classifySlot(new Map([[5, host('right')]]));
	assert.equal(c.kind, 'join');
	assert.equal(c.freeSide, 'left');
	assert.equal(c.incumbent.id, 5);
	assert.equal(classifySlot(new Map([[5, host('left')]])).freeSide, 'right', 'respects the incumbent side');
	assert.equal(classifySlot(new Map([[5, { r: 'host' }]])).kind, 'join', 'a side-less state defaults to right');
});

test("a pen whose authority left is joinable by taking over", () => {
	const c = classifySlot(new Map([[5, guest('left')]]));
	assert.equal(c.kind, 'takeover');
	assert.equal(c.freeSide, 'right');
});

test('a pen with two humans is full', () => {
	assert.equal(classifySlot(new Map([[1, host()], [2, guest()]])).kind, 'full');
	assert.equal(classifySlot(new Map([[1, host()], [2, guest()], [3, host('left')]])).kind, 'full');
});

test('a scan prefers replacing a bot over adopting a pen or opening one', () => {
	const results = [
		{ index: 0, classify: { kind: 'empty' } },
		{ index: 1, classify: { kind: 'full' } },
		{ index: 2, classify: { kind: 'takeover' } },
		{ index: 3, classify: { kind: 'join' } },
	];
	assert.deepEqual(pickSlot(results), { index: 3, action: 'join', classify: { kind: 'join' } });
	assert.deepEqual(pickSlot([{ index: 0, classify: { kind: 'empty' } }, { index: 1, classify: { kind: 'takeover' } }]), {
		index: 1,
		action: 'takeover',
		classify: { kind: 'takeover' },
	});
	assert.equal(pickSlot([{ index: 0, classify: { kind: 'empty' } }]).action, 'empty');
	assert.equal(pickSlot([{ index: 0, classify: { kind: 'full' } }, { index: 1, classify: { kind: 'full' } }]), null);
});

test('a lone authority plays the bot on the free side', () => {
	const picture = resolvePen(new Map([[10, host('right')]]), 10);
	assert.equal(picture.seated, true);
	assert.equal(picture.selfIsAuthority, true);
	assert.equal(picture.selfSide, 'right');
	assert.equal(picture.botSide, 'left');
	assert.equal(picture.waiting, true);
	assert.equal(picture.otherId, null);
});

test('an arriving visitor replaces the bot, from both points of view', () => {
	const states = new Map([
		[10, host('right')],
		[22, guest('left')],
	]);
	const authority = resolvePen(states, 10);
	const player = resolvePen(states, 22);
	assert.equal(authority.botSide, null, 'no bot once a human holds the other paddle');
	assert.equal(authority.otherId, 22);
	assert.equal(authority.otherSide, 'left');
	assert.equal(player.selfIsAuthority, false);
	assert.equal(player.hasAuthority, true);
	assert.equal(player.otherId, 10);
	assert.equal(player.otherSide, 'right');
	assert.equal(player.waiting, false);
});

test('when the authority leaves, the remaining player keeps its side and the bot takes the other', () => {
	const picture = resolvePen(new Map([[22, guest('left')]]), 22);
	assert.equal(picture.hasAuthority, false);
	assert.equal(picture.selfSide, 'left');
	assert.equal(picture.botSide, 'right', 'the bot fills the empty horn');
	assert.equal(picture.otherId, null);
});

test('a promoted player becomes the authority while keeping its side', () => {
	const states = new Map([
		[22, host('left')],
		[31, guest('right')],
	]);
	const promoted = resolvePen(states, 22);
	assert.equal(promoted.selfIsAuthority, true);
	assert.equal(promoted.selfSide, 'left');
	assert.equal(promoted.botSide, null);
	assert.equal(promoted.otherSide, 'right');
});

test('a crowded pen reports itself instead of seating a third player', () => {
	const states = new Map([[1, host('right')], [2, guest('left')], [3, host('left')]]);
	const third = resolvePen(states, 3);
	assert.equal(third.seated, false, 'the third client has no paddle');
	assert.equal(third.crowded, true);
});

test('the player accepts only fresh snapshots from the current authority', () => {
	const authority = { r: 'host', s: { n: 12, l: { y: 1 } } };
	assert.equal(acceptSnapshot(authority, 'guest', 11), true);
	assert.equal(acceptSnapshot(authority, 'guest', 12), false, 'already applied');
	assert.equal(acceptSnapshot(authority, 'guest', 13), false, 'stale');
	assert.equal(acceptSnapshot({ r: 'guest', s: { n: 99 } }, 'guest', 0), false, 'not an authority');
	assert.equal(acceptSnapshot({ r: 'host' }, 'guest', 0), false, 'no snapshot attached');
	assert.equal(acceptSnapshot(authority, 'host', 0), false, 'an authority does not render snapshots');
});

test('status lines cover solo, hosting, dropping in, and abandonment', () => {
	assert.match(describePen({ networked: false, scanning: true, picture: null, penIndex: null, localSide: 'right', authority: true }), /playing the bull/);
	assert.match(
		describePen({ networked: true, penIndex: 2, localSide: 'right', authority: true, picture: resolvePen(new Map([[1, host('right')]]), 1) }),
		/pen #3.*bull has the left horn/,
	);
	assert.match(
		describePen({ networked: true, penIndex: 0, localSide: 'right', authority: true, picture: resolvePen(new Map([[1, host('right')], [2, guest('left')]]), 1) }),
		/someone just took the bull's horn/,
	);
	assert.match(
		describePen({ networked: true, penIndex: 0, localSide: 'left', authority: false, picture: resolvePen(new Map([[1, host('right')], [2, guest('left')]]), 2) }),
		/dropped into pen #1.*left horn/,
	);
	assert.match(
		describePen({ networked: true, penIndex: 4, localSide: 'left', authority: false, picture: resolvePen(new Map([[2, guest('left')]]), 2) }),
		/waiting for the pen to answer/,
	);
	assert.match(
		describePen({ networked: true, penIndex: 0, localSide: 'right', authority: true, picture: resolvePen(new Map([[1, host('right')], [2, guest('left')], [3, host('left')]]), 3) }),
		/full|crowded/,
	);
});
