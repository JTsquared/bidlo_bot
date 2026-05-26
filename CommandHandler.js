class CommandHandler {
  constructor(db, customsForge, sendMessage, streamerUsername) {
    this.db = db;
    this.cf = customsForge;
    this.sendMessage = sendMessage;
    this.streamerUsername = streamerUsername?.toLowerCase();
    this.pendingPicks = new Map();
    this.pickTimeout = 60000;
  }

  isStreamer(username) {
    return username.toLowerCase() === this.streamerUsername;
  }

  async handle(username, userId, text, channelId) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('!')) return;

    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    switch (command) {
      case '!request':
      case '!sr':
        return this.handleRequest(username, userId, args, channelId);
      case '!pick':
        return this.handlePick(username, userId, args, channelId);
      case '!queue':
      case '!q':
        return this.handleQueue(channelId);
      case '!np':
      case '!nowplaying':
        return this.handleNowPlaying(channelId);
      case '!skip':
        return this.handleSkip(username, channelId);
      case '!next':
        return this.handleNext(username, channelId);
      case '!clear':
        return this.handleClear(username, channelId);
      case '!accuracy':
        return this.handleAccuracy(username, userId, args, channelId);
      case '!reveal':
        return this.handleReveal(username, args, channelId);
      case '!clearguesses':
        return this.handleClearGuesses(username, channelId);
      case '!guesses':
        return this.handleShowGuesses(channelId);
    }
  }

  async handleRequest(username, userId, query, channelId) {
    if (!query) {
      return this.sendMessage(channelId, `@${username} Usage: !request <artist> - <song> or !request <song>`);
    }

    let results = [];

    // Prefer live search when CustomsForge is connected
    if (this.cf) {
      const cfResult = await this.cf.search(query);

      if (cfResult.authExpired) {
        return this.sendMessage(channelId, `@${username} Song search is temporarily unavailable. Please try again later.`);
      }

      results = cfResult.results;

      if (cfResult.results.length > 0) {
        const titleItems = cfResult.results.map((r) => ({ id: r.title, text: r.title }));
        this.db.cacheTitles(titleItems);
      }
    }

    // Fall back to local cache if live search unavailable or returned nothing
    if (results.length === 0) {
      const localTitles = this.db.searchTitlesLocal(query);
      if (localTitles.length > 0) {
        results = localTitles.map((t) => ({ artist: '', title: t.name }));
      }
    }

    if (results.length === 0) {
      return this.sendMessage(channelId, `@${username} No songs found for "${query}". Try a different search.`);
    }

    if (results.length === 1) {
      const song = results[0];
      const display = song.artist ? `${song.artist} - ${song.title}` : song.title;
      const queueId = this.db.addToQueue(song.artist || 'Unknown', song.title, username, userId);
      const position = this.db.getQueue().length;
      return this.sendMessage(channelId, `@${username} Added "${display}" to the queue! (Position #${position})`);
    }

    const maxShow = Math.min(results.length, 8);
    const displayResults = results.slice(0, maxShow);

    this.pendingPicks.set(username.toLowerCase(), {
      results: displayResults,
      userId,
      timestamp: Date.now(),
    });

    setTimeout(() => {
      const pending = this.pendingPicks.get(username.toLowerCase());
      if (pending && Date.now() - pending.timestamp >= this.pickTimeout) {
        this.pendingPicks.delete(username.toLowerCase());
      }
    }, this.pickTimeout + 1000);

    const lines = displayResults.map((r, i) => {
      const display = r.artist ? `${r.artist} - ${r.title}` : r.title;
      return `${i + 1}. ${display}`;
    });

    await this.sendMessage(channelId, `@${username} Found ${results.length} matches: ${lines.join(' | ')} — Reply !pick 1-${maxShow} to select`);
  }

  async handlePick(username, userId, args, channelId) {
    const key = username.toLowerCase();
    const pending = this.pendingPicks.get(key);

    if (!pending) {
      return this.sendMessage(channelId, `@${username} You don't have a pending song selection. Use !request first.`);
    }

    const num = parseInt(args, 10);
    if (isNaN(num) || num < 1 || num > pending.results.length) {
      return this.sendMessage(channelId, `@${username} Pick a number between 1 and ${pending.results.length}`);
    }

    const song = pending.results[num - 1];
    this.pendingPicks.delete(key);

    const display = song.artist ? `${song.artist} - ${song.title}` : song.title;
    this.db.addToQueue(song.artist || 'Unknown', song.title, username, userId);
    const position = this.db.getQueue().length;

    return this.sendMessage(channelId, `@${username} Added "${display}" to the queue! (Position #${position})`);
  }

  async handleQueue(channelId) {
    const queue = this.db.getQueue();
    const nowPlaying = this.db.getNowPlaying();

    if (!nowPlaying && queue.length === 0) {
      return this.sendMessage(channelId, 'The queue is empty! Use !request to add a song.');
    }

    let msg = '';
    if (nowPlaying) {
      msg += `Now Playing: ${nowPlaying.artist} - ${nowPlaying.title} (req by ${nowPlaying.requested_by}). `;
    }

    if (queue.length === 0) {
      msg += 'Queue is empty.';
    } else {
      const items = queue.slice(0, 5).map((q, i) => `${i + 1}. ${q.artist} - ${q.title} (${q.requested_by})`);
      msg += `Queue (${queue.length}): ${items.join(' | ')}`;
      if (queue.length > 5) msg += ` ...and ${queue.length - 5} more`;
    }

    return this.sendMessage(channelId, msg);
  }

  async handleNowPlaying(channelId) {
    const nowPlaying = this.db.getNowPlaying();
    if (!nowPlaying) {
      return this.sendMessage(channelId, 'Nothing is currently playing.');
    }
    return this.sendMessage(channelId, `Now Playing: ${nowPlaying.artist} - ${nowPlaying.title} (requested by ${nowPlaying.requested_by})`);
  }

  async handleNext(username, channelId) {
    if (!this.isStreamer(username)) {
      return this.sendMessage(channelId, `@${username} Only the streamer can use !next`);
    }
    this.db.clearGuesses();
    const next = this.db.nextSong();
    if (!next) {
      return this.sendMessage(channelId, 'No more songs in the queue!');
    }
    return this.sendMessage(channelId, `Now Playing: ${next.artist} - ${next.title} (requested by ${next.requested_by}) — Use !accuracy to guess!`);
  }

  async handleSkip(username, channelId) {
    if (!this.isStreamer(username)) {
      return this.sendMessage(channelId, `@${username} Only the streamer can use !skip`);
    }
    this.db.clearGuesses();
    const next = this.db.skipCurrent();
    if (!next) {
      return this.sendMessage(channelId, 'Skipped! No more songs in the queue.');
    }
    return this.sendMessage(channelId, `Skipped! Now Playing: ${next.artist} - ${next.title} (requested by ${next.requested_by})`);
  }

  async handleClear(username, channelId) {
    if (!this.isStreamer(username)) {
      return this.sendMessage(channelId, `@${username} Only the streamer can use !clear`);
    }
    this.db.clearQueue();
    this.db.clearGuesses();
    return this.sendMessage(channelId, 'Queue cleared!');
  }

  async handleAccuracy(username, userId, args, channelId) {
    const guess = parseFloat(args);
    if (isNaN(guess) || guess < 0 || guess > 100) {
      return this.sendMessage(channelId, `@${username} Usage: !accuracy <0-100> (e.g. !accuracy 92.5)`);
    }

    const nowPlaying = this.db.getNowPlaying();
    if (!nowPlaying) {
      return this.sendMessage(channelId, `@${username} No song is currently being played! Wait for the streamer to start.`);
    }

    this.db.addGuess(username, userId, guess, nowPlaying.id);
    return this.sendMessage(channelId, `@${username} Accuracy guess of ${guess}% recorded!`);
  }

  async handleReveal(username, args, channelId) {
    if (!this.isStreamer(username)) {
      return this.sendMessage(channelId, `@${username} Only the streamer can use !reveal`);
    }

    const actual = parseFloat(args);
    if (isNaN(actual) || actual < 0 || actual > 100) {
      return this.sendMessage(channelId, `Usage: !reveal <actual-accuracy> (e.g. !reveal 94.2)`);
    }

    const nowPlaying = this.db.getNowPlaying();
    if (!nowPlaying) {
      return this.sendMessage(channelId, 'No song is currently being played!');
    }

    const closest = this.db.findClosestGuess(nowPlaying.id, actual);
    if (!closest) {
      return this.sendMessage(channelId, `Actual accuracy: ${actual}% — No guesses were made!`);
    }

    const guesses = this.db.getGuesses(nowPlaying.id);
    return this.sendMessage(channelId, `Actual accuracy: ${actual}%! Winner: ${closest.username} guessed ${closest.guess}% (off by ${closest.diff.toFixed(1)}%) — ${guesses.length} total guesses`);
  }

  async handleClearGuesses(username, channelId) {
    if (!this.isStreamer(username)) {
      return this.sendMessage(channelId, `@${username} Only the streamer can use !clearguesses`);
    }
    this.db.clearGuesses();
    return this.sendMessage(channelId, 'All accuracy guesses cleared!');
  }

  async handleShowGuesses(channelId) {
    const nowPlaying = this.db.getNowPlaying();
    if (!nowPlaying) {
      return this.sendMessage(channelId, 'No song is currently being played!');
    }

    const guesses = this.db.getGuesses(nowPlaying.id);
    if (guesses.length === 0) {
      return this.sendMessage(channelId, 'No guesses yet! Use !accuracy <number> to guess.');
    }

    const list = guesses.map((g) => `${g.username}: ${g.guess}%`).join(', ');
    return this.sendMessage(channelId, `Guesses (${guesses.length}): ${list}`);
  }
}

module.exports = CommandHandler;
