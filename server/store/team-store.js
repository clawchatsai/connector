// TeamStore: team chats (several agents in one ClawChats thread). Lives in the global DB.
// Registry entry: EXTRAS.md. Coordinator: server/team.js.
//
//   team_rooms    a room = a gateway session that never runs; its transcript is the shared timeline;
//                 source_key = the chat it was converted from (its history shows above the room)
//   team_members  one working session per agent per room (created on the agent's first turn);
//                 seen_at = timestamp of the newest room entry the agent has been given;
//                 removed = 1: agent taken out of the room; its session stays hidden and is reused
//                 if the agent is added back
//   team_entries  author of each injected room entry (the transcript only has a "[Label]" prefix);
//                 acting_for = whose request an agent answered when it wasn't its owner's ("Kamil")
//   team_rooms.rounds  follow-up rounds per human message when agents discuss (host setting)
//   team_members.history  'all' (default: a first turn also gets the chat's earlier history) or 'now'
//   team_people   people in a room this gateway hosts (specs/sharing-people.md): a contact, by their
//                 gateway id; history_from = the oldest entry time they may see (0 = everything)
//   team_rooms.host_*  a live copy of someone else's room (this gateway is a member, not the host):
//                 host_gateway_id/host_room/host_name; replica_json = the host's members and people
//   team_mirror   host entry id -> local message id in a live copy (each host entry injected once)
//   team_entries.host_ts/owner_id/ref  a mirrored entry's original time, its agent's owner and room-wide agent ref
//   team_entries author_type 'system': a line like "Kamil joined" (same on every screen)
//   team_rooms.mention_only  unused (was: agents answer only when @mentioned); a plain message now goes to the sender's agents
//   team_entries.via  which of its sessions an agent wrote from: 'owner' (its owner's own session,
//                 here or in its owner's copy) or 'guest:<who>' (a session it ran in for someone else).
//                 NULL on older rows: treated as the session asking, as before.
//   team_lanes    seen_at for an agent's other sessions in a room ('guest:<who>'); its owner session
//                 keeps team_members.seen_at. One agent can answer in several sessions, and each
//                 must be given what it hasn't seen itself.
//   team_inflight one row per agent turn of the message a room is answering now (one message at a time per room),
//                 so a connector that stops mid-round (a plugin reload hands running turns to the next generation)
//                 can finish it: kind 'own' (work_key, run_id = its chat.send key) | 'remote' | 'for' (turn_json: the
//                 request, resent with the same turn id); post_json = how its reply is posted; done = 1 with text /
//                 authority once the reply is in the room. A row is replaced by the agent's next round; the room's
//                 rows go when the message is finished.

const DISCUSS_ROUNDS = 3; // default; each room can set 1..MAX_ROUNDS
const MAX_ROUNDS = 10;

function roomRow(r, members, people = []) {
  return {
    roomKey: r.room_key,
    discuss: !!r.discuss,
    rounds: r.rounds || DISCUSS_ROUNDS,
    sourceKey: r.source_key || null,
    createdAt: r.created_at,
    members: members.map(m => ({ agentId: m.agent_id, workKey: m.work_key || null, seenAt: m.seen_at || 0, history: m.history || 'all', historyFrom: m.history_from ?? null, handle: m.handle || null })),
    people: people.map(p => ({ personId: p.person_id, name: p.name, email: p.email || null, historyFrom: p.history_from || 0 })),
    ...(r.host_gateway_id ? { host: { gatewayId: r.host_gateway_id, roomId: r.host_room, name: r.host_name || 'Someone', ended: r.host_ended || null, ...JSON.parse(r.replica_json || '{}') } } : {}),
  };
}

