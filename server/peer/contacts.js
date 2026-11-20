// Contacts: the per-person settings of the contact card (owner side), the agent copies made for each person, and one
// usage counter per person (D10). Keyed by the person's lowercased email: one person can have several gateways (D8),
// and every share with any of them uses the same settings. Local only: none of it goes into the signed grant except
// access and autonomy.

import { ACCESS, AUTONOMY, COMMANDS, KNOWLEDGE, defaultContact, DEFAULT_TOOLS, DEFAULT_COMMANDS, validateBasicEntry } from './contact-policy.js';

const JSON_FIELDS = ['notes', 'repos', 'agents', 'tools', 'basicList', 'skills', 'mcp', 'mcpToolsDeny'];
const COLUMNS = { basicList: 'basic_list', alwaysFine: 'always_fine', openFolder: 'open_folder', mcpToolsDeny: 'mcp_tools_deny', private: 'private_text' };
const col = f => COLUMNS[f] || f;
export const personKeyOf = email => String(email || '').trim().toLowerCase();

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const thisHour = (now = Date.now()) => new Date(now).toISOString().slice(0, 13);

export class ContactBook {
  constructor(getDb) { this.getDb = getDb; this._ready = false; }

  db() {
    const g = this.getDb();
    if (!this._ready) {
      g.exec(`CREATE TABLE IF NOT EXISTS peer_contact (person_key TEXT PRIMARY KEY, name TEXT, access TEXT NOT NULL, autonomy TEXT NOT NULL,
        knowledge TEXT NOT NULL, notes TEXT, repos TEXT, agents TEXT, tools TEXT, commands TEXT NOT NULL, basic_list TEXT, skills TEXT, mcp TEXT,
        mcp_tools_deny TEXT, private_text TEXT, always_fine TEXT, open_folder TEXT, full_confirmed_at INTEGER, migrated INTEGER NOT NULL DEFAULT 0,
        notes_sync TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      g.exec(`CREATE TABLE IF NOT EXISTS peer_copy (person_key TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, copy_id TEXT NOT NULL,
        policy_hash TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, PRIMARY KEY (person_key, agent_id, kind))`);
      g.exec('CREATE TABLE IF NOT EXISTS peer_person_usage (person_key TEXT NOT NULL, win TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (person_key, win))');
      this._ready = true;
    }
    return g;
  }

  _row(r) {
    if (!r) return null;
    const c = { personKey: r.person_key, name: r.name, access: r.access, autonomy: r.autonomy, knowledge: r.knowledge, commands: r.commands,
      private: r.private_text || '', alwaysFine: r.always_fine || '', openFolder: r.open_folder || null, fullConfirmedAt: r.full_confirmed_at || null,
      migrated: !!r.migrated, notesSync: r.notes_sync ? JSON.parse(r.notes_sync) : null, updatedAt: r.updated_at };
    for (const f of JSON_FIELDS) { try { c[f] = r[col(f)] == null ? null : JSON.parse(r[col(f)]); } catch { c[f] = null; } }
    c.repos ||= []; c.tools ||= []; c.skills ||= []; c.mcp ||= {}; c.mcpToolsDeny ||= {};
    return c;
  }

  get(personKey) { return this._row(this.db().prepare('SELECT * FROM peer_contact WHERE person_key = ?').get(personKeyOf(personKey))); }
  all() { return this.db().prepare('SELECT * FROM peer_contact').all().map(r => this._row(r)); }

  /** Create a contact (first-time accept or migration). Returns it; an existing one is returned unchanged. */
  create(personKey, fields = {}) {
    const key = personKeyOf(personKey);
    if (!key) throw new Error('A contact needs an email');
    const have = this.get(key);
    if (have) return have;
    const c = { ...defaultContact(fields.access || 'trusted'), ...fields };
    const now = Date.now();
    this.db().prepare(`INSERT INTO peer_contact (person_key, name, access, autonomy, knowledge, notes, repos, agents, tools, commands, basic_list, skills, mcp,
      mcp_tools_deny, private_text, always_fine, open_folder, full_confirmed_at, migrated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, c.name || null, c.access, c.autonomy, c.knowledge, js(c.notes), js(c.repos), js(c.agents), js(c.tools), c.commands, js(c.basicList),
        js(c.skills), js(c.mcp), js(c.mcpToolsDeny), c.private || '', c.alwaysFine || '', c.openFolder || null, c.fullConfirmedAt || null, c.migrated ? 1 : 0, now, now);
    return this.get(key);
  }

  /**
   * Change one setting (the card saves per control). Validates the value; changing Access resets Tools and Commands to
   * that tier's defaults (they're presets of the tier) and needs `confirmFull` the first time it goes to Full agent.
   */
  set(personKey, field, value, { confirmFull = false } = {}) {
    const c = this.get(personKey);
    if (!c) throw new Error('Not a contact');
    const patch = {};
    switch (field) {
      case 'access':
        if (!ACCESS.includes(value)) throw new Error('Unknown access level');
        if (value === 'full' && !c.fullConfirmedAt && !confirmFull) throw Object.assign(new Error('Full agent needs confirming'), { code: 'confirm_full' });
        Object.assign(patch, { access: value, tools: [...DEFAULT_TOOLS[value]], commands: DEFAULT_COMMANDS[value], openFolder: null });
        if (value === 'full' && !c.fullConfirmedAt) patch.fullConfirmedAt = Date.now();
        break;
      case 'autonomy': if (!AUTONOMY[value]) throw new Error('Unknown autonomy'); patch.autonomy = value; break;
      case 'knowledge': if (!KNOWLEDGE.includes(value)) throw new Error('Unknown knowledge setting'); patch.knowledge = value; break;
      case 'commands':
        if (!COMMANDS.includes(value)) throw new Error('Unknown commands setting');
        if (c.openFolder && (value === 'off' || value === 'basic')) throw new Error('"Open one folder" needs Commands set to "ask me" or "auto-review"');
        patch.commands = value; break;
      case 'tools': patch.tools = strings(value, 40); break;
      case 'skills': patch.skills = strings(value, 500); break;
      case 'agents': patch.agents = strings(value, 50); break;
      case 'notes': patch.notes = strings(value, 200); break;
      case 'repos': patch.repos = strings(value, 20).filter(r => r.startsWith('/')); break;
      case 'mcp': patch.mcp = boolMap(value); break;
      case 'mcpToolsDeny': patch.mcpToolsDeny = Object.fromEntries(Object.entries(value || {}).map(([k, v]) => [String(k), strings(v, 200)])); break;
      case 'basicList': {
        if (value === null) { patch.basicList = null; break; }
        if (!Array.isArray(value)) throw new Error('basicList must be a list');
        const list = value.slice(0, 60).map(e => ({ pattern: String(e?.pattern || '').trim(), argPattern: e?.argPattern ? String(e.argPattern) : '', args: e?.args ? String(e.args).slice(0, 80) : '' }));
        for (const e of list) { const v = validateBasicEntry(e); if (!v.ok) throw Object.assign(new Error(v.error), { code: 'bad_entry', entry: e.pattern }); }
        patch.basicList = list; break;
      }
      case 'private': patch.private = String(value || '').slice(0, 2000); break;
      case 'alwaysFine': patch.alwaysFine = String(value || '').slice(0, 2000); break;
      case 'openFolder':
        if (value && c.access !== 'full') throw new Error('"Open one folder" is for Full agent');
        if (value && (c.commands === 'off' || c.commands === 'basic')) throw new Error('"Open one folder" needs Commands set to "ask me" or "auto-review"');
        patch.openFolder = value ? String(value) : null; break;
      case 'name': patch.name = String(value || '').slice(0, 80) || null; break;
      case 'migrated': patch.migrated = value ? 1 : 0; break;
      default: throw new Error(`Unknown setting: ${field}`);
    }
    this._write(c.personKey, patch);
    return this.get(c.personKey);
  }

  _write(personKey, patch) {
    const sets = [], vals = [];
    for (const [f, v] of Object.entries(patch)) {
      const name = f === 'fullConfirmedAt' ? 'full_confirmed_at' : col(f);
      sets.push(`${name} = ?`);
      vals.push(JSON_FIELDS.includes(f) ? js(v) : v);
    }
    sets.push('updated_at = ?'); vals.push(Date.now());
    this.db().prepare(`UPDATE peer_contact SET ${sets.join(', ')} WHERE person_key = ?`).run(...vals, personKeyOf(personKey));
  }

  setNotesSync(personKey, summary) { this.db().prepare('UPDATE peer_contact SET notes_sync = ? WHERE person_key = ?').run(js(summary), personKeyOf(personKey)); }

  /**
   * Everything kept for a person goes (Disconnect). Their copies are retired by the caller first and stay listed as
   * kind 'retired-guest' / 'retired-full' (hidden from agent pickers, never served: there's no grant and no contact).
   */
  forget(personKey) {
    const key = personKeyOf(personKey);
    const db = this.db();
    db.prepare('DELETE FROM peer_contact WHERE person_key = ?').run(key);
    db.prepare("UPDATE OR REPLACE peer_copy SET kind = 'retired-' || kind, policy_hash = NULL WHERE person_key = ? AND kind NOT LIKE 'retired-%'").run(key);
    db.prepare('DELETE FROM peer_person_usage WHERE person_key = ?').run(key);
  }

  // ── Copies ──
  copies(personKey = null) {
    const rows = personKey ? this.db().prepare('SELECT * FROM peer_copy WHERE person_key = ?').all(personKeyOf(personKey)) : this.db().prepare('SELECT * FROM peer_copy').all();
    return rows.map(r => ({ personKey: r.person_key, agentId: r.agent_id, kind: r.kind, copyId: r.copy_id, policyHash: r.policy_hash, lastUsedAt: r.last_used_at }));
  }
  copy(personKey, agentId, kind) { return this.copies(personKey).find(r => r.agentId === agentId && r.kind === kind) || null; }
  copyIds() { return new Set(this.db().prepare('SELECT copy_id FROM peer_copy').all().map(r => r.copy_id)); }
  putCopy(personKey, agentId, kind, copyId, policyHash) {
    this.db().prepare(`INSERT INTO peer_copy (person_key, agent_id, kind, copy_id, policy_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(person_key, agent_id, kind) DO UPDATE SET copy_id = excluded.copy_id, policy_hash = excluded.policy_hash`).run(personKeyOf(personKey), agentId, kind, copyId, policyHash, Date.now());
  }
  touchCopy(copyId) { this.db().prepare('UPDATE peer_copy SET last_used_at = ? WHERE copy_id = ?').run(Date.now(), copyId); }
  dropCopy(copyId) { this.db().prepare('DELETE FROM peer_copy WHERE copy_id = ?').run(copyId); }
  /** A copy no longer in use (its access tier changed, or Disconnect): kept, locked down, hidden. */
  retireCopyRow(copyId) { this.db().prepare("UPDATE OR REPLACE peer_copy SET kind = 'retired-' || kind, policy_hash = NULL WHERE copy_id = ? AND kind NOT LIKE 'retired-%'").run(copyId); }

  // ── One counter per person (D10) ──
  usage(personKey, now = Date.now()) {
    const g = this.db().prepare('SELECT win, n FROM peer_person_usage WHERE person_key = ? AND win IN (?, ?)').all(personKeyOf(personKey), `d:${today(now)}`, `h:${thisHour(now)}`);
    return { day: g.find(r => r.win.startsWith('d:'))?.n || 0, hour: g.find(r => r.win.startsWith('h:'))?.n || 0 };
  }
  /** Over the tier's limit? Returns the reason, else null. */
  overCap(personKey, autonomy, now = Date.now()) {
    const t = AUTONOMY[autonomy] || AUTONOMY.bounded;
    const u = this.usage(personKey, now);
    if (u.day >= t.perDay) return `Daily limit reached (${t.perDay} replies)`;
    if (t.perHour && u.hour >= t.perHour) return `Hourly limit reached (${t.perHour} replies an hour)`;
    return null;
  }
  count(personKey, delta = 1, now = Date.now()) {
    const st = this.db().prepare(`INSERT INTO peer_person_usage (person_key, win, n) VALUES (?, ?, MAX(0, ?)) ON CONFLICT(person_key, win) DO UPDATE SET n = MAX(0, n + ?)`);
    for (const w of [`d:${today(now)}`, `h:${thisHour(now)}`]) st.run(personKeyOf(personKey), w, delta, delta);
    // Old windows go: a day of hours is enough.
    this.db().prepare("DELETE FROM peer_person_usage WHERE (win LIKE 'h:%' AND win < ?) OR (win LIKE 'd:%' AND win < ?)").run(`h:${thisHour(now - 86_400_000)}`, `d:${today(now - 7 * 86_400_000)}`);
  }
}

const js = v => (v === undefined || v === null ? null : JSON.stringify(v));
const strings = (v, max) => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x).map(x => x.slice(0, 500)))].slice(0, max) : []);
const boolMap = v => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).map(([k, b]) => [String(k).slice(0, 100), !!b]));
