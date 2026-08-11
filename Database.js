const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bidlo.db');

class SongDatabase {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        cached_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_artists_lower ON artists(name_lower);

      CREATE TABLE IF NOT EXISTS titles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        cached_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_titles_lower ON titles(name_lower);

      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_by_id TEXT,
        requested_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        status TEXT NOT NULL DEFAULT 'queued',
        cdlc_id INTEGER,
        paths_string TEXT,
        tuning_name TEXT,
        album TEXT,
        creator TEXT,
        downloads INTEGER
      );

      CREATE TABLE IF NOT EXISTS accuracy_guesses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        user_id TEXT,
        guess REAL NOT NULL,
        queue_item_id INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        UNIQUE(username, queue_item_id)
      );

      CREATE TABLE IF NOT EXISTS giveaway_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        user_id TEXT,
        is_subscriber INTEGER NOT NULL DEFAULT 0,
        entries INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        day_key TEXT NOT NULL,
        UNIQUE(username, day_key)
      );

      CREATE TABLE IF NOT EXISTS admin_auth (
        id INTEGER PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        expires_at INTEGER NOT NULL
      );
    `);

    // Migrate giveaway_entries: rename week_start to day_key
    try {
      this.db.exec(`ALTER TABLE giveaway_entries RENAME COLUMN week_start TO day_key`);
    } catch {}

    // Migrate existing queue table to add new columns
    const migrateCols = ['cdlc_id INTEGER', 'paths_string TEXT', 'tuning_name TEXT', 'album TEXT', 'creator TEXT', 'downloads INTEGER'];
    for (const col of migrateCols) {
      try { this.db.exec(`ALTER TABLE queue ADD COLUMN ${col}`); } catch {}
    }

    this.stmts = {
      upsertArtist: this.db.prepare(`INSERT OR REPLACE INTO artists (id, name, name_lower, cached_at) VALUES (?, ?, ?, strftime('%s', 'now'))`),
      upsertTitle: this.db.prepare(`INSERT OR REPLACE INTO titles (id, name, name_lower, cached_at) VALUES (?, ?, ?, strftime('%s', 'now'))`),
      searchArtists: this.db.prepare(`SELECT * FROM artists WHERE name_lower LIKE ? LIMIT 50`),
      searchTitles: this.db.prepare(`SELECT * FROM titles WHERE name_lower LIKE ? LIMIT 50`),
      addToQueue: this.db.prepare(`INSERT INTO queue (artist, title, requested_by, requested_by_id, cdlc_id, paths_string, tuning_name, album, creator, downloads) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      getQueue: this.db.prepare(`SELECT * FROM queue WHERE status = 'queued' ORDER BY id ASC`),
      getNowPlaying: this.db.prepare(`SELECT * FROM queue WHERE status = 'playing' LIMIT 1`),
      markPlaying: this.db.prepare(`UPDATE queue SET status = 'playing' WHERE id = ?`),
      markPlayed: this.db.prepare(`UPDATE queue SET status = 'played' WHERE id = ?`),
      clearPlayingStatus: this.db.prepare(`UPDATE queue SET status = 'played' WHERE status = 'playing'`),
      removeFromQueue: this.db.prepare(`DELETE FROM queue WHERE id = ?`),
      clearQueue: this.db.prepare(`DELETE FROM queue WHERE status = 'queued'`),
      addGuess: this.db.prepare(`INSERT OR REPLACE INTO accuracy_guesses (username, user_id, guess, queue_item_id, created_at) VALUES (?, ?, ?, ?, strftime('%s', 'now'))`),
      getGuesses: this.db.prepare(`SELECT * FROM accuracy_guesses WHERE queue_item_id = ? ORDER BY created_at ASC`),
      clearGuesses: this.db.prepare(`DELETE FROM accuracy_guesses WHERE queue_item_id = ?`),
      clearAllGuesses: this.db.prepare(`DELETE FROM accuracy_guesses`),
      artistCount: this.db.prepare(`SELECT COUNT(*) as count FROM artists`),
      titleCount: this.db.prepare(`SELECT COUNT(*) as count FROM titles`),
      addGiveawayEntry: this.db.prepare(`INSERT INTO giveaway_entries (username, user_id, is_subscriber, entries, day_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username, day_key) DO UPDATE SET entries = MAX(giveaway_entries.entries, excluded.entries), is_subscriber = MAX(giveaway_entries.is_subscriber, excluded.is_subscriber)`),
      forceAddGiveawayEntry: this.db.prepare(`INSERT INTO giveaway_entries (username, user_id, is_subscriber, entries, day_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username, day_key) DO UPDATE SET entries = giveaway_entries.entries + 1`),
      removeGiveawayEntry: this.db.prepare(`DELETE FROM giveaway_entries WHERE id = ?`),
      getGiveawayEntries: this.db.prepare(`SELECT * FROM giveaway_entries WHERE day_key = ? ORDER BY username COLLATE NOCASE ASC`),
      clearGiveawayEntries: this.db.prepare(`DELETE FROM giveaway_entries WHERE day_key = ?`),
      clearAllGiveawayEntries: this.db.prepare(`DELETE FROM giveaway_entries`),
    };
  }

  static getTodayKey() {
    // Day rolls over at 4:00 AM UTC (midnight EDT)
    const now = new Date();
    const adjusted = new Date(now.getTime() - 4 * 3600000);
    return adjusted.toISOString().split('T')[0];
  }

  cacheArtists(results) {
    const tx = this.db.transaction((items) => {
      for (const item of items) {
        this.stmts.upsertArtist.run(item.id, item.text.trim(), item.text.trim().toLowerCase());
      }
    });
    tx(results);
  }

  cacheTitles(results) {
    const tx = this.db.transaction((items) => {
      for (const item of items) {
        this.stmts.upsertTitle.run(String(item.id), item.text.trim(), item.text.trim().toLowerCase());
      }
    });
    tx(results);
  }

  searchArtistsLocal(query) {
    return this.stmts.searchArtists.all(`%${query.toLowerCase()}%`);
  }

  searchTitlesLocal(query) {
    return this.stmts.searchTitles.all(`%${query.toLowerCase()}%`);
  }

  addToQueue(artist, title, requestedBy, requestedById, extra = {}) {
    const info = this.stmts.addToQueue.run(
      artist, title, requestedBy, requestedById,
      extra.cdlc_id || null, extra.paths_string || null, extra.tuning_name || null,
      extra.album || null, extra.creator || null, extra.downloads || null
    );
    return info.lastInsertRowid;
  }

  getQueue() {
    return this.stmts.getQueue.all();
  }

  getNowPlaying() {
    return this.stmts.getNowPlaying.get() || null;
  }

  nextSong() {
    this.stmts.clearPlayingStatus.run();
    const next = this.db.prepare(`SELECT * FROM queue WHERE status = 'queued' ORDER BY id ASC LIMIT 1`).get();
    if (next) {
      this.stmts.markPlaying.run(next.id);
      return next;
    }
    return null;
  }

  skipCurrent() {
    const current = this.getNowPlaying();
    if (current) {
      this.stmts.markPlayed.run(current.id);
    }
    return this.nextSong();
  }

  removeFromQueue(id) {
    this.stmts.removeFromQueue.run(id);
  }

  clearQueue() {
    this.stmts.clearQueue.run();
  }

  addGuess(username, userId, guess, queueItemId) {
    this.stmts.addGuess.run(username, userId, guess, queueItemId);
  }

  getGuesses(queueItemId) {
    return this.stmts.getGuesses.all(queueItemId);
  }

  clearGuesses(queueItemId) {
    if (queueItemId) {
      this.stmts.clearGuesses.run(queueItemId);
    } else {
      this.stmts.clearAllGuesses.run();
    }
  }

  findClosestGuess(queueItemId, actualAccuracy) {
    const guesses = this.getGuesses(queueItemId);
    if (guesses.length === 0) return null;

    let closest = null;
    let smallestDiff = Infinity;

    for (const g of guesses) {
      const diff = Math.abs(g.guess - actualAccuracy);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        closest = g;
      }
    }
    return { ...closest, diff: smallestDiff };
  }

  addGiveawayEntry(username, userId, isSubscriber, extraEntry = false) {
    const dayKey = SongDatabase.getTodayKey();
    const normalizedName = username.toLowerCase();
    const entries = isSubscriber ? (extraEntry ? 2 : 1) : (extraEntry ? 1 : 0);
    if (entries === 0) return;
    this.stmts.addGiveawayEntry.run(normalizedName, userId, isSubscriber ? 1 : 0, entries, dayKey);
  }

  forceAddGiveawayEntry(username) {
    const dayKey = SongDatabase.getTodayKey();
    this.stmts.forceAddGiveawayEntry.run(username.toLowerCase(), null, 0, 1, dayKey);
  }

  removeGiveawayEntry(id) {
    this.stmts.removeGiveawayEntry.run(id);
  }

  addSubscriberBaseEntries(subscribers) {
    const dayKey = SongDatabase.getTodayKey();
    const tx = this.db.transaction((subs) => {
      for (const sub of subs) {
        const name = (sub.username || sub.displayName || '').toLowerCase();
        if (!name) continue;
        this.stmts.addGiveawayEntry.run(name, sub.userId || null, 1, 1, dayKey);
      }
    });
    tx(subscribers);
  }

  getGiveawayEntries(dayKey) {
    return this.stmts.getGiveawayEntries.all(dayKey || SongDatabase.getTodayKey());
  }

  clearOldGiveawayEntries() {
    const today = SongDatabase.getTodayKey();
    this.db.prepare(`DELETE FROM giveaway_entries WHERE day_key < ?`).run(today);
  }

  // --- Admin auth ---
  setAdminPassword(hash) {
    this.db.prepare(`DELETE FROM admin_auth`).run();
    this.db.prepare(`INSERT INTO admin_auth (id, password_hash) VALUES (1, ?)`).run(hash);
  }

  getAdminPasswordHash() {
    const row = this.db.prepare(`SELECT password_hash FROM admin_auth WHERE id = 1`).get();
    return row?.password_hash || null;
  }

  createSession(token, expiresInDays = 100) {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInDays * 86400;
    this.db.prepare(`INSERT OR REPLACE INTO admin_sessions (token, expires_at) VALUES (?, ?)`).run(token, expiresAt);
  }

  validateSession(token) {
    if (!token) return false;
    const row = this.db.prepare(`SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?`).get(token, Math.floor(Date.now() / 1000));
    return !!row;
  }

  cleanExpiredSessions() {
    this.db.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?`).run(Math.floor(Date.now() / 1000));
  }

  getStats() {
    return {
      artists: this.stmts.artistCount.get().count,
      titles: this.stmts.titleCount.get().count,
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = SongDatabase;
