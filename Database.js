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
        status TEXT NOT NULL DEFAULT 'queued'
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
    `);

    this.stmts = {
      upsertArtist: this.db.prepare(`INSERT OR REPLACE INTO artists (id, name, name_lower, cached_at) VALUES (?, ?, ?, strftime('%s', 'now'))`),
      upsertTitle: this.db.prepare(`INSERT OR REPLACE INTO titles (id, name, name_lower, cached_at) VALUES (?, ?, ?, strftime('%s', 'now'))`),
      searchArtists: this.db.prepare(`SELECT * FROM artists WHERE name_lower LIKE ? LIMIT 50`),
      searchTitles: this.db.prepare(`SELECT * FROM titles WHERE name_lower LIKE ? LIMIT 50`),
      addToQueue: this.db.prepare(`INSERT INTO queue (artist, title, requested_by, requested_by_id) VALUES (?, ?, ?, ?)`),
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
    };
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

  addToQueue(artist, title, requestedBy, requestedById) {
    const info = this.stmts.addToQueue.run(artist, title, requestedBy, requestedById);
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
