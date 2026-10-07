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

const DISCUSS_ROUNDS = 3; // default; each room can set 1..MAX_ROUNDS
const MAX_ROUNDS = 10;

function roomRow(r, members, people = []) {
  return {
    roomKey: r.room_key,
    discuss: !!r.discuss,
    rounds: r.rounds || DISCUSS_ROUNDS,
    sourceKey: r.source_key || null,
    createdAt: r.created_at,
    members: members.map(m => ({ agentId: m.agent_id, workKey: m.work_key || null, seenAt: m.seen_at || 0, history: m.history || 'all' })),
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
      const rc = cols('team_rooms');
      for (const c of ['host_gateway_id', 'host_room', 'host_name', 'host_ended', 'replica_json']) if (!rc.has(c)) g.exec(`ALTER TABLE team_rooms ADD COLUMN ${c} TEXT`);
      g.exec(`CREATE TABLE IF NOT EXISTS team_people (room_key TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, history_from INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_key, person_id))`);
      g.exec(`CREATE TABLE IF NOT EXISTS team_mirror (room_key TEXT NOT NULL, host_entry_id TEXT NOT NULL, message_id TEXT, PRIMARY KEY (room_key, host_entry_id))`);
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
      db().prepare('INSERT INTO team_members (room_key, agent_id, work_key, seen_at, position, history) VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(room_key, agent_id) DO UPDATE SET removed = 0, position = excluded.position WHERE removed = 1')
        .run(roomKey, agentId, seenAt, pos, history === 'now' ? 'now' : 'all');
      return true;
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

    /** Takes an agent out of the room; its working session stays hidden (reused if it's added back). */
    removeMember(roomKey, agentId) {
      db().prepare('UPDATE team_members SET removed = 1 WHERE room_key = ? AND agent_id = ?').run(roomKey, agentId);
    },

    setWorkKey(roomKey, agentId, workKey) {
      db().prepare('UPDATE team_members SET work_key = ? WHERE room_key = ? AND agent_id = ?').run(workKey, roomKey, agentId);
    },

    setSeenAt(roomKey, agentId, seenAt) {
      db().prepare('UPDATE team_members SET seen_at = MAX(seen_at, ?) WHERE room_key = ? AND agent_id = ?').run(seenAt, roomKey, agentId);
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
      g.prepare('DELETE FROM team_rooms WHERE room_key = ?').run(roomKey);
      return work;
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

    /**
     * type 'user' (this gateway's own person), 'person' (someone else; agentId holds their person id
     * and actingFor their name), or 'agent' (actingFor: whose request it answered, if not its owner's).
     */
    recordEntry(roomKey, messageId, { type, agentId = null, actingFor = null }) {
      db().prepare('INSERT OR REPLACE INTO team_entries (room_key, message_id, author_type, agent_id, created_at, acting_for) VALUES (?, ?, ?, ?, ?, ?)')
        .run(roomKey, messageId, ['user', 'person'].includes(type) ? type : 'agent', agentId, Date.now(), actingFor);
    },

    /** { [messageId]: { type: 'user'|'agent', agentId, actingFor? } | { type: 'person', personId, name } } */
    authors(roomKey) {
      const out = {};
      for (const r of db().prepare('SELECT message_id, author_type, agent_id, acting_for FROM team_entries WHERE room_key = ?').all(roomKey)) {
        out[r.message_id] = r.author_type === 'person'
          ? { type: 'person', personId: r.agent_id, name: r.acting_for }
          : { type: r.author_type, agentId: r.agent_id, ...(r.acting_for ? { actingFor: r.acting_for } : {}) };
      }
      return out;
    },
  };
}
