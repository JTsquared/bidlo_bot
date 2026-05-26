const http = require('http');
const { getOverlayHTML } = require('./overlay.js');

class WebServer {
  constructor(db, timedMessages, port = 3000) {
    this.db = db;
    this.timedMessages = timedMessages;
    this.port = port;
    this.server = null;
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

    if (url.pathname.startsWith('/api/')) {
      return this.handleAPI(req, res, url);
    }

    if (url.pathname === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getOverlayHTML());
      return;
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
        const queue = this.db.getQueue();
        const nowPlaying = this.db.getNowPlaying();
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

  getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bidlo Bot - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 20px; }
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
  </style>
</head>
<body>
  <h1>Bidlo Bot</h1>

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

  <script>
    async function api(path, method, body) {
      const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch('/api' + path, opts);
      return res.json();
    }

    async function refresh() {
      const qData = await api('/queue');
      const gData = await api('/guesses');

      // Now Playing
      const np = document.getElementById('nowPlaying');
      if (qData.nowPlaying) {
        np.querySelector('.song').textContent = qData.nowPlaying.artist + ' - ' + qData.nowPlaying.title;
        np.querySelector('.meta').textContent = 'Requested by ' + qData.nowPlaying.requested_by;
      } else {
        np.querySelector('.song').textContent = 'Nothing playing';
        np.querySelector('.meta').textContent = '';
      }

      // Queue
      const qEl = document.getElementById('queue');
      if (qData.queue.length === 0) {
        qEl.innerHTML = '<div class="empty">Queue is empty</div>';
      } else {
        qEl.innerHTML = qData.queue.map(function(q, i) {
          return '<div class="queue-item"><span class="num">' + (i + 1) + '</span><div class="info"><div class="title">' +
            q.artist + ' - ' + q.title + '</div><div class="requester">' + q.requested_by + '</div></div>' +
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

    setInterval(refresh, 3000);
    refresh();
    loadTimedMessages();
  </script>
</body>
</html>`;
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = WebServer;
