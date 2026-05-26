function getOverlayHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bidlo Bot - Queue Overlay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: transparent;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .overlay {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 360px;
      pointer-events: none;
    }

    .now-playing {
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid rgba(100, 100, 200, 0.25);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 8px;
      backdrop-filter: blur(12px);
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
      opacity: 0;
      transform: translateX(40px);
      transition: opacity 0.5s ease, transform 0.5s ease;
    }

    .now-playing.visible {
      opacity: 1;
      transform: translateX(0);
    }

    .now-playing .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #6366f1;
      margin-bottom: 6px;
      font-weight: 600;
    }

    .now-playing .song {
      font-size: 16px;
      font-weight: 700;
      color: #1a1a2e;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .now-playing .requester {
      font-size: 12px;
      color: rgba(0, 0, 0, 0.45);
      margin-top: 4px;
    }

    .queue-container {
      background: rgba(255, 255, 255, 0.90);
      border: 1px solid rgba(100, 100, 200, 0.2);
      border-radius: 12px;
      padding: 12px 16px;
      backdrop-filter: blur(12px);
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
      opacity: 0;
      transform: translateX(40px);
      transition: opacity 0.5s ease 0.1s, transform 0.5s ease 0.1s;
    }

    .queue-container.visible {
      opacity: 1;
      transform: translateX(0);
    }

    .queue-header {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #6366f1;
      margin-bottom: 8px;
      font-weight: 600;
    }

    .queue-item {
      display: flex;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      opacity: 0;
      transform: translateX(20px);
      transition: opacity 0.3s ease, transform 0.3s ease;
    }

    .queue-item.visible {
      opacity: 1;
      transform: translateX(0);
    }

    .queue-item:last-child { border-bottom: none; }

    .queue-item .num {
      color: #6366f1;
      font-weight: 700;
      font-size: 14px;
      width: 24px;
      text-align: center;
      flex-shrink: 0;
    }

    .queue-item .details {
      margin-left: 8px;
      overflow: hidden;
    }

    .queue-item .song-name {
      font-size: 13px;
      color: #1a1a2e;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .queue-item .req-by {
      font-size: 11px;
      color: rgba(0, 0, 0, 0.4);
    }

    .guesses-bar {
      margin-top: 8px;
      background: rgba(255, 255, 255, 0.90);
      border: 1px solid rgba(34, 197, 94, 0.25);
      border-radius: 12px;
      padding: 10px 16px;
      backdrop-filter: blur(12px);
      opacity: 0;
      transform: translateX(40px);
      transition: opacity 0.5s ease 0.2s, transform 0.5s ease 0.2s;
    }

    .guesses-bar.visible {
      opacity: 1;
      transform: translateX(0);
    }

    .guesses-bar .label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #16a34a;
      margin-bottom: 6px;
      font-weight: 600;
    }

    .guesses-bar .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .guess-chip {
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 16px;
      padding: 2px 10px;
      font-size: 12px;
      color: #15803d;
    }

    .empty-queue {
      color: rgba(0, 0, 0, 0.35);
      font-size: 12px;
      font-style: italic;
      padding: 4px 0;
    }
  </style>
</head>
<body>
  <div class="overlay">
    <div class="now-playing" id="nowPlaying">
      <div class="label">Now Playing</div>
      <div class="song" id="npSong"></div>
      <div class="requester" id="npRequester"></div>
    </div>

    <div class="queue-container" id="queueContainer">
      <div class="queue-header">Up Next</div>
      <div id="queueList"></div>
    </div>

    <div class="guesses-bar" id="guessesBar">
      <div class="label">Accuracy Guesses</div>
      <div class="chips" id="guessChips"></div>
    </div>
  </div>

  <script>
    var lastNPId = null;
    var lastQueueIds = '';
    var lastGuessCount = 0;

    async function poll() {
      try {
        var res = await fetch('/api/overlay/data');
        var data = await res.json();

        // Now Playing
        var npEl = document.getElementById('nowPlaying');
        if (data.nowPlaying) {
          document.getElementById('npSong').textContent = data.nowPlaying.artist + ' - ' + data.nowPlaying.title;
          document.getElementById('npRequester').textContent = 'Requested by ' + data.nowPlaying.requested_by;
          npEl.classList.add('visible');

          if (data.nowPlaying.id !== lastNPId) {
            npEl.classList.remove('visible');
            setTimeout(function() { npEl.classList.add('visible'); }, 50);
            lastNPId = data.nowPlaying.id;
          }
        } else {
          npEl.classList.remove('visible');
          lastNPId = null;
        }

        // Queue
        var qContainer = document.getElementById('queueContainer');
        var qList = document.getElementById('queueList');
        var newIds = data.queue.map(function(q) { return q.id; }).join(',');

        if (data.queue.length > 0) {
          qContainer.classList.add('visible');
          if (newIds !== lastQueueIds) {
            qList.innerHTML = data.queue.map(function(q, i) {
              return '<div class="queue-item" style="transition-delay:' + (i * 0.1) + 's">' +
                '<span class="num">' + (i + 1) + '</span>' +
                '<div class="details"><div class="song-name">' + q.artist + ' - ' + q.title + '</div>' +
                '<div class="req-by">' + q.requested_by + '</div></div></div>';
            }).join('');
            setTimeout(function() {
              document.querySelectorAll('.queue-item').forEach(function(el) { el.classList.add('visible'); });
            }, 50);
            lastQueueIds = newIds;
          }
        } else {
          if (data.nowPlaying) {
            qContainer.classList.add('visible');
            qList.innerHTML = '<div class="empty-queue">Queue is empty - use !request to add songs</div>';
          } else {
            qContainer.classList.remove('visible');
          }
          lastQueueIds = '';
        }

        // Guesses
        var gBar = document.getElementById('guessesBar');
        var gChips = document.getElementById('guessChips');
        if (data.guesses.length > 0) {
          gBar.classList.add('visible');
          if (data.guesses.length !== lastGuessCount) {
            gChips.innerHTML = data.guesses.map(function(g) {
              return '<span class="guess-chip">' + g.username + ': ' + g.guess + '%</span>';
            }).join('');
            lastGuessCount = data.guesses.length;
          }
        } else {
          gBar.classList.remove('visible');
          lastGuessCount = 0;
        }
      } catch (e) {
        // Server not reachable
      }
    }

    setInterval(poll, 1500);
    poll();
  <\/script>
</body>
</html>`;
}

module.exports = { getOverlayHTML };
