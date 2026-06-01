const EventEmitter = require('events');

const ARENA_API = 'https://api.arena.social';

class ArenaChat extends EventEmitter {
  constructor(bearerToken, streamerHandle) {
    super();
    this.bearerToken = bearerToken;
    this.streamerHandle = streamerHandle;
    this.livestreamId = null;
    this.senderInfo = null;
    this.pollInterval = null;
    this.seenMessageIds = new Set();
    this.isConnected = false;
  }

  getHeaders() {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.bearerToken}`,
      Origin: 'https://arena.social',
      Referer: 'https://arena.social/',
    };
  }

  async connect() {
    if (!this.bearerToken || !this.streamerHandle) {
      console.error('Arena: missing bearer token or streamer handle');
      return false;
    }

    console.log(`Arena: joining ${this.streamerHandle}'s livestream...`);

    try {
      const joinRes = await fetch(`${ARENA_API}/livestreams/join`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ handle: this.streamerHandle }),
      });

      if (!joinRes.ok) {
        const err = await joinRes.json().catch(() => ({}));
        console.error(`Arena: join failed (${joinRes.status}): ${err.message || 'unknown error'}`);
        return false;
      }

      const joinData = await joinRes.json();
      this.livestreamId = joinData.id;

      // Extract sender info from the LiveKit token
      const tokenPayload = JSON.parse(Buffer.from(joinData.token.split('.')[1], 'base64url').toString());
      this.senderInfo = {
        id: tokenPayload.attributes?.id || tokenPayload.sub,
        name: tokenPayload.attributes?.name,
        avatar: tokenPayload.attributes?.avatar,
        username: tokenPayload.attributes?.username,
        role: tokenPayload.attributes?.role,
      };

      console.log(`Arena: connected to livestream ${this.livestreamId} as ${this.senderInfo.name || this.senderInfo.username}`);
      this.isConnected = true;

      // Load initial messages to mark them as seen
      await this.fetchMessages(true);

      this.startPolling();
      this.emit('connected');
      return true;
    } catch (error) {
      console.error('Arena: connection error:', error.message);
      return false;
    }
  }

  startPolling(intervalMs = 3000) {
    this.stopPolling();
    this.pollInterval = setInterval(() => this.fetchMessages(), intervalMs);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async fetchMessages(initial = false) {
    if (!this.livestreamId) return;

    try {
      const res = await fetch(`${ARENA_API}/live-chat/history/livestream/${this.livestreamId}`, {
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        if (!this._pollErrorLogged) {
          console.error(`Arena: poll failed (${res.status})`);
          this._pollErrorLogged = true;
        }
        return;
      }

      const data = await res.json();
      const messages = data.messages || data || [];

      if (initial) {
        console.log(`Arena: loaded ${messages.length} existing messages`);
      }

      for (const msg of messages) {
        if (this.seenMessageIds.has(msg.id)) continue;
        this.seenMessageIds.add(msg.id);

        if (initial) continue;
        if (msg.messageData?.type !== 'text') continue;

        this.emit('chatMessage', {
          platform: 'arena',
          username: msg.sender?.name || msg.sender?.username || 'Anonymous',
          userId: msg.sender?.id,
          text: msg.messageData.message,
          avatar: msg.sender?.avatar,
          role: msg.sender?.role,
          timestamp: msg.timestamp,
          messageId: msg.id,
        });
      }

      // Keep seenMessageIds bounded
      if (this.seenMessageIds.size > 1000) {
        const ids = Array.from(this.seenMessageIds);
        this.seenMessageIds = new Set(ids.slice(-500));
      }
    } catch (error) {
      // Silent fail on poll errors
    }
  }

  async sendMessage(message) {
    if (!this.isConnected || !this.livestreamId) return false;

    try {
      const res = await fetch(`${ARENA_API}/live-chat/broadcast`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          sessionType: 'livestream',
          sessionId: this.livestreamId,
          messageData: { type: 'text', message },
          sender: this.senderInfo,
        }),
      });

      if (!res.ok) {
        console.error(`Arena: send failed (${res.status})`);
        return false;
      }

      const result = await res.json();
      return result.success === true;
    } catch (error) {
      console.error('Arena: send error:', error.message);
      return false;
    }
  }

  disconnect() {
    this.stopPolling();
    this.isConnected = false;
    this.livestreamId = null;
    this.seenMessageIds.clear();
    console.log('Arena: disconnected');
    this.emit('disconnected');
  }
}

module.exports = ArenaChat;
