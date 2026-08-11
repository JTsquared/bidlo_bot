const EventEmitter = require('events');

const BLAZE_API = 'https://api.blaze.stream/v1';

class BlazeChatPoller extends EventEmitter {
  constructor(tokenManager, clientId, channelId) {
    super();
    this.tokenManager = tokenManager;
    this.clientId = clientId;
    this.channelId = channelId;
    this.seenMessageIds = new Set();
    this.pollInterval = null;
    this.isRunning = false;
  }

  start(intervalMs = 3000) {
    if (this.isRunning) return;
    this.isRunning = true;
    // Initial fetch to mark existing messages as seen
    this.fetchMessages(true).then(() => {
      this.pollInterval = setInterval(() => this.fetchMessages(), intervalMs);
      console.log(`Blaze chat poller started (every ${intervalMs / 1000}s)`);
    });
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async fetchMessages(initial = false) {
    const token = await this.tokenManager.getAccessToken('bot');
    if (!token) return;

    try {
      const params = new URLSearchParams({
        channelId: this.channelId,
        limit: '50',
      });

      const response = await fetch(`${BLAZE_API}/chats/messages?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': this.clientId,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        if (!this._pollErrorLogged) {
          console.error(`Blaze chat poll failed (${response.status}):`, (await response.text()).substring(0, 200));
          this._pollErrorLogged = true;
        }
        return;
      }
      this._pollErrorLogged = false;

      const data = await response.json();
      if (!this._responseLogged) {
        console.log('Blaze chat response:', JSON.stringify(data).substring(0, 300));
        this._responseLogged = true;
      }
      const messages = data.data?.messages || data.messages || data.rows || data.data?.rows || [];

      if (initial) {
        for (const msg of messages) {
          this.seenMessageIds.add(msg.id);
        }
        console.log(`Blaze chat: ${messages.length} existing messages loaded`);
        return;
      }

      for (const msg of messages) {
        if (this.seenMessageIds.has(msg.id)) continue;
        this.seenMessageIds.add(msg.id);

        // Skip non-text messages (if type field exists)
        if (msg.type && msg.type !== 'text') continue;

        const username = msg.sender?.slug || msg.sender?.displayName || 'Anonymous';
        const userId = msg.sender?.userId || msg.sender?.id;

        this.emit('chatMessage', {
          username,
          userId,
          userChannelId: userId,
          text: msg.message,
          channelId: msg.channelId || this.channelId,
          messageId: msg.id,
          isSubscriber: msg.sender?.isSubscriber || false,
          sender: msg.sender,
          emotes: msg.emotes || [],
        });
      }

      // Trim seen set
      if (this.seenMessageIds.size > 1000) {
        const arr = Array.from(this.seenMessageIds);
        this.seenMessageIds = new Set(arr.slice(-500));
      }
    } catch (error) {
      // Silent fail on poll errors
    }
  }
}

module.exports = BlazeChatPoller;