export function createTeamStore(getGlobalDb) {
  let ready = false;
  function db() {
    const g = getGlobalDb();
    if (!ready) {
      g.exec(`CREATE TABLE IF NOT EXISTS team_rooms (room_key TEXT PRIMARY KEY, discuss INTEGER NOT NULL DEFAULT 0, source_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS team_members (room_key TEXT NOT NULL, agent_id TEXT NOT NULL, work_key TEXT, seen_at INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, PRIMARY KEY (room_key, agent_id))`);
      g.exec(`CREATE INDEX IF NOT EXISTS team_members_work ON team_members (work_key)`);
      if (!g.prepare('PRAGMA table_info(team_members)').all().some(c => c.name === 'removed')) g.exec('ALTER TABLE team_members ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
      g.exec(`CREATE TABLE IF NOT EXISTS team_entries (room_key TEXT NOT NULL, message_id TEXT NOT NULL, author_type TEXT NOT NULL, agent_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (room_key, message_id))`);
      if (!g.prepare('PRAGMA table_info(team_entries)').all().some(c => c.name === 'acting_for')) g.exec('ALTER TABLE team_entries ADD COLUMN acting_for TEXT');
      if (!g.prepare('PRAGMA table_info(team_rooms)').all().some(c => c.name === 'rounds')) g.exec('ALTER TABLE team_rooms ADD COLUMN rounds INTEGER');
      const cols = t => new Set(g.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
      if (!cols('team_members').has('history')) g.exec('ALTER TABLE team_members ADD COLUMN history TEXT');
      // The @handle the room gives the agent (team.js assignHandle): unique in the room, kept after it leaves.
      if (!cols('team_members').has('handle')) g.exec('ALTER TABLE team_members ADD COLUMN handle TEXT');
      if (!cols('team_members').has('history_from')) g.exec('ALTER TABLE team_members ADD COLUMN history_from INTEGER'); // "from now on": when it joined
      const rc = cols('team_rooms');
      for (const c of ['host_gateway_id', 'host_room', 'host_name', 'host_ended', 'replica_json']) if (!rc.has(c)) g.exec(`ALTER TABLE team_rooms ADD COLUMN ${c} TEXT`);
      if (!rc.has('mention_only')) g.exec('ALTER TABLE team_rooms ADD COLUMN mention_only INTEGER NOT NULL DEFAULT 0');
      const ec = cols('team_entries');
      if (!ec.has('host_ts')) g.exec('ALTER TABLE team_entries ADD COLUMN host_ts INTEGER');
      if (!ec.has('owner_id')) g.exec('ALTER TABLE team_entries ADD COLUMN owner_id TEXT');
      if (!ec.has('ref')) g.exec('ALTER TABLE team_entries ADD COLUMN ref TEXT');
      g.exec(`CREATE TABLE IF NOT EXISTS team_people (room_key TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, history_from INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_key, person_id))`);
      if (!ec.has('via')) g.exec('ALTER TABLE team_entries ADD COLUMN via TEXT');
      g.exec(`CREATE TABLE IF NOT EXISTS team_lanes (room_key TEXT NOT NULL, agent_id TEXT NOT NULL, lane TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (room_key, agent_id, lane))`);
      // A lane whose session was made again (cleanup, or deleted on the gateway): its next turn gets the room up to its
      // seen point as handled context (team.js _handled). Cleared once that turn has run.
      g.exec(`CREATE TABLE IF NOT EXISTS team_rebuilt (room_key TEXT NOT NULL, agent_id TEXT NOT NULL, lane TEXT NOT NULL, PRIMARY KEY (room_key, agent_id, lane))`);
      g.exec(`CREATE TABLE IF NOT EXISTS team_mirror (room_key TEXT NOT NULL, host_entry_id TEXT NOT NULL, message_id TEXT, PRIMARY KEY (room_key, host_entry_id))`);
      g.exec(`CREATE TABLE IF NOT EXISTS team_inflight (room_key TEXT NOT NULL, agent_id TEXT NOT NULL, round INTEGER NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, work_key TEXT, mode TEXT, turn_json TEXT, post_json TEXT, started_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, text TEXT, authority TEXT, PRIMARY KEY (room_key, agent_id))`);
      // Reactions on room entries (message_id: this gateway's entry id; a copy's are mirrored from the host's), and the
      // additions/removals agents are told about on their next turn (team.js _reactionNotes).
      g.exec(`CREATE TABLE IF NOT EXISTS team_reactions (room_key TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (room_key, message_id, emoji, person_id))`);
      g.exec(`CREATE TABLE IF NOT EXISTS team_reaction_log (room_key TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL, name TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      ready = true;
    }
    return g;
  }
  const members = roomKey => db().prepare('SELECT * FROM team_members WHERE room_key = ? AND removed = 0 ORDER BY position').all(roomKey);
  const people = roomKey => db().prepare('SELECT * FROM team_people WHERE room_key = ? AND removed = 0 ORDER BY added_at').all(roomKey);

  return {
    DISCUSS_ROUNDS,
    MAX_ROUNDS,

    getRoom(roomKey) {
      const r = db().prepare('SELECT * FROM team_rooms WHERE room_key = ?').get(roomKey);
      return r ? roomRow(r, members(roomKey), people(roomKey)) : null;
    },

    listRooms() {
      return db().prepare('SELECT * FROM team_rooms ORDER BY created_at').all().map(r => roomRow(r, members(r.room_key), people(r.room_key)));
    },

    /** members: [{ agentId, workKey?, seenAt? }] in display order; sourceKey: the chat it was converted from. */
    createRoom(roomKey, memberList, { discuss = false, sourceKey = null } = {}) {
      const g = db();
      const now = Date.now();
      g.exec('BEGIN');
      try {
        g.prepare('INSERT INTO team_rooms (room_key, discuss, source_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(roomKey, discuss ? 1 : 0, sourceKey, now, now);
        memberList.forEach((m, i) => g.prepare('INSERT INTO team_members (room_key, agent_id, work_key, seen_at, position) VALUES (?, ?, ?, ?, ?)').run(roomKey, m.agentId, m.workKey || null, m.seenAt || 0, i));
        g.exec('COMMIT');
      } catch (e) { g.exec('ROLLBACK'); throw e; }
      return this.getRoom(roomKey);
    },

    /**
     * Adds an agent at the end (an agent removed earlier comes back with its session). Returns false if
     * the room is unknown. history 'now': it starts from the newest entry, without the earlier chat.
     */
    addMember(roomKey, agentId, { history = 'all', seenAt = 0 } = {}) {
      if (!this.getRoom(roomKey)) return false;
      const pos = db().prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM team_members WHERE room_key = ?').get(roomKey).p;
      db().prepare('INSERT INTO team_members (room_key, agent_id, work_key, seen_at, position, history, history_from) VALUES (?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(room_key, agent_id) DO UPDATE SET removed = 0, position = excluded.position WHERE removed = 1')
        .run(roomKey, agentId, seenAt, pos, history === 'now' ? 'now' : 'all', history === 'now' ? seenAt : null);
      return true;
    },

    /** Every agent the room ever had, removed ones too, in join order: [{ agentId, handle }] (handles stay taken). */
    handles(roomKey) {
      return db().prepare('SELECT agent_id, handle FROM team_members WHERE room_key = ? ORDER BY position').all(roomKey).map(m => ({ agentId: m.agent_id, handle: m.handle || null }));
    },

    setHandle(roomKey, agentId, handle) {
      db().prepare('UPDATE team_members SET handle = ? WHERE room_key = ? AND agent_id = ? AND handle IS NULL').run(handle, roomKey, agentId);
    },

    /** A person joins a room this gateway hosts (or comes back). historyFrom: oldest entry time they see. */
    addPerson(roomKey, { personId, name, email = null, historyFrom = 0 }) {
      if (!this.getRoom(roomKey)) return false;
      db().prepare(`INSERT INTO team_people (room_key, person_id, name, email, history_from, added_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_key, person_id) DO UPDATE SET removed = 0, name = excluded.name, email = excluded.email, history_from = excluded.history_from WHERE removed = 1`)
        .run(roomKey, personId, String(name).slice(0, 100), email, historyFrom, Date.now());
      return true;
    },

    removePerson(roomKey, personId) {
      db().prepare('UPDATE team_people SET removed = 1 WHERE room_key = ? AND person_id = ?').run(roomKey, personId);
    },

    /** Every room a person is in (this gateway hosting). */
    roomsWithPerson(personId) {
      return db().prepare('SELECT room_key FROM team_people WHERE person_id = ? AND removed = 0').all(personId).map(r => r.room_key);
    },

    // ── Live copies (this gateway is a member of someone else's room) ──

    /** The local copy of a host's room, or null. */
    replicaFor(hostGatewayId, hostRoom) {
      return db().prepare('SELECT room_key FROM team_rooms WHERE host_gateway_id = ? AND host_room = ?').get(hostGatewayId, hostRoom)?.room_key || null;
    },

    createReplica(roomKey, { hostGatewayId, hostRoom, hostName }) {
      const now = Date.now();
      db().prepare('INSERT INTO team_rooms (room_key, discuss, source_key, created_at, updated_at, host_gateway_id, host_room, host_name, replica_json) VALUES (?, 0, NULL, ?, ?, ?, ?, ?, ?)')
        .run(roomKey, now, now, hostGatewayId, hostRoom, String(hostName).slice(0, 100), '{}');
    },

    /** The host's view of its room: { members: [{ agentId, name, ownerGatewayId? }], people: [...], title, discuss }. */
    setReplica(roomKey, { hostName, view, ended }) {
      db().prepare('UPDATE team_rooms SET host_name = COALESCE(?, host_name), replica_json = COALESCE(?, replica_json), host_ended = ?, updated_at = ? WHERE room_key = ?')
        .run(hostName ? String(hostName).slice(0, 100) : null, view ? JSON.stringify(view) : null, ended || null, Date.now(), roomKey);
    },

    mirrored(roomKey, hostEntryId) {
      return !!db().prepare('SELECT 1 FROM team_mirror WHERE room_key = ? AND host_entry_id = ?').get(roomKey, hostEntryId);
    },

    recordMirror(roomKey, hostEntryId, messageId) {
      db().prepare('INSERT OR REPLACE INTO team_mirror (room_key, host_entry_id, message_id) VALUES (?, ?, ?)').run(roomKey, hostEntryId, messageId);
    },

    /** A copy's entry id → the host's (toHost: false: the other way); null when it isn't mirrored. */
    mirrorId(roomKey, id, { toHost = true } = {}) {
      const r = toHost
        ? db().prepare('SELECT host_entry_id AS id FROM team_mirror WHERE room_key = ? AND message_id = ?').get(roomKey, id)
        : db().prepare('SELECT message_id AS id FROM team_mirror WHERE room_key = ? AND host_entry_id = ?').get(roomKey, id);
      return r?.id || null;
    },

    // ── Reactions on room entries ──

    /** One person adds or removes one emoji on an entry; returns whether anything changed (logged for the agents). */
    setReaction(roomKey, messageId, emoji, { personId, name }, remove = false) {
      const g = db();
      const now = Date.now();
      const changed = remove
        ? g.prepare('DELETE FROM team_reactions WHERE room_key = ? AND message_id = ? AND emoji = ? AND person_id = ?').run(roomKey, messageId, emoji, personId).changes > 0
        : g.prepare('INSERT OR IGNORE INTO team_reactions (room_key, message_id, emoji, person_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(roomKey, messageId, emoji, personId, name || null, now).changes > 0;
      if (changed) this._logReaction(roomKey, messageId, emoji, name, remove ? 'removed' : 'added', now);
      return changed;
    },

    /**
     * A copy takes the host's reactions on an entry as they are (summaries in the gateway's shape); the
     * differences are logged for this side's agents. Returns whether anything changed.
     */
    replaceReactions(roomKey, messageId, summaries) {
      const g = db();
      const now = Date.now();
      const want = new Map();
      for (const s of summaries || []) for (const who of s.identities || []) want.set(`${s.emoji}\u0000${who.id}`, { emoji: s.emoji, personId: who.id, name: who.label || null });
      const have = g.prepare('SELECT emoji, person_id, name FROM team_reactions WHERE room_key = ? AND message_id = ?').all(roomKey, messageId);
      let changed = false;
      for (const r of have) {
        if (want.delete(`${r.emoji}\u0000${r.person_id}`)) continue;
        g.prepare('DELETE FROM team_reactions WHERE room_key = ? AND message_id = ? AND emoji = ? AND person_id = ?').run(roomKey, messageId, r.emoji, r.person_id);
        this._logReaction(roomKey, messageId, r.emoji, r.name, 'removed', now);
        changed = true;
      }
      for (const r of want.values()) {
        g.prepare('INSERT OR IGNORE INTO team_reactions (room_key, message_id, emoji, person_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(roomKey, messageId, r.emoji, r.personId, r.name, now);
        this._logReaction(roomKey, messageId, r.emoji, r.name, 'added', now);
        changed = true;
      }
      return changed;
    },

    /** { [messageId]: [{ emoji, count, identities: [{ id, label? }] }] } (session.reactions.list's shape), or one entry's list. */
    reactions(roomKey, messageId = null, { since = 0 } = {}) {
      const rows = messageId
        ? db().prepare('SELECT * FROM team_reactions WHERE room_key = ? AND message_id = ? ORDER BY created_at, rowid').all(roomKey, messageId)
        : since
          // Only on entries from `since` on (a person added "from now on" never sees reactions on earlier ones).
          ? db().prepare(`SELECT r.* FROM team_reactions r JOIN team_entries e ON e.room_key = r.room_key AND e.message_id = r.message_id
              WHERE r.room_key = ? AND COALESCE(e.host_ts, e.created_at) >= ? ORDER BY r.created_at, r.rowid`).all(roomKey, since)
          : db().prepare('SELECT * FROM team_reactions WHERE room_key = ? ORDER BY created_at, rowid').all(roomKey);
      const out = {};
      for (const r of rows) {
        const list = (out[r.message_id] ??= []);
        let s = list.find(x => x.emoji === r.emoji);
        if (!s) list.push(s = { emoji: r.emoji, count: 0, identities: [] });
        s.count++;
        s.identities.push({ id: r.person_id, ...(r.name ? { label: r.name } : {}) });
      }
      return messageId ? out[messageId] || [] : out;
    },

    /** Whether an entry was written at `since` (ms) or later. */
    entrySince(roomKey, messageId, since) {
      return !!db().prepare('SELECT 1 FROM team_entries WHERE room_key = ? AND message_id = ? AND COALESCE(host_ts, created_at) >= ?').get(roomKey, messageId, since);
    },

    /** Reactions added or removed after `since` (ms), oldest first: { messageId, emoji, name, action, ts }. */
    reactionLog(roomKey, since) {
      return db().prepare('SELECT message_id, emoji, name, action, created_at FROM team_reaction_log WHERE room_key = ? AND created_at > ? ORDER BY created_at, rowid LIMIT 50').all(roomKey, since)
        .map(r => ({ messageId: r.message_id, emoji: r.emoji, name: r.name, action: r.action, ts: r.created_at }));
    },

    _logReaction(roomKey, messageId, emoji, name, action, now) {
      const g = db();
      g.prepare('INSERT INTO team_reaction_log (room_key, message_id, emoji, name, action, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(roomKey, messageId, emoji, name || null, action, now);
      g.prepare('DELETE FROM team_reaction_log WHERE room_key = ? AND created_at < ?').run(roomKey, now - 30 * 86_400_000); // agents that sat out a month don't need them
    },

    /** Takes an agent out of the room; its working session stays hidden (reused if it's added back). */
    removeMember(roomKey, agentId) {
      db().prepare('UPDATE team_members SET removed = 1 WHERE room_key = ? AND agent_id = ?').run(roomKey, agentId);
    },

    setWorkKey(roomKey, agentId, workKey) {
      db().prepare('UPDATE team_members SET work_key = ? WHERE room_key = ? AND agent_id = ?').run(workKey, roomKey, agentId);
    },

    /** The session of an agent's lane ('owner' or 'guest:<share>') was made again: see team_rebuilt. */
    markLaneRebuilt(roomKey, agentId, lane) {
      db().prepare('INSERT OR IGNORE INTO team_rebuilt (room_key, agent_id, lane) VALUES (?, ?, ?)').run(roomKey, agentId, lane);
    },

    laneRebuilt(roomKey, agentId, lane) {
      return !!db().prepare('SELECT 1 FROM team_rebuilt WHERE room_key = ? AND agent_id = ? AND lane = ?').get(roomKey, agentId, lane);
    },

    clearLaneRebuilt(roomKey, agentId, lane) {
      db().prepare('DELETE FROM team_rebuilt WHERE room_key = ? AND agent_id = ? AND lane = ?').run(roomKey, agentId, lane);
    },

    setSeenAt(roomKey, agentId, seenAt) {
      db().prepare('UPDATE team_members SET seen_at = MAX(seen_at, ?) WHERE room_key = ? AND agent_id = ?').run(seenAt, roomKey, agentId);
    },

    /** An agent's other session in the room (lane 'guest:<who>'): the newest entry it was given, or null before its first turn. */
    laneSeenAt(roomKey, agentId, lane) {
      return db().prepare('SELECT seen_at FROM team_lanes WHERE room_key = ? AND agent_id = ? AND lane = ?').get(roomKey, agentId, lane)?.seen_at ?? null;
    },

    setLaneSeenAt(roomKey, agentId, lane, seenAt) {
      db().prepare('INSERT INTO team_lanes (room_key, agent_id, lane, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(room_key, agent_id, lane) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)').run(roomKey, agentId, lane, seenAt);
    },

    /** Put a seen point back as it was (a turn that never ran). Lane `null`: the agent's own; seenAt null: before the lane's first turn. */
    resetSeenAt(roomKey, agentId, lane, seenAt) {
      if (!lane) db().prepare('UPDATE team_members SET seen_at = ? WHERE room_key = ? AND agent_id = ?').run(seenAt || 0, roomKey, agentId);
      else if (seenAt === null) db().prepare('DELETE FROM team_lanes WHERE room_key = ? AND agent_id = ? AND lane = ?').run(roomKey, agentId, lane);
      else db().prepare('INSERT INTO team_lanes (room_key, agent_id, lane, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(room_key, agent_id, lane) DO UPDATE SET seen_at = excluded.seen_at').run(roomKey, agentId, lane, seenAt);
    },

    setDiscuss(roomKey, discuss) {
      db().prepare('UPDATE team_rooms SET discuss = ?, updated_at = ? WHERE room_key = ?').run(discuss ? 1 : 0, Date.now(), roomKey);
    },

    setRounds(roomKey, rounds) {
      db().prepare('UPDATE team_rooms SET rounds = ?, updated_at = ? WHERE room_key = ?').run(rounds, Date.now(), roomKey);
    },

    /** Drops the room; returns the working session keys it had. */
    deleteRoom(roomKey) {
      const work = db().prepare('SELECT work_key FROM team_members WHERE room_key = ? AND work_key IS NOT NULL').all(roomKey).map(m => m.work_key);
      const g = db();
      g.prepare('DELETE FROM team_members WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_entries WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_people WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_mirror WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_lanes WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_rebuilt WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_inflight WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_reactions WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_reaction_log WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_rooms WHERE room_key = ?').run(roomKey);
      return work;
    },

    /** An agent turn was sent (team_inflight): { agentId, round, kind, runId, workKey?, mode, turn?, post? }. */
    inflightStart(roomKey, { agentId, round, kind, runId, workKey = null, mode = null, turn = null, post = null }) {
      db().prepare('INSERT OR REPLACE INTO team_inflight (room_key, agent_id, round, kind, run_id, work_key, mode, turn_json, post_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomKey, agentId, round, kind, runId, workKey, mode, turn ? JSON.stringify(turn) : null, post ? JSON.stringify(post) : null, Date.now());
    },

    /** Its reply is in the room (or it had none): text / authority feed the next round. */
    inflightDone(roomKey, agentId, { text = null, authority = null } = {}) {
      db().prepare('UPDATE team_inflight SET done = 1, text = ?, authority = ? WHERE room_key = ? AND agent_id = ?').run(text, authority, roomKey, agentId);
    },

    inflightClear(roomKey) {
      db().prepare('DELETE FROM team_inflight WHERE room_key = ?').run(roomKey);
    },

    /** Map roomKey -> rows of the round each room was in: [{ agentId, round, kind, runId, workKey, mode, turn, post, startedAt, done, text, authority }]. */
    inflightByRoom() {
      const out = new Map();
      for (const r of db().prepare('SELECT * FROM team_inflight ORDER BY started_at').all()) {
        const row = { agentId: r.agent_id, round: r.round, kind: r.kind, runId: r.run_id, workKey: r.work_key, mode: r.mode,
          turn: r.turn_json ? JSON.parse(r.turn_json) : null, post: r.post_json ? JSON.parse(r.post_json) : {}, startedAt: r.started_at,
          done: !!r.done, text: r.text, authority: r.authority };
        out.set(r.room_key, [...(out.get(r.room_key) || []), row]);
      }
      for (const [k, rows] of out) { const round = Math.max(...rows.map(r => r.round)); out.set(k, rows.filter(r => r.round === round)); }
      return out;
    },

    /** { roomKey, agentId } of a working session, or null. */
    workSession(workKey) {
      const m = db().prepare('SELECT room_key, agent_id FROM team_members WHERE work_key = ? AND removed = 0').get(workKey);
      return m ? { roomKey: m.room_key, agentId: m.agent_id } : null;
    },

    /** Set of every working session key (the lens hides these). */
    workKeys() {
      return new Set(db().prepare('SELECT work_key FROM team_members WHERE work_key IS NOT NULL').all().map(r => r.work_key));
    },

    /** Every working session, removed members' included: [{ roomKey, agentId, workKey }]. */
    workLanes() {
      return db().prepare('SELECT room_key, agent_id, work_key FROM team_members WHERE work_key IS NOT NULL').all()
        .map(r => ({ roomKey: r.room_key, agentId: r.agent_id, workKey: r.work_key }));
    },

    /** The room a working session answers in, or null. */
    roomOfWorkKey(workKey) {
      return db().prepare('SELECT room_key FROM team_members WHERE work_key = ?').get(workKey)?.room_key || null;
    },

    /**
     * type 'user' (this gateway's own person), 'person' (someone else; agentId holds their person id
     * and actingFor their name), or 'agent' (actingFor: whose request it answered, if not its owner's).
     */
    recordEntry(roomKey, messageId, { type, agentId = null, actingFor = null, ts = null, ownerId = null, ref = null, via = null }) {
      db().prepare('INSERT OR REPLACE INTO team_entries (room_key, message_id, author_type, agent_id, created_at, acting_for, host_ts, owner_id, ref, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomKey, messageId, ['user', 'person', 'system'].includes(type) ? type : 'agent', agentId, Date.now(), actingFor, ts || null, ownerId, ref, via);
    },

    /**
     * { [messageId]: { type: 'user'|'agent'|'system', agentId, actingFor?, ts?, ownerId?, ref?, via? } | { type: 'person', personId, name } }
     * ts: the entry's original time when this is a copy of someone else's room.
     */
    authors(roomKey) {
      const out = {};
      for (const r of db().prepare('SELECT message_id, author_type, agent_id, acting_for, host_ts, owner_id, ref, via FROM team_entries WHERE room_key = ?').all(roomKey)) {
        const extra = { ...(r.host_ts ? { ts: r.host_ts } : {}), ...(r.owner_id ? { ownerId: r.owner_id } : {}), ...(r.ref ? { ref: r.ref } : {}), ...(r.via ? { via: r.via } : {}) };
        out[r.message_id] = r.author_type === 'person'
          ? { type: 'person', personId: r.agent_id, name: r.acting_for, ...extra }
          : { type: r.author_type, agentId: r.agent_id, ...(r.acting_for ? { actingFor: r.acting_for } : {}), ...extra };
      }
      return out;
    },
  };
}
