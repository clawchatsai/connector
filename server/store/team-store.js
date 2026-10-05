// TeamStore: team chats (several agents in one ClawChats thread). Lives in the global DB.
// Registry entry: EXTRAS.md. Coordinator: server/team.js.
//
//   team_rooms    a room = a gateway session that never runs; its transcript is the shared timeline;
//                 source_key = the chat it was converted from (its history shows above the room)
//   team_members  one working session per agent per room (created on the agent's first turn);
//                 seen_at = timestamp of the newest room entry the agent has been given;
//                 removed = 1: agent taken out of the room; its session stays hidden and is reused
//                 if the agent is added back
//   team_entries  author of each injected room entry (the transcript only has a "[Label]" prefix)

const DISCUSS_ROUNDS = 3;

function roomRow(r, members) {
  return {
    roomKey: r.room_key,
    discuss: !!r.discuss,
    sourceKey: r.source_key || null,
    createdAt: r.created_at,
    members: members.map(m => ({ agentId: m.agent_id, workKey: m.work_key || null, seenAt: m.seen_at || 0 })),
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
      ready = true;
    }
    return g;
  }
  const members = roomKey => db().prepare('SELECT * FROM team_members WHERE room_key = ? AND removed = 0 ORDER BY position').all(roomKey);

  return {
    DISCUSS_ROUNDS,

    getRoom(roomKey) {
      const r = db().prepare('SELECT * FROM team_rooms WHERE room_key = ?').get(roomKey);
      return r ? roomRow(r, members(roomKey)) : null;
    },

    listRooms() {
      return db().prepare('SELECT * FROM team_rooms ORDER BY created_at').all().map(r => roomRow(r, members(r.room_key)));
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

    /** Adds an agent at the end (an agent removed earlier comes back with its session). Returns false if the room is unknown. */
    addMember(roomKey, agentId) {
      if (!this.getRoom(roomKey)) return false;
      const pos = db().prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM team_members WHERE room_key = ?').get(roomKey).p;
      db().prepare('INSERT INTO team_members (room_key, agent_id, work_key, seen_at, position) VALUES (?, ?, NULL, 0, ?) ON CONFLICT(room_key, agent_id) DO UPDATE SET removed = 0, position = excluded.position WHERE removed = 1').run(roomKey, agentId, pos);
      return true;
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

    /** Drops the room; returns the working session keys it had. */
    deleteRoom(roomKey) {
      const work = db().prepare('SELECT work_key FROM team_members WHERE room_key = ? AND work_key IS NOT NULL').all(roomKey).map(m => m.work_key);
      const g = db();
      g.prepare('DELETE FROM team_members WHERE room_key = ?').run(roomKey);
      g.prepare('DELETE FROM team_entries WHERE room_key = ?').run(roomKey);
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

    recordEntry(roomKey, messageId, { type, agentId = null }) {
      db().prepare('INSERT OR REPLACE INTO team_entries (room_key, message_id, author_type, agent_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(roomKey, messageId, type === 'user' ? 'user' : 'agent', agentId, Date.now());
    },

    /** { [messageId]: { type: 'user'|'agent', agentId } } */
    authors(roomKey) {
      const out = {};
      for (const r of db().prepare('SELECT message_id, author_type, agent_id FROM team_entries WHERE room_key = ?').all(roomKey)) {
        out[r.message_id] = { type: r.author_type, agentId: r.agent_id };
      }
      return out;
    },
  };
}
