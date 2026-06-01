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
        week_start TEXT NOT NULL,
        UNIQUE(username, week_start)
      );
    `);

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
      addGiveawayEntry: this.db.prepare(`INSERT INTO giveaway_entries (username, user_id, is_subscriber, entries, week_start) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username, week_start) DO UPDATE SET is_subscriber = excluded.is_subscriber, entries = giveaway_entries.entries`),
      getGiveawayEntries: this.db.prepare(`SELECT * FROM giveaway_entries WHERE week_start = ? ORDER BY created_at ASC`),
      clearGiveawayEntries: this.db.prepare(`DELETE FROM giveaway_entries WHERE week_start = ?`),
      clearAllGiveawayEntries: this.db.prepare(`DELETE FROM giveaway_entries`),
    };
  }

  static getCurrentWeekStart() {
    const now = new Date();
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday.toISOString().split('T')[0];
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

  addGiveawayEntry(username, userId, isSubscriber) {
    const weekStart = SongDatabase.getCurrentWeekStart();
    const entries = isSubscriber ? 2 : 1;
    this.stmts.addGiveawayEntry.run(username, userId, isSubscriber ? 1 : 0, entries, weekStart);
  }

  getGiveawayEntries(weekStart) {
    return this.stmts.getGiveawayEntries.all(weekStart || SongDatabase.getCurrentWeekStart());
  }

  clearOldGiveawayEntries() {
    const currentWeek = SongDatabase.getCurrentWeekStart();
    // Delete entries from previous weeks
    this.db.prepare(`DELETE FROM giveaway_entries WHERE week_start < ?`).run(currentWeek);
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
