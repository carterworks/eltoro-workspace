// Bull Pong — multiplayer protocol helpers (pure functions, no DOM, no Yjs).
//
// Transport: a y-websocket relay room. Each player publishes one tiny
// awareness state; the relay forwards it to everyone else in the room.
//   host  -> { r: 'host',  s: <snapshot>, c: <seq> }
//   guest -> { r: 'guest', i: { y }, q: <reset request counter> }
// The first client (lowest client id) for each role wins, so a stray third
// connection can never hijack a match — it just spectates.

export const RELAY_URL = 'wss://demos.yjs.dev/ws';
export const ROOM_PREFIX = 'bullpong-';
export const CODE_LENGTH = 4;
export const MAX_GUESTS = 1;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{4,10}$/;

/** Room codes: unambiguous alphabet, crypto RNG when available. */
export function makeCode(length = CODE_LENGTH) {
	const out = [];
	const cryptoObj = globalThis.crypto;
	if (cryptoObj?.getRandomValues) {
		const bytes = new Uint8Array(length);
		cryptoObj.getRandomValues(bytes);
		for (const b of bytes) out.push(ALPHABET[b % ALPHABET.length]);
	} else {
		for (let i = 0; i < length; i++) out.push(ALPHABET[(Math.random() * ALPHABET.length) | 0]);
	}
	return out.join('');
}

/** Accepts 'abcd', 'a1-b2', ' bullpong-abcd ' → 'ABCD' (or null). */
export function normalizeCode(raw) {
	if (typeof raw !== 'string') return null;
	let value = raw.trim().toUpperCase();
	if (value.startsWith(ROOM_PREFIX.toUpperCase())) value = value.slice(ROOM_PREFIX.length);
	value = value.replace(/[^A-Z0-9]/g, '');
	return CODE_RE.test(value) ? value : null;
}

/** The relay room name for a player-facing code. */
export function roomName(code) {
	return `${ROOM_PREFIX}${code.toUpperCase()}`;
}

/** Pull a room code out of a share link (or any URL-ish string). */
export function codeFromUrl(href) {
	try {
		const url = new URL(href, 'https://eltoro.carter.works');
		return normalizeCode(url.searchParams.get('room') ?? '');
	} catch {
		return null;
	}
}

export function shareLink(origin, code) {
	return `${origin}/artifacts/bull-pong/?room=${code.toUpperCase()}`;
}

/**
 * Work out who is who from the awareness states.
 * @param {Map<number, object>} states awareness.getStates()
 * @param {number} selfId   awareness.clientID (excluded from 'others')
 */
export function resolveRoom(states, selfId) {
	const hosts = [];
	const guests = [];
	for (const [id, state] of states ?? []) {
		if (!state || typeof state !== 'object') continue;
		if (state.r === 'host') hosts.push(id);
		else if (state.r === 'guest') guests.push(id);
	}
	hosts.sort((a, b) => a - b);
	guests.sort((a, b) => a - b);
	const hostId = hosts[0] ?? null;
	const guestIds = guests.slice(0, MAX_GUESTS);
	const extraGuests = guests.slice(MAX_GUESTS);
	return {
		hostId,
		guestId: guestIds[0] ?? null,
		extraGuests,
		selfIsHost: hostId === selfId,
		selfIsGuest: guestIds[0] === selfId,
		selfIsSpectator: hostId !== selfId && guestIds[0] !== selfId,
		players: (hostId != null ? 1 : 0) + (guestIds.length ? 1 : 0),
		waiting: hostId == null || guestIds.length === 0,
	};
}

/** Should this client accept the snapshot coming from `fromState`? */
export function acceptSnapshot(fromState, role, seenSeq) {
	if (role !== 'guest') return false;
	if (fromState?.r !== 'host') return false;
	if (typeof fromState.s !== 'object' || fromState.s == null) return false;
	return (fromState.s.n ?? -1) > (seenSeq ?? -1);
}

/** Human-readable status line for the current room picture. */
export function describeRoom({ mode, room, picture, relayUp }) {
	if (mode === 'ai') return 'solo mode — play the bull, or host a game to play a friend';
	if (!room) return 'solo mode';
	if (!relayUp) return `relay unreachable — retrying for room ${room}…`;
	if (picture?.selfIsSpectator) return `room ${room} — two bulls already in the pen, you are spectating`;
	if (mode === 'host') {
		if (picture?.waiting) return `room ${room} — waiting for an opponent…`;
		return `opponent in the pen — room ${room}. mind the bull.`;
	}
	if (picture?.waiting) return `room ${room} — connected, waiting for the host's first serve…`;
	return `both bulls in the pen — room ${room}. mind the bull.`;
}