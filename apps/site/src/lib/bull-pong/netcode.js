// Bull Pong — ambient netplay protocol (pure functions, no DOM, no Yjs).
//
// There are no room codes. A fixed pool of pens (relay rooms) is always open.
// A client that finds an empty pen settles in as its authority and plays the
// bull (AI) on the free side; a client that finds a pen with a single human
// drops in and takes the bull's paddle — the bot is replaced mid-rally, no
// reset, no handshake, no negotiation. Everybody landed on a game already.
//
// Awareness state each client publishes:
//   { r: 'host' | 'guest', side: 'left' | 'right', s: <snapshot>, i: {y}, q: <n> }
//     r='host'  — this client is the authority (it simulates and publishes)
//     side      — which paddle this client drives
//     s         — authority only: the match snapshot
//     i         — player only: paddle centre it wants
//     q         — player only: rematch request counter
//
// The authority drives whatever side has no human on it, so when a visitor
// arrives the bot simply stops playing and the ball keeps rolling.

export const RELAY_URL = 'wss://demos.yjs.dev/ws';
export const PEN_PREFIX = 'bullpong-pen';
export const PEN_SLOTS = 8;
export const SIDES = ['left', 'right'];

/** Relay room name for pen `index` (0-based) under a prefix. */
export function penRoom(prefix, index) {
	return `${prefix}-${index + 1}`;
}

/** `?pen=<token>` lets a private/test pen exist without codes in the UI. */
export function normalizePenPrefix(raw) {
	if (typeof raw !== 'string') return PEN_PREFIX;
	const token = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
	if (token.length < 3) return PEN_PREFIX;
	return `bullpong-${token}`.slice(0, 40);
}

export function penPrefixFromUrl(href) {
	try {
		const url = new URL(href, 'https://eltoro.carter.works');
		return normalizePenPrefix(url.searchParams.get('pen') ?? '');
	} catch {
		return PEN_PREFIX;
	}
}

export function penLabel(index) {
	return `#${index + 1}`;
}

export function otherSide(side) {
	return side === 'left' ? 'right' : 'left';
}

/** Every seated human in the pen, oldest client first, sides de-duplicated. */
export function readClients(states) {
	const clients = [];
	for (const [id, state] of states ?? []) {
		if (!state || typeof state !== 'object') continue;
		if (state.r !== 'host' && state.r !== 'guest') continue;
		clients.push({ id, authority: state.r === 'host', side: state.side === 'left' ? 'left' : 'right', state });
	}
	clients.sort((a, b) => a.id - b.id);
	const used = new Set();
	for (const client of clients) {
		if (used.has(client.side)) client.side = otherSide(client.side);
		if (used.has(client.side)) client.side = null; // both paddles taken
		if (client.side) used.add(client.side);
	}
	return clients;
}

/**
 * What would happen if we joined this pen?
 *   'empty'          — settle in as authority, bot on the free side
 *   'join'           — a lone authority is playing the bot: take the bot's paddle
 *   'takeover'       — a lone player's authority left: become the authority
 *   'full'           — two humans already in the pen
 */
export function classifySlot(states) {
	const clients = readClients(states).filter((c) => c.side);
	if (clients.length === 0) return { kind: 'empty', clients, freeSide: 'right', incumbent: null };
	if (clients.length === 1) {
		const incumbent = clients[0];
		return {
			kind: incumbent.authority ? 'join' : 'takeover',
			clients,
			freeSide: otherSide(incumbent.side),
			incumbent,
		};
	}
	return { kind: 'full', clients, freeSide: null, incumbent: null };
}

/** Choose a pen from a scan: prefer replacing a bot, then adopting, then new. */
export function pickSlot(results) {
	for (const kind of ['join', 'takeover', 'empty']) {
		const hit = (results ?? []).find((r) => r?.classify?.kind === kind);
		if (hit) return { index: hit.index, action: kind, classify: hit.classify };
	}
	return null;
}

/** The local client's view of the pen it is in. */
export function resolvePen(states, selfId) {
	const clients = readClients(states);
	const seated = clients.filter((c) => c.side);
	const authority = seated.find((c) => c.authority) ?? null;
	const me = seated.find((c) => c.id === selfId) ?? null;
	const others = seated.filter((c) => c.id !== selfId);
	const taken = new Set(seated.map((c) => c.side));
	const botSide = taken.has('left') && taken.has('right') ? null : taken.has('left') ? 'right' : 'left';
	return {
		clients,
		seated: !!me,
		selfSide: me?.side ?? null,
		selfIsAuthority: authority != null && authority.id === selfId,
		hasAuthority: authority != null,
		authorityId: authority?.id ?? null,
		otherId: others[0]?.id ?? null,
		otherSide: others[0]?.side ?? null,
		botSide,
		crowded: clients.length > 2,
		waiting: seated.length < 2,
	};
}

/**
 * Should this client accept the snapshot the authority is publishing?
 * Only fresh, well-formed snapshots from the current authority count.
 */
export function acceptSnapshot(fromState, role, seenSeq) {
	if (role !== 'guest') return false;
	if (fromState?.r !== 'host') return false;
	if (typeof fromState.s !== 'object' || fromState.s == null) return false;
	return (fromState.s.n ?? -1) > (seenSeq ?? -1);
}

/** Status line: what is happening right now, in one breath. */
export function describePen({ networked, scanning, penIndex, picture, localSide, authority }) {
	const room = penIndex == null ? '' : ` in pen ${penLabel(penIndex)}`;
	if (!networked) {
		return scanning
			? 'playing the bull — sniffing around for another pen…'
			: 'playing the bull — the pen is quiet, someone else may drop in';
	}
	if (picture && !picture.seated) return `pen ${penLabel(penIndex)} is full — playing the bull until a horn frees up`;
	if (picture?.crowded) return `pen ${penLabel(penIndex)} is crowded — playing the bull until a horn frees up`;
	if (authority) {
		if (picture?.waiting) return `you${room} — the bull has the ${otherSide(localSide)} horn, anyone can take it`;
		return `you${room} — someone just took the bull's horn. mind the bull.`;
	}
	if (!picture?.hasAuthority) return `you${room} — waiting for the pen to answer…`;
	return `you dropped into pen ${penLabel(penIndex)} — the ${localSide} horn is yours`;
}
