import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	RELAY_URL,
	ROOM_PREFIX,
	makeCode,
	normalizeCode,
	roomName,
	codeFromUrl,
	shareLink,
	resolveRoom,
	acceptSnapshot,
	describeRoom,
} from '../src/lib/bull-pong/netcode.js';

test('room codes are short, unambiguous, and never repeat in a row', () => {
	const codes = new Set();
	for (let i = 0; i < 200; i++) codes.add(makeCode());
	assert.equal(codes.size, 200, 'codes collide far too often');
	for (const code of codes) {
		assert.match(code, /^[A-Z0-9]{4}$/);
		assert.ok(!/[IO01]/.test(code), `${code} uses a confusable character`);
	}
});

test('the relay endpoint is the y-websocket demo server', () => {
	assert.equal(RELAY_URL, 'wss://demos.yjs.dev/ws');
	assert.equal(roomName('abcd'), `${ROOM_PREFIX}ABCD`);
});

test('room codes are normalized from messy player input', () => {
	assert.equal(normalizeCode('abcd'), 'ABCD');
	assert.equal(normalizeCode(' a1-b2 '), 'A1B2');
	assert.equal(normalizeCode('bullpong-xy12'), 'XY12');
	assert.equal(normalizeCode('zz'), null, 'too short');
	assert.equal(normalizeCode('this-is-way-too-long'), null);
	assert.equal(normalizeCode(null), null);
	assert.equal(normalizeCode('!!!!'), null);
});

test('share links round-trip through codeFromUrl', () => {
	const link = shareLink('https://eltoro.carter.works', 'ab12');
	assert.equal(link, 'https://eltoro.carter.works/artifacts/bull-pong/?room=AB12');
	assert.equal(codeFromUrl(link), 'AB12');
	assert.equal(codeFromUrl('/artifacts/bull-pong/?room=xy99'), 'XY99');
	assert.equal(codeFromUrl('https://eltoro.carter.works/artifacts/bull-pong/'), null);
	assert.equal(codeFromUrl('not a url at all'), null);
});

test('an empty room is waiting, with nobody seated', () => {
	const picture = resolveRoom(new Map(), 100);
	assert.deepEqual(
		{ hostId: picture.hostId, guestId: picture.guestId, waiting: picture.waiting, players: picture.players },
		{ hostId: null, guestId: null, waiting: true, players: 0 },
	);
});

test('a lone host is seated and waiting for an opponent', () => {
	const picture = resolveRoom(new Map([[7, { r: 'host' }]]), 7);
	assert.equal(picture.hostId, 7);
	assert.equal(picture.selfIsHost, true);
	assert.equal(picture.waiting, true);
});

test('host and guest resolve to the same seating on both sides', () => {
	const states = new Map([
		[10, { r: 'host' }],
		[22, { r: 'guest' }],
	]);
	const hostView = resolveRoom(states, 10);
	const guestView = resolveRoom(states, 22);
	assert.equal(hostView.hostId, 10);
	assert.equal(hostView.guestId, 22);
	assert.equal(guestView.hostId, 10);
	assert.equal(guestView.guestId, 22);
	assert.equal(hostView.selfIsHost && guestView.selfIsGuest, true);
	assert.equal(hostView.waiting, false);
	assert.equal(hostView.players, 2);
});

test('a third client spectates instead of hijacking a seat', () => {
	const states = new Map([
		[10, { r: 'host' }],
		[22, { r: 'guest' }],
		[33, { r: 'guest' }],
	]);
	const spectator = resolveRoom(states, 33);
	assert.equal(spectator.guestId, 22, 'the first guest keeps the seat');
	assert.equal(spectator.extraGuests.length, 1);
	assert.equal(spectator.selfIsSpectator, true);
	assert.equal(spectator.selfIsGuest, false);
});

test('two hosts resolve to the lowest client id', () => {
	const states = new Map([
		[90, { r: 'host' }],
		[12, { r: 'host' }],
	]);
	assert.equal(resolveRoom(states, 90).hostId, 12);
	assert.equal(resolveRoom(states, 12).selfIsHost, true);
});

test('junk awareness states are ignored', () => {
	const states = new Map([
		[1, null],
		[2, 'nonsense'],
		[3, { r: 'guest' }],
	]);
	const picture = resolveRoom(states, 3);
	assert.equal(picture.hostId, null);
	assert.equal(picture.guestId, 3);
});

test('guests accept only fresh, well-formed host snapshots', () => {
	const hostState = { r: 'host', s: { n: 12, l: { y: 1 } } };
	assert.equal(acceptSnapshot(hostState, 'guest', 11), true);
	assert.equal(acceptSnapshot(hostState, 'guest', 12), false, 'same sequence = already applied');
	assert.equal(acceptSnapshot(hostState, 'guest', 13), false, 'stale snapshot');
	assert.equal(acceptSnapshot({ r: 'guest', s: { n: 99 } }, 'guest', 0), false, 'not from the host');
	assert.equal(acceptSnapshot({ r: 'host' }, 'guest', 0), false, 'no snapshot attached');
	assert.equal(acceptSnapshot(hostState, 'host', 0), false, 'hosts do not take snapshots');
});

test('status lines describe every stage of the lobby', () => {
	const base = { mode: 'host', room: 'AB12', relayUp: true };
	assert.match(describeRoom({ ...base, mode: 'ai', room: null, picture: null }), /solo mode/);
	assert.match(describeRoom({ ...base, picture: resolveRoom(new Map([[1, { r: 'host' }]]), 1) }), /waiting for an opponent/);
	assert.match(
		describeRoom({
			...base,
			picture: resolveRoom(
				new Map([
					[1, { r: 'host' }],
					[2, { r: 'guest' }],
				]),
				1,
			),
		}),
		/both bulls in the pen|opponent in the pen/,
	);
	assert.match(describeRoom({ ...base, relayUp: false }), /relay unreachable/);
	assert.match(describeRoom({ ...base, relayUp: null }), /knocking on the relay/);
	assert.match(
		describeRoom({ ...base, picture: resolveRoom(new Map([[1, { r: 'host' }]]), 1), link: 'https://x/artifacts/bull-pong/?room=AB12' }),
		/share https:\/\/x\/artifacts\/bull-pong\/\?room=AB12/,
	);
	assert.match(
		describeRoom({
			mode: 'guest',
			room: 'AB12',
			relayUp: true,
			picture: resolveRoom(
				new Map([
					[1, { r: 'host' }],
					[2, { r: 'guest' }],
					[3, { r: 'guest' }],
				]),
				3,
			),
		}),
		/spectating/,
	);
});