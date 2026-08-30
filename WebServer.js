const http = require('http');
const { getOverlayHTML } = require('./overlay.js');

class WebServer {
  constructor(db, timedMessages, rsPlaylist, chatManager, port = 3000, options = {}) {
    this.db = db;
    this.timedMessages = timedMessages;
    this.rs = rsPlaylist;
    this.chatManager = chatManager;
    this.port = port;
    this.server = null;
    this.crypto = require('crypto');
    this.basePath = process.env.BASE_PATH || '';
    this.tokenManager = options.tokenManager || null;
    this.channelId = options.channelId || '';
    this.twitchTokenManager = options.twitchTokenManager || null;
    this.pendingOAuth = new Map(); // state → { platform, tokenType, codeVerifier?, createdAt }
  }

  start() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, () => {
      console.log(`Web UI running at http://localhost:${this.port}`);
    });
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Public routes — overlays don't need auth
    if (url.pathname === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getOverlayHTML());
      return;
    }

    if (url.pathname === '/chat-overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getChatOverlayHTML());
      return;
    }

    // Emote proxy endpoints (public)
    const emoteChannelMatch = url.pathname.match(/^\/bapi-proxy\/emotes\/channels\/(.+)$/);
    if (emoteChannelMatch) {
      return this.proxyEmotes(req, res, `https://blaze.stream/bapi/emotes/channels/${emoteChannelMatch[1]}`);
    }
    const emoteTypeMatch = url.pathname.match(/^\/bapi-proxy\/emotes\/(\w+)$/);
    if (emoteTypeMatch) {
      return this.proxyEmotes(req, res, `https://blaze.stream/bapi/emotes/${emoteTypeMatch[1]}`);
    }

    // Twitch OAuth callback (public — redirected here by Twitch)
    if (url.pathname === '/auth/twitch/callback') {
      return this.handleTwitchOAuthCallback(req, res, url);
    }

    // Public API endpoints (overlay data, chat)
    if (url.pathname === '/api/overlay/data' || url.pathname === '/api/chat') {
      return this.handleAPI(req, res, url);
    }

    // Login page
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        return this.handleLogin(req, res);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getLoginHTML());
      return;
    }

    // Protected routes — check auth
    if (!this.isAuthenticated(req)) {
      res.writeHead(302, { Location: this.basePath + '/login' });
      res.end();
      return;
    }

    // Twitch OAuth management (protected — admin must be logged in)
    if (url.pathname === '/auth/twitch') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getTwitchOAuthHTML());
      return;
    }
    if (url.pathname === '/auth/twitch/authorize') {
      return this.handleTwitchOAuthAuthorize(req, res, url);
    }

    if (url.pathname.startsWith('/api/')) {
      return this.handleAPI(req, res, url);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getDashboardHTML());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  async handleAPI(req, res, url) {
    const sendJSON = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const readBody = () => {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try { resolve(body ? JSON.parse(body) : {}); }
          catch (e) { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
      });
    };

    try {
      // GET /api/queue - get queue state
      if (url.pathname === '/api/queue' && req.method === 'GET') {
        const queue = this.db.getQueue().map((q) => ({ ...q, owned: this.rs.isOwned(q.artist, q.title) }));
        const np = this.db.getNowPlaying();
        const nowPlaying = np ? { ...np, owned: this.rs.isOwned(np.artist, np.title) } : null;
        return sendJSON(200, { queue, nowPlaying });
      }

      // POST /api/queue/next - advance to next song
      if (url.pathname === '/api/queue/next' && req.method === 'POST') {
        this.db.clearGuesses();
        const next = this.db.nextSong();
        return sendJSON(200, { nowPlaying: next, queue: this.db.getQueue() });
      }

      // POST /api/queue/skip - skip current song
      if (url.pathname === '/api/queue/skip' && req.method === 'POST') {
        this.db.clearGuesses();
        const next = this.db.skipCurrent();
        return sendJSON(200, { nowPlaying: next, queue: this.db.getQueue() });
      }

      // POST /api/queue/clear - clear the queue
      if (url.pathname === '/api/queue/clear' && req.method === 'POST') {
        this.db.clearQueue();
        this.db.clearGuesses();
        return sendJSON(200, { success: true });
      }

      // DELETE /api/queue/:id - remove a specific queue item
      const queueDeleteMatch = url.pathname.match(/^\/api\/queue\/(\d+)$/);
      if (queueDeleteMatch && req.method === 'DELETE') {
        const id = parseInt(queueDeleteMatch[1]);
        this.db.removeFromQueue(id);
        return sendJSON(200, { success: true, queue: this.db.getQueue() });
      }

      // GET /api/guesses - get guesses for current song
      if (url.pathname === '/api/guesses' && req.method === 'GET') {
        const nowPlaying = this.db.getNowPlaying();
        if (!nowPlaying) return sendJSON(200, { guesses: [], nowPlaying: null });
        const guesses = this.db.getGuesses(nowPlaying.id);
        return sendJSON(200, { guesses, nowPlaying });
      }

      // POST /api/reveal - reveal accuracy and find winner
      if (url.pathname === '/api/reveal' && req.method === 'POST') {
        const { accuracy } = await readBody();
        if (typeof accuracy !== 'number' || accuracy < 0 || accuracy > 100) {
          return sendJSON(400, { error: 'Accuracy must be a number between 0 and 100' });
        }
        const nowPlaying = this.db.getNowPlaying();
        if (!nowPlaying) return sendJSON(400, { error: 'No song is currently playing' });
        const closest = this.db.findClosestGuess(nowPlaying.id, accuracy);
        const guesses = this.db.getGuesses(nowPlaying.id);
        return sendJSON(200, { accuracy, closest, guesses, nowPlaying });
      }

      // GET /api/overlay/data - data for the OBS overlay
      if (url.pathname === '/api/overlay/data' && req.method === 'GET') {
        const queue = this.db.getQueue();
        const nowPlaying = this.db.getNowPlaying();
        const guesses = nowPlaying ? this.db.getGuesses(nowPlaying.id) : [];
        return sendJSON(200, { queue: queue.slice(0, 5), nowPlaying, guesses });
      }

      // GET /api/stats - database stats
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        return sendJSON(200, this.db.getStats());
      }

      // GET /api/giveaway — get current week's giveaway entries
      if (url.pathname === '/api/giveaway' && req.method === 'GET') {
        const SongDatabase = require('./Database.js');
        const entries = this.db.getGiveawayEntries(SongDatabase.getTodayKey());
        return sendJSON(200, { entries, dayKey: SongDatabase.getTodayKey() });
      }

      // POST /api/giveaway — manually add a giveaway entry (always adds, even if exists)
      if (url.pathname === '/api/giveaway' && req.method === 'POST') {
        const { username } = await readBody();
        if (!username || !username.trim()) return sendJSON(400, { error: 'Username is required' });
        this.db.forceAddGiveawayEntry(username.trim());
        const SongDatabase = require('./Database.js');
        return sendJSON(201, { entries: this.db.getGiveawayEntries(SongDatabase.getTodayKey()) });
      }

      // DELETE /api/giveaway/:id — remove a giveaway entry
      const giveawayDeleteMatch = url.pathname.match(/^\/api\/giveaway\/(\d+)$/);
      if (giveawayDeleteMatch && req.method === 'DELETE') {
        this.db.removeGiveawayEntry(parseInt(giveawayDeleteMatch[1]));
        const SongDatabase = require('./Database.js');
        return sendJSON(200, { entries: this.db.getGiveawayEntries(SongDatabase.getTodayKey()) });
      }

      // POST /api/giveaway/clear — clear all entries for today
      if (url.pathname === '/api/giveaway/clear' && req.method === 'POST') {
        const SongDatabase = require('./Database.js');
        this.db.clearGiveawayEntries(SongDatabase.getTodayKey());
        return sendJSON(200, { entries: [] });
      }

      // GET /api/chat?since=timestamp — get unified chat messages
      if (url.pathname === '/api/chat' && req.method === 'GET') {
        const since = parseInt(url.searchParams.get('since')) || 0;
        return sendJSON(200, { messages: this.chatManager.getMessages(since) });
      }

      // GET /api/search?q=query — search RS Playlist (for download modal)
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q');
        if (!q) return sendJSON(400, { error: 'Query parameter q is required' });
        const result = await this.rs.search(q);
        // Add owned flag to each result
        for (const r of result.results) {
          r.owned = this.rs.isOwned(r.artist, r.title);
        }
        return sendJSON(200, result);
      }

      // POST /api/owned/refresh — reload owned DLC list
      if (url.pathname === '/api/owned/refresh' && req.method === 'POST') {
        await this.rs.refreshOwned();
        return sendJSON(200, { count: this.rs.ownedSongs?.size || 0 });
      }

      // --- Timed Messages API ---
      if (url.pathname === '/api/timed-messages' && req.method === 'GET') {
        return sendJSON(200, this.timedMessages.getState());
      }

      if (url.pathname === '/api/timed-messages' && req.method === 'POST') {
        const { message } = await readBody();
        if (!message || !message.trim()) return sendJSON(400, { error: 'Message is required' });
        const entry = this.timedMessages.addMessage(message.trim());
        return sendJSON(201, entry);
      }

      const timedMsgMatch = url.pathname.match(/^\/api\/timed-messages\/(\d+)$/);
      if (timedMsgMatch && req.method === 'PUT') {
        const id = parseInt(timedMsgMatch[1]);
        const updates = await readBody();
        const msg = this.timedMessages.updateMessage(id, updates);
        if (!msg) return sendJSON(404, { error: 'Not found' });
        return sendJSON(200, msg);
      }

      if (timedMsgMatch && req.method === 'DELETE') {
        const id = parseInt(timedMsgMatch[1]);
        const deleted = this.timedMessages.deleteMessage(id);
        if (!deleted) return sendJSON(404, { error: 'Not found' });
        return sendJSON(200, { success: true });
      }

      if (url.pathname === '/api/timed-messages/interval' && req.method === 'PUT') {
        const { seconds } = await readBody();
        if (typeof seconds !== 'number' || seconds < 10) {
          return sendJSON(400, { error: 'Seconds must be >= 10' });
        }
        const actual = this.timedMessages.setInterval(seconds);
        return sendJSON(200, { intervalSeconds: actual });
      }

      if (url.pathname === '/api/timed-messages/start' && req.method === 'POST') {
        this.timedMessages.start();
        return sendJSON(200, this.timedMessages.getState());
      }

      if (url.pathname === '/api/timed-messages/stop' && req.method === 'POST') {
        this.timedMessages.stop();
        return sendJSON(200, this.timedMessages.getState());
      }

      sendJSON(404, { error: 'Unknown API route' });
    } catch (error) {
      console.error('API error:', error.message);
      sendJSON(500, { error: error.message });
    }
  }

  isAuthenticated(req) {
    // If no password is set yet, require setup
    if (!this.db.getAdminPasswordHash()) return false;
    const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      if (k) acc[k] = v;
      return acc;
    }, {});
    return this.db.validateSession(cookies.session);
  }

  hashPassword(password) {
    return this.crypto.createHash('sha256').update(password).digest('hex');
  }

  async handleLogin(req, res) {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => resolve(data));
    });
    const params = new URLSearchParams(body);
    const password = params.get('password');
    const hash = this.hashPassword(password);

    const existingHash = this.db.getAdminPasswordHash();

    // First-time setup — no password set yet
    if (!existingHash) {
      this.db.setAdminPassword(hash);
      const token = this.crypto.randomBytes(32).toString('hex');
      this.db.createSession(token, 100);
      res.writeHead(302, {
        Location: this.basePath + '/',
        'Set-Cookie': `session=${token}; Path=${this.basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=8640000`,
      });
      res.end();
      console.log('Admin password set');
      return;
    }

    // Normal login
    if (hash === existingHash) {
      const token = this.crypto.randomBytes(32).toString('hex');
      this.db.createSession(token, 100);
      this.db.cleanExpiredSessions();
      res.writeHead(302, {
        Location: this.basePath + '/',
        'Set-Cookie': `session=${token}; Path=${this.basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=8640000`,
      });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getLoginHTML('Invalid password'));
    }
  }

  // --- OAuth helpers ---

  getRedirectUri(path) {
    const baseUrl = process.env.OAUTH_BASE_URL || `http://localhost:${this.port}`;
    return `${baseUrl}${path}`;
  }

  cleanPendingOAuth() {
    for (const [key, val] of this.pendingOAuth) {
      if (Date.now() - val.createdAt > 600000) this.pendingOAuth.delete(key);
    }
  }

  updateEnvVars(vars) {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '.env');
    try {
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      for (const [key, value] of Object.entries(vars)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content += `\n${key}=${value}`;
        }
      }
      fs.writeFileSync(envPath, content);
    } catch (err) {
      console.error('[OAuth] Failed to save to .env:', err.message);
    }
  }

  // --- Twitch OAuth ---

  async handleTwitchOAuthAuthorize(req, res, url) {
    if (!this.twitchTokenManager) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(this.getOAuthResultHTML(false, 'Twitch is not configured'));
      return;
    }

    const tokenType = url.searchParams.get('type') || 'bot';
    const state = this.crypto.randomBytes(32).toString('hex');

    this.pendingOAuth.set(state, {
      platform: 'twitch',
      tokenType,
      createdAt: Date.now(),
    });
    this.cleanPendingOAuth();

    const scopes = tokenType === 'streamer'
      ? 'channel:read:subscriptions bits:read moderator:read:followers'
      : 'chat:read chat:edit user:read:chat user:write:chat user:bot';

    const redirectUri = this.getRedirectUri('/auth/twitch/callback');
    const params = new URLSearchParams({
      client_id: this.twitchTokenManager.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      state,
    });

    console.log(`[OAuth] Twitch ${tokenType} authorization started`);
    res.writeHead(302, { Location: `https://id.twitch.tv/oauth2/authorize?${params}` });
    res.end();
  }

  async handleTwitchOAuthCallback(req, res, url) {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getOAuthResultHTML(false, `Twitch authorization denied: ${error}`));
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(this.getOAuthResultHTML(false, 'Missing code or state parameter'));
      return;
    }

    const pending = this.pendingOAuth.get(state);
    if (!pending || pending.platform !== 'twitch') {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(this.getOAuthResultHTML(false, 'Invalid or expired state. Start the authorization flow again from the OAuth page.'));
      return;
    }
    this.pendingOAuth.delete(state);

    if (!this.twitchTokenManager) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(this.getOAuthResultHTML(false, 'Twitch is not configured'));
      return;
    }

    const redirectUri = this.getRedirectUri('/auth/twitch/callback');
    const tokenData = await this.twitchTokenManager.exchangeCode(code, redirectUri);

    if (!tokenData) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(this.getOAuthResultHTML(false, 'Failed to exchange Twitch authorization code'));
      return;
    }

    const validation = await this.twitchTokenManager.validate(tokenData.access_token);
    const tokenName = pending.tokenType;

    this.twitchTokenManager.addToken(tokenName, tokenData.access_token, tokenData.refresh_token);

    const prefix = tokenName === 'bot' ? 'TWITCH_BOT' : 'TWITCH_STREAMER';
    const vars = {
      [`${prefix}_ACCESS_TOKEN`]: tokenData.access_token,
      [`${prefix}_REFRESH_TOKEN`]: tokenData.refresh_token,
    };
    if (validation?.user_id) {
      vars[`${prefix}_USER_ID`] = validation.user_id;
    }
    this.updateEnvVars(vars);

    const username = validation?.login || 'unknown';
    console.log(`[OAuth] Twitch ${tokenName} tokens saved for ${username}`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(this.getOAuthResultHTML(true, `Twitch ${tokenName} token saved for ${username}! You can close this window.`));
  }

  // --- OAuth UI ---

  getOAuthResultHTML(success, message) {
    const color = success ? '#22c55e' : '#ef4444';
    const icon = success ? '&#10003;' : '&#10007;';
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>OAuth - ${success ? 'Success' : 'Error'}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
  .card { background: #1a1a2e; border: 1px solid ${color}; border-radius: 12px; padding: 32px; width: 400px; text-align: center; }
  .icon { font-size: 48px; color: ${color}; margin-bottom: 16px; }
  .msg { font-size: 16px; color: #ccc; }
</style></head>
<body><div class="card"><div class="icon">${icon}</div><div class="msg">${message}</div></div></body></html>`;
  }

  getTwitchOAuthHTML() {
    const twitchConfigured = !!this.twitchTokenManager;
    const twitchBotToken = !!process.env.TWITCH_BOT_ACCESS_TOKEN;
    const twitchStreamerToken = !!process.env.TWITCH_STREAMER_ACCESS_TOKEN;

    const statusDot = (active) => active
      ? '<span style="color:#22c55e;font-size:12px;">&#9679; Connected</span>'
      : '<span style="color:#666;font-size:12px;">&#9679; Not connected</span>';

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Bidlo Bot - Twitch OAuth</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center; align-items: flex-start; padding: 40px 20px; margin: 0; }
  .container { max-width: 600px; width: 100%; }
  h1 { color: #9146ff; margin-bottom: 8px; }
  .subtitle { color: #888; margin-bottom: 24px; }
  .back { color: #6366f1; text-decoration: none; font-size: 14px; }
  .back:hover { text-decoration: underline; }
  .platform { background: #1a1a2e; border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .token-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #222; }
  .token-row:last-child { border-bottom: none; }
  .token-info { flex: 1; }
  .token-label { font-weight: 600; color: #fff; }
  .token-desc { color: #888; font-size: 13px; margin-top: 2px; }
  .token-status { margin: 0 16px; }
  a.btn { display: inline-block; padding: 8px 20px; border-radius: 8px; color: #fff; text-decoration: none; font-size: 14px; font-weight: 600; }
  a.btn.twitch { background: #9146ff; }
  a.btn.twitch:hover { background: #7c3aed; }
  a.btn.disabled { background: #333; color: #666; pointer-events: none; }
  .note { color: #666; font-size: 13px; margin-top: 16px; font-style: italic; }
</style></head>
<body>
<div class="container">
  <a href="/" class="back">&larr; Dashboard</a>
  <h1>Twitch OAuth Setup</h1>
  <p class="subtitle">Authorize bot and streamer accounts for Twitch.</p>

  <div class="platform">
    <div class="token-row">
      <div class="token-info">
        <div class="token-label">Bot Account</div>
        <div class="token-desc">Reads and sends chat messages</div>
      </div>
      <div class="token-status">${statusDot(twitchBotToken)}</div>
      <a href="/auth/twitch/authorize?type=bot" class="btn ${twitchConfigured ? 'twitch' : 'disabled'}">${twitchBotToken ? 'Re-authorize' : 'Authorize'}</a>
    </div>
    <div class="token-row">
      <div class="token-info">
        <div class="token-label">Streamer Account</div>
        <div class="token-desc">Subscriptions, followers, raids</div>
      </div>
      <div class="token-status">${statusDot(twitchStreamerToken)}</div>
      <a href="/auth/twitch/authorize?type=streamer" class="btn ${twitchConfigured ? 'twitch' : 'disabled'}">${twitchStreamerToken ? 'Re-authorize' : 'Authorize'}</a>
    </div>
    ${!twitchConfigured ? '<div class="note">Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env to enable.</div>' : ''}
  </div>
</div>
</body></html>`;
  }

  getLoginHTML(error) {
    const isSetup = !this.db.getAdminPasswordHash();
    const title = isSetup ? 'Set Admin Password' : 'Login';
    const placeholder = isSetup ? 'Choose a password' : 'Admin password';
    const buttonText = isSetup ? 'Set Password' : 'Login';
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Bidlo Bot - ${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
  .login { background: #1a1a2e; border: 1px solid #333; border-radius: 12px; padding: 32px; width: 320px; }
  h2 { color: #a78bfa; margin: 0 0 20px; }
  input { width: 100%; background: #222; border: 1px solid #444; color: #fff; border-radius: 8px; padding: 10px; font-size: 16px; margin-bottom: 12px; box-sizing: border-box; }
  button { width: 100%; background: #6366f1; color: white; border: none; border-radius: 8px; padding: 10px; font-size: 16px; cursor: pointer; }
  button:hover { background: #5558e6; }
  .error { color: #ef4444; margin-bottom: 12px; }
  .info { color: #888; font-size: 13px; margin-bottom: 12px; }
</style></head>
<body><div class="login"><h2>${title}</h2>
${isSetup ? '<div class="info">First time setup — choose a password for the admin dashboard.</div>' : ''}
${error ? '<div class="error">' + error + '</div>' : ''}
<form method="POST" action="login"><input type="password" name="password" placeholder="${placeholder}" autofocus><button type="submit">${buttonText}</button></form>
</div></body></html>`;
  }

  getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bidlo Bot - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 20px; margin: 0; }
    .page-layout { display: flex; gap: 20px; align-items: flex-start; }
    .left-col { flex: 1; min-width: 0; }
    .right-col { flex: 1; min-width: 0; position: sticky; top: 20px; }
    h1 { color: #a78bfa; margin-bottom: 20px; }
    h2 { color: #8b5cf6; margin: 20px 0 10px; font-size: 18px; }
    .card { background: #1a1a2e; border: 1px solid #333; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .now-playing { background: linear-gradient(135deg, #1a1a2e, #16213e); border-color: #6366f1; }
    .now-playing .song { font-size: 20px; font-weight: 700; color: #fff; }
    .now-playing .meta { color: #a0a0a0; margin-top: 4px; }
    .queue-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #222; }
    .queue-item:last-child { border-bottom: none; }
    .queue-item .num { color: #6366f1; font-weight: 700; width: 30px; }
    .queue-item .info { flex: 1; }
    .queue-item .title { color: #fff; }
    .queue-item .requester { color: #888; font-size: 13px; }
    .queue-item .song-meta { display: flex; gap: 8px; align-items: center; margin-top: 2px; }
    .path-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; }
    .path-L { background: #166534; color: #a7f3d0; }
    .path-R { background: #1e40af; color: #bfdbfe; }
    .path-B { background: #9a3412; color: #fed7aa; }
    .path-V { background: #7e22ce; color: #e9d5ff; }
    .tuning { color: #888; font-size: 11px; }
    .dl-link { color: #60a5fa; text-decoration: none; font-size: 12px; }
    .dl-link:hover { text-decoration: underline; }
    .creator-info { color: #666; font-size: 11px; }
    .owned-badge { background: #166534; color: #a7f3d0; padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
    .not-owned-badge { background: #9a3412; color: #fed7aa; padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer; }
    .not-owned-badge:hover { background: #c2410c; }
    .modal-overlay { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:1000; justify-content:center; align-items:center; }
    .modal-overlay.show { display:flex; }
    .modal { background:#1a1a2e; border:1px solid #444; border-radius:16px; padding:32px; max-width:1000px; width:95%; max-height:85vh; overflow-y:auto; }
    .modal h3 { color:#a78bfa; margin-bottom:20px; font-size:24px; }
    .modal-close { float:right; background:none; border:none; color:#888; font-size:32px; cursor:pointer; padding:0; margin:0; }
    .modal-close:hover { color:#fff; }
    .dl-row { display:flex; justify-content:space-between; align-items:center; padding:16px 0; border-bottom:1px solid #222; }
    .dl-row:last-child { border-bottom:none; }
    .dl-row .dl-info { flex:1; }
    .dl-row .dl-title { color:#fff; font-weight:600; font-size:16px; }
    .dl-row .dl-title .path-badge { font-size:14px; padding:3px 8px; }
    .dl-row .dl-title .tuning { font-size:14px; }
    .dl-row .dl-meta { color:#888; font-size:15px; margin-top:6px; }
    .dl-row .dl-actions { display:flex; gap:8px; align-items:center; }
    .dl-row .dl-actions button { font-size:16px; padding:10px 24px; }
    button { background: #6366f1; color: white; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 14px; margin-right: 8px; }
    button:hover { background: #5558e6; }
    button.danger { background: #ef4444; }
    button.danger:hover { background: #dc2626; }
    button.secondary { background: #333; }
    button.secondary:hover { background: #444; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .controls { margin: 12px 0; }
    .guess-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .guess-chip { background: #262640; border-radius: 20px; padding: 4px 12px; font-size: 13px; }
    .reveal-form { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .reveal-form input { background: #222; border: 1px solid #444; color: #fff; border-radius: 8px; padding: 8px 12px; width: 100px; font-size: 14px; }
    .winner { background: linear-gradient(135deg, #16213e, #1a1a2e); border: 1px solid #22c55e; border-radius: 12px; padding: 16px; margin-top: 12px; }
    .winner .name { color: #22c55e; font-weight: 700; font-size: 18px; }
    .empty { color: #666; font-style: italic; padding: 12px 0; }
    .timed-msg { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #222; }
    .timed-msg:last-child { border-bottom: none; }
    .timed-msg .text { flex: 1; color: #ccc; }
    .add-form { display: flex; gap: 8px; margin-top: 8px; }
    .add-form input { flex: 1; background: #222; border: 1px solid #444; color: #fff; border-radius: 8px; padding: 8px 12px; font-size: 14px; }
    .chat-box { height: calc(100vh - 120px); overflow-y: auto; display: flex; flex-direction: column; }
    .chat-msg { padding: 6px 0; border-bottom: 1px solid #1a1a2e; display: flex; gap: 8px; align-items: flex-start; }
    .chat-msg:last-child { border-bottom: none; }
    .chat-msg .chat-emote { display: inline-block; height: 24px; vertical-align: middle; margin: 0 1px; }
    .chat-platform { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; margin-top: 2px; }
    .chat-platform.blaze { background: #6366f1; color: #fff; }
    .chat-platform.arena { background: #f97316; color: #fff; }
    .chat-platform.twitch { background: #9146ff; color: #fff; }
    .chat-user { font-weight: 700; color: #a78bfa; }
    .chat-text { color: #ccc; }
    .chat-host { color: #f59e0b; }
    .chat-msg.raid-msg { background: linear-gradient(135deg, #92400e, #78350f); border: 1px solid #f59e0b; border-radius: 8px; padding: 10px 14px; margin: 4px 0; flex-direction: column; align-items: flex-start; gap: 2px; }
    .chat-msg.raid-msg .raid-header { color: #f59e0b; font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    .chat-msg.raid-msg .raid-text { color: #fbbf24; font-weight: 700; font-size: 14px; }
    .giveaway-list { list-style: none; padding: 0; margin: 0; }
    .giveaway-list li { padding: 4px 0; border-bottom: 1px solid #222; color: #ccc; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
    .giveaway-list li:last-child { border-bottom: none; }
    .giveaway-list li .remove-btn { background: none; border: none; color: #666; cursor: pointer; font-size: 16px; padding: 0 4px; margin: 0; }
    .giveaway-list li .remove-btn:hover { color: #ef4444; }
    .giveaway-count { color: #888; font-size: 13px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1>Bidlo Bot</h1>
  <div style="margin-bottom:16px;"><a href="/auth/twitch" style="color:#9146ff;text-decoration:none;font-size:14px;">Twitch OAuth Setup &rarr;</a></div>
  <div class="page-layout">
    <div class="left-col">

  <div id="nowPlaying" class="card now-playing">
    <div class="song">Nothing playing</div>
    <div class="meta"></div>
  </div>

  <div class="controls">
    <button onclick="nextSong()">Next Song</button>
    <button onclick="skipSong()">Skip</button>
    <button onclick="clearQueue()" class="danger">Clear Queue</button>
  </div>

  <h2>Queue</h2>
  <div id="queue" class="card"><div class="empty">Queue is empty</div></div>

  <h2>Accuracy Guesses</h2>
  <div id="guesses" class="card">
    <div class="guess-list" id="guessList"></div>
    <div class="reveal-form">
      <input type="number" id="actualAccuracy" placeholder="Actual %" min="0" max="100" step="0.1">
      <button onclick="revealAccuracy()">Reveal Winner</button>
    </div>
    <div id="winner"></div>
  </div>

  <h2>Timed Messages</h2>
  <div id="timedMessages" class="card">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
      <label style="color:#888;font-size:13px;">Interval:</label>
      <input type="number" id="timedInterval" min="10" style="background:#222;border:1px solid #444;color:#fff;border-radius:8px;padding:6px 10px;width:80px;font-size:14px;" placeholder="600">
      <span style="color:#888;font-size:13px;">seconds</span>
      <button class="btn-sm" onclick="updateTimedInterval()">Update</button>
      <span id="timedIntervalStatus" style="color:#888;font-size:12px;"></span>
    </div>
    <div id="timedList"></div>
    <div class="add-form">
      <input type="text" id="newTimedMsg" placeholder="New timed message...">
      <button onclick="addTimedMsg()">Add</button>
    </div>
  </div>

  <h2>Giveaway Entries</h2>
  <div id="giveawaySection" class="card">
    <div id="giveawayList"></div>
    <div class="add-form" style="margin-top:8px;">
      <input type="text" id="newGiveawayName" placeholder="Add name manually...">
      <button onclick="addGiveawayEntry()">Add</button>
      <button class="secondary" onclick="copyGiveaway()">Copy for Wheel</button>
      <button class="danger" onclick="clearGiveaway()">Clear All</button>
    </div>
  </div>

    </div><!-- end left-col -->
    <div class="right-col">
      <div class="card" style="margin-bottom:0;">
        <h2 style="color:#8b5cf6;margin:0 0 8px;font-size:18px;">Unified Chat</h2>
        <div id="chatBox" class="chat-box"><div class="empty">No messages yet</div></div>
      </div>
    </div><!-- end right-col -->
  </div><!-- end page-layout -->

  <div class="modal-overlay" id="dlModal">
    <div class="modal">
      <button class="modal-close" onclick="closeDownloadModal()">&times;</button>
      <h3 id="dlModalTitle">Download Options</h3>
      <div id="dlModalContent"><div class="empty">Loading...</div></div>
    </div>
  </div>

  <script>
    function esc(s) { return (s || '').replace(/'/g, "\\\\'").replace(/"/g, '&quot;'); }

    var pathLabels = { L: 'Lead', R: 'Rhythm', B: 'Bass', V: 'Vocals' };
    function pathBadges(paths) {
      if (!paths) return '';
      return paths.split(',').map(function(p) {
        p = p.trim();
        return '<span class="path-badge path-' + p + '" title="' + (pathLabels[p] || p) + '">' + p + '</span>';
      }).join(' ');
    }

    // Use relative URL so it works behind a reverse proxy sub-path
    var basePath = window.location.pathname.replace(/\\/$/, '');
    async function api(path, method, body) {
      const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(basePath + '/api' + path, opts);
      return res.json();
    }

    async function refresh() {
      const qData = await api('/queue');
      const gData = await api('/guesses');

      // Now Playing
      const np = document.getElementById('nowPlaying');
      if (qData.nowPlaying) {
        var n = qData.nowPlaying;
        np.querySelector('.song').textContent = n.artist + ' - ' + n.title;
        var ownedHtml = n.owned
          ? '<span class="owned-badge">Owned</span>'
          : '<span class="not-owned-badge" onclick="openDownloadModal(\\'' + esc(n.artist) + '\\', \\'' + esc(n.title) + '\\')">Not Owned - Download</span>';
        np.querySelector('.meta').innerHTML = pathBadges(n.paths_string) +
          (n.tuning_name ? ' <span class="tuning">' + n.tuning_name + '</span> ' : '') +
          ownedHtml +
          '<div style="margin-top:4px;color:#a0a0a0">Requested by ' + n.requested_by + '</div>';
      } else {
        np.querySelector('.song').textContent = 'Nothing playing';
        np.querySelector('.meta').innerHTML = '';
      }

      // Queue
      const qEl = document.getElementById('queue');
      if (qData.queue.length === 0) {
        qEl.innerHTML = '<div class="empty">Queue is empty</div>';
      } else {
        qEl.innerHTML = qData.queue.map(function(q, i) {
          var ownedHtml = q.owned
            ? '<span class="owned-badge">Owned</span>'
            : '<span class="not-owned-badge" onclick="openDownloadModal(\\'' + esc(q.artist) + '\\', \\'' + esc(q.title) + '\\')">Not Owned - Download</span>';
          return '<div class="queue-item"><span class="num">' + (i + 1) + '</span><div class="info"><div class="title">' +
            q.artist + ' - ' + q.title + '</div><div class="song-meta">' + pathBadges(q.paths_string) +
            (q.tuning_name ? '<span class="tuning">' + q.tuning_name + '</span>' : '') +
            ownedHtml +
            '</div><div class="requester">' + q.requested_by + '</div></div>' +
            '<button class="btn-sm danger" onclick="removeFromQueue(' + q.id + ')">X</button></div>';
        }).join('');
      }

      // Guesses
      const gl = document.getElementById('guessList');
      if (gData.guesses.length === 0) {
        gl.innerHTML = '<div class="empty">No guesses yet</div>';
      } else {
        gl.innerHTML = gData.guesses.map(function(g) {
          return '<span class="guess-chip">' + g.username + ': ' + g.guess + '%</span>';
        }).join('');
      }

      // Giveaway
      loadGiveaway();
    }

    async function nextSong() { await api('/queue/next', 'POST'); refresh(); }
    async function skipSong() { await api('/queue/skip', 'POST'); refresh(); }
    async function clearQueue() { if (confirm('Clear the entire queue?')) { await api('/queue/clear', 'POST'); refresh(); } }
    async function removeFromQueue(id) { await api('/queue/' + id, 'DELETE'); refresh(); }

    async function revealAccuracy() {
      var val = parseFloat(document.getElementById('actualAccuracy').value);
      if (isNaN(val) || val < 0 || val > 100) { alert('Enter a number 0-100'); return; }
      var data = await api('/reveal', 'POST', { accuracy: val });
      var w = document.getElementById('winner');
      if (data.closest) {
        w.innerHTML = '<div class="winner"><div class="name">' + data.closest.username + ' wins!</div>' +
          '<div>Guessed ' + data.closest.guess + '% (off by ' + data.closest.diff.toFixed(1) + '%) - Actual: ' + data.accuracy + '%</div>' +
          '<div style="color:#888;margin-top:4px">' + data.guesses.length + ' total guesses</div></div>';
      } else {
        w.innerHTML = '<div class="empty">No guesses were made</div>';
      }
    }

    async function loadTimedMessages() {
      var data = await api('/timed-messages');
      document.getElementById('timedInterval').value = data.intervalSeconds || 600;
      var el = document.getElementById('timedList');
      if (data.messages.length === 0) {
        el.innerHTML = '<div class="empty">No timed messages</div>';
      } else {
        el.innerHTML = data.messages.map(function(m) {
          return '<div class="timed-msg"><span class="text">' + m.message.substring(0, 80) + (m.message.length > 80 ? '...' : '') + '</span>' +
            '<button class="btn-sm secondary" onclick="toggleTimedMsg(' + m.id + ',' + !m.enabled + ')">' + (m.enabled ? 'Disable' : 'Enable') + '</button>' +
            '<button class="btn-sm danger" onclick="deleteTimedMsg(' + m.id + ')">X</button></div>';
        }).join('');
      }
    }

    async function updateTimedInterval() {
      var val = parseInt(document.getElementById('timedInterval').value);
      if (isNaN(val) || val < 10) { alert('Minimum interval is 10 seconds'); return; }
      await api('/timed-messages/interval', 'PUT', { seconds: val });
      document.getElementById('timedIntervalStatus').textContent = 'Updated!';
      setTimeout(function() { document.getElementById('timedIntervalStatus').textContent = ''; }, 2000);
    }

    async function addTimedMsg() {
      var input = document.getElementById('newTimedMsg');
      if (!input.value.trim()) return;
      await api('/timed-messages', 'POST', { message: input.value.trim() });
      input.value = '';
      loadTimedMessages();
    }

    async function toggleTimedMsg(id, enabled) { await api('/timed-messages/' + id, 'PUT', { enabled: enabled }); loadTimedMessages(); }
    async function deleteTimedMsg(id) { await api('/timed-messages/' + id, 'DELETE'); loadTimedMessages(); }

    async function loadGiveaway() {
      var data = await api('/giveaway');
      lastGiveawayData = data;
      var el = document.getElementById('giveawayList');
      if (!data.entries || data.entries.length === 0) {
        el.innerHTML = '<div class="empty">No entries today</div>';
        return;
      }
      var sorted = data.entries.slice().sort(function(a, b) { return a.username.toLowerCase().localeCompare(b.username.toLowerCase()); });
      var totalEntries = sorted.reduce(function(sum, e) { return sum + e.entries; }, 0);
      el.innerHTML = '<div class="giveaway-count">' + totalEntries + ' entries (' + sorted.length + ' people) — ' + data.dayKey + '</div>' +
        '<ul class="giveaway-list">' + sorted.map(function(e) {
          var countLabel = e.entries > 1 ? ' (' + e.entries + 'x)' : '';
          return '<li><span>' + e.username + countLabel + '</span><button class="remove-btn" onclick="removeGiveawayEntry(' + e.id + ')">&times;</button></li>';
        }).join('') + '</ul>';
    }

    async function addGiveawayEntry() {
      var input = document.getElementById('newGiveawayName');
      if (!input.value.trim()) return;
      await api('/giveaway', 'POST', { username: input.value.trim() });
      input.value = '';
      loadGiveaway();
    }

    async function removeGiveawayEntry(id) { await api('/giveaway/' + id, 'DELETE'); loadGiveaway(); }
    async function clearGiveaway() { if (confirm('Clear all giveaway entries?')) { await api('/giveaway/clear', 'POST'); loadGiveaway(); } }

    var lastGiveawayData = null;
    var origLoadGiveaway = loadGiveaway;

    async function copyGiveaway() {
      var data = lastGiveawayData || await api('/giveaway');
      if (!data.entries || data.entries.length === 0) return;
      var names = [];
      data.entries.forEach(function(e) {
        for (var i = 0; i < e.entries; i++) names.push(e.username);
      });
      names.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
      navigator.clipboard.writeText(names.join('\\n')).then(function() {
        var btn = document.querySelector('button[onclick="copyGiveaway()"]');
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy for Wheel'; }, 2000);
      });
    }

    async function openDownloadModal(artist, title) {
      var modal = document.getElementById('dlModal');
      var content = document.getElementById('dlModalContent');
      document.getElementById('dlModalTitle').textContent = artist + ' - ' + title;
      content.innerHTML = '<div class="empty">Searching...</div>';
      modal.classList.add('show');

      var data = await api('/search?q=' + encodeURIComponent(artist + ' ' + title));
      var results = (data.results || []).filter(function(r) {
        return r.artist.toLowerCase() === artist.toLowerCase() && r.title.toLowerCase() === title.toLowerCase();
      });

      if (results.length === 0) {
        content.innerHTML = '<div class="empty">No download options found</div>';
        return;
      }

      // Sort by downloads descending
      results.sort(function(a, b) { return (b.downloads || 0) - (a.downloads || 0); });

      content.innerHTML = results.map(function(r) {
        return '<div class="dl-row"><div class="dl-info"><div class="dl-title">' + pathBadges(r.paths_string) +
          ' <span class="tuning">' + (r.tuning_name || '') + '</span></div>' +
          '<div class="dl-meta">by ' + (r.creator || 'Unknown') + ' | ' + (r.downloads || 0) + ' downloads' +
          (r.dd ? ' | DD' : '') + '</div></div>' +
          '<div class="dl-actions"><a class="dl-link" href="https://ignition4.customsforge.com/cdlc/' + r.cdlc_id + '" target="_blank"><button class="btn-sm">Download</button></a></div></div>';
      }).join('');
    }

    function closeDownloadModal() {
      document.getElementById('dlModal').classList.remove('show');
    }

    // Close modal on overlay click
    document.getElementById('dlModal').addEventListener('click', function(e) {
      if (e.target === this) closeDownloadModal();
    });

    // --- Emote support ---
    var emoteCache = {};
    var channelId = '${this.channelId || ''}';

    async function loadEmotes() {
      try {
        var res = await fetch(basePath + '/bapi-proxy/emotes/channels/' + channelId);
        if (res.ok) {
          var data = await res.json();
          var list = data.data || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i].id && list[i].imageUrl) {
              emoteCache[list[i].id] = { name: list[i].name, url: list[i].imageUrl };
            }
          }
        }
      } catch (e) {}
      try {
        var res2 = await fetch(basePath + '/bapi-proxy/emotes/blaze');
        if (res2.ok) {
          var data2 = await res2.json();
          var list2 = data2.data || [];
          for (var j = 0; j < list2.length; j++) {
            if (list2[j].id && list2[j].imageUrl) {
              emoteCache[list2[j].id] = { name: list2[j].name, url: list2[j].imageUrl };
            }
          }
        }
      } catch (e) {}
    }

    function renderMessageContent(text, emotes) {
      var frag = document.createDocumentFragment();
      if (!text || !text.includes('[emote:')) {
        frag.appendChild(document.createTextNode(' ' + (text || '')));
        return frag;
      }
      var msgEmoteMap = {};
      if (emotes && emotes.length > 0) {
        for (var i = 0; i < emotes.length; i++) {
          var e = emotes[i];
          if (e.id && e.imageUrl) {
            msgEmoteMap[e.id] = { url: e.imageUrl, name: e.name || 'emote' };
          }
        }
      }
      var parts = (' ' + text).split(/(\\[emote:[a-f0-9-]+\\])/gi);
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        var emoteMatch = part.match(/^\\[emote:([a-f0-9-]+)\\]$/i);
        if (emoteMatch) {
          var emoteId = emoteMatch[1];
          var emote = emoteCache[emoteId] || msgEmoteMap[emoteId];
          if (emote) {
            var img = document.createElement('img');
            img.className = 'chat-emote';
            img.src = emote.url;
            img.alt = emote.name;
            img.title = emote.name;
            frag.appendChild(img);
          } else {
            frag.appendChild(document.createTextNode(part));
          }
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      }
      return frag;
    }

    var lastChatTimestamp = 0;
    async function loadChat() {
      var data = await api('/chat?since=' + lastChatTimestamp);
      var box = document.getElementById('chatBox');
      if (data.messages && data.messages.length > 0) {
        if (lastChatTimestamp === 0) box.innerHTML = '';
        data.messages.forEach(function(m) {
          var div = document.createElement('div');
          if (m.type === 'raid') {
            div.className = 'chat-msg raid-msg';
            var header = document.createElement('span');
            header.className = 'raid-header';
            header.textContent = '\\u26A1 INCOMING RAID';
            div.appendChild(header);
            var raidText = document.createElement('span');
            raidText.className = 'raid-text';
            var raidMsg = '\\u26A1 ' + m.username + ' is starting a raid';
            if (m.viewerCount) raidMsg += ' with ' + m.viewerCount + ' viewers';
            raidMsg += '.';
            raidText.textContent = raidMsg;
            div.appendChild(raidText);
          } else {
            div.className = 'chat-msg';
            var roleClass = m.role === 'HOST' ? ' chat-host' : '';
            var platformSpan = document.createElement('span');
            platformSpan.className = 'chat-platform ' + m.platform;
            platformSpan.textContent = m.platform.toUpperCase();
            div.appendChild(platformSpan);
            var contentSpan = document.createElement('span');
            var userSpan = document.createElement('span');
            userSpan.className = 'chat-user' + roleClass;
            userSpan.textContent = m.username + ':';
            contentSpan.appendChild(userSpan);
            var textSpan = document.createElement('span');
            textSpan.className = 'chat-text';
            textSpan.appendChild(renderMessageContent(m.text, m.emotes));
            contentSpan.appendChild(textSpan);
            div.appendChild(contentSpan);
          }
          box.appendChild(div);
          if (m.timestamp > lastChatTimestamp) lastChatTimestamp = m.timestamp;
        });
        box.scrollTop = box.scrollHeight;
      }
    }

    setInterval(refresh, 3000);
    setInterval(loadChat, 2000);
    refresh();
    loadEmotes();
    loadChat();
    loadTimedMessages();
    loadGiveaway();
  </script>
</body>
</html>`;
  }

  getChatOverlayHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Chat Overlay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: transparent; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .chat-container { position: absolute; bottom: 0; left: 0; width: 100%; display: flex; flex-direction: column; justify-content: flex-end; padding: 10px; }
    .chat-msg { background: rgba(0,0,0,0.6); border-radius: 10px; padding: 10px 18px; margin-top: 6px; display: flex; gap: 12px; align-items: center; backdrop-filter: blur(4px); animation: fadeIn 0.3s ease; }
    .chat-msg.fade-out { opacity: 0; transition: opacity 1s ease; }
    .platform-badge { font-size: 14px; font-weight: 800; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; flex-shrink: 0; }
    .platform-badge.blaze { background: #6366f1; color: #fff; }
    .platform-badge.arena { background: #f97316; color: #fff; }
    .platform-badge.twitch { background: #9146ff; color: #fff; }
    .username { font-weight: 700; color: #a78bfa; font-size: 28px; }
    .username.host { color: #f59e0b; }
    .text { color: #fff; font-size: 28px; }
    .text .chat-emote { display: inline-block; height: 28px; vertical-align: middle; margin: 0 2px; }
    .chat-msg.raid-msg { background: linear-gradient(135deg, rgba(146,64,14,0.9), rgba(120,53,15,0.9)); border: 2px solid #f59e0b; flex-direction: column; align-items: flex-start; gap: 4px; padding: 14px 22px; }
    .chat-msg.raid-msg .raid-header { color: #f59e0b; font-weight: 800; font-size: 18px; text-transform: uppercase; letter-spacing: 2px; }
    .chat-msg.raid-msg .raid-text { color: #fbbf24; font-weight: 700; font-size: 28px; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="chat-container" id="chatContainer"></div>
  <script>
    var basePath = window.location.pathname.replace(/\\/chat-overlay\\/?$/, '');
    var lastTimestamp = 0;
    var MSG_LIFETIME = 30000;
    var emoteCache = {};
    var channelId = '${this.channelId || ''}';

    async function loadEmotes() {
      try {
        var res = await fetch(basePath + '/bapi-proxy/emotes/channels/' + channelId);
        if (res.ok) {
          var data = await res.json();
          var list = data.data || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i].id && list[i].imageUrl) emoteCache[list[i].id] = { name: list[i].name, url: list[i].imageUrl };
          }
        }
      } catch (e) {}
      try {
        var res2 = await fetch(basePath + '/bapi-proxy/emotes/blaze');
        if (res2.ok) {
          var data2 = await res2.json();
          var list2 = data2.data || [];
          for (var j = 0; j < list2.length; j++) {
            if (list2[j].id && list2[j].imageUrl) emoteCache[list2[j].id] = { name: list2[j].name, url: list2[j].imageUrl };
          }
        }
      } catch (e) {}
    }

    function renderMessageContent(text, emotes) {
      var frag = document.createDocumentFragment();
      if (!text || !text.includes('[emote:')) {
        frag.appendChild(document.createTextNode(text || ''));
        return frag;
      }
      var msgEmoteMap = {};
      if (emotes && emotes.length > 0) {
        for (var i = 0; i < emotes.length; i++) {
          var e = emotes[i];
          if (e.id && e.imageUrl) msgEmoteMap[e.id] = { url: e.imageUrl, name: e.name || 'emote' };
        }
      }
      var parts = text.split(/(\\[emote:[a-f0-9-]+\\])/gi);
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        var emoteMatch = part.match(/^\\[emote:([a-f0-9-]+)\\]$/i);
        if (emoteMatch) {
          var emoteId = emoteMatch[1];
          var emote = emoteCache[emoteId] || msgEmoteMap[emoteId];
          if (emote) {
            var img = document.createElement('img');
            img.className = 'chat-emote';
            img.src = emote.url;
            img.alt = emote.name;
            img.title = emote.name;
            frag.appendChild(img);
          } else {
            frag.appendChild(document.createTextNode(part));
          }
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      }
      return frag;
    }

    async function poll() {
      try {
        var res = await fetch(basePath + '/api/chat?since=' + lastTimestamp);
        var data = await res.json();
        var container = document.getElementById('chatContainer');

        (data.messages || []).forEach(function(m) {
          if (m.timestamp > lastTimestamp) lastTimestamp = m.timestamp;
          var div = document.createElement('div');
          if (m.type === 'raid') {
            div.className = 'chat-msg raid-msg';
            var header = document.createElement('span');
            header.className = 'raid-header';
            header.textContent = '\\u26A1 INCOMING RAID';
            div.appendChild(header);
            var raidText = document.createElement('span');
            raidText.className = 'raid-text';
            var raidMsg = '\\u26A1 ' + m.username + ' is starting a raid';
            if (m.viewerCount) raidMsg += ' with ' + m.viewerCount + ' viewers';
            raidMsg += '.';
            raidText.textContent = raidMsg;
            div.appendChild(raidText);
          } else {
            div.className = 'chat-msg';
            var hostClass = m.role === 'HOST' ? ' host' : '';
            var badge = document.createElement('span');
            badge.className = 'platform-badge ' + m.platform;
            badge.textContent = m.platform;
            div.appendChild(badge);
            var uname = document.createElement('span');
            uname.className = 'username' + hostClass;
            uname.textContent = m.username;
            div.appendChild(uname);
            var textSpan = document.createElement('span');
            textSpan.className = 'text';
            textSpan.appendChild(renderMessageContent(m.text, m.emotes));
            div.appendChild(textSpan);
          }
          container.appendChild(div);

          // Keep only 2 visible messages
          while (container.children.length > 2) {
            container.removeChild(container.firstChild);
          }

          setTimeout(function() { div.classList.add('fade-out'); }, MSG_LIFETIME - 1000);
          setTimeout(function() { div.remove(); }, MSG_LIFETIME);
        });
      } catch (e) {}
    }

    loadEmotes();
    setInterval(poll, 2000);
    poll();
  <\/script>
</body>
</html>`;
  }

  async proxyEmotes(req, res, url) {
    try {
      const visitorId = process.env.BLAZE_VISITOR_ID || '';
      const authToken = process.env.BLAZE_AUTH_TOKEN || '';
      const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${authToken}`,
        'Visitor-Id': visitorId,
        Cookie: `visitorId=${visitorId}; token=${authToken}`,
      };
      const response = await fetch(url, { headers });
      const data = await response.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = WebServer;
