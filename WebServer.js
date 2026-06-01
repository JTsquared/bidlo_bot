const http = require('http');
const { getOverlayHTML } = require('./overlay.js');

class WebServer {
  constructor(db, timedMessages, rsPlaylist, port = 3000) {
    this.db = db;
    this.timedMessages = timedMessages;
    this.rs = rsPlaylist;
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
