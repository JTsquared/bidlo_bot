const BLAZE_API = 'https://api.blaze.stream/v1';

class BlazeChatAPI {
  constructor(tokenManager, clientId, channelId) {
    this.tokenManager = tokenManager;
    this.clientId = clientId;
    this.channelId = channelId;
    this.recentMessages = new Map();
  }

  async sendMessage(channelId, message) {
    // Deduplicate messages within 3 seconds
    const dedupeKey = `${channelId}:${message}`;
    const lastSent = this.recentMessages.get(dedupeKey);
    const now = Date.now();
    if (lastSent && now - lastSent < 3000) return true;
    this.recentMessages.set(dedupeKey, now);
    for (const [key, ts] of this.recentMessages) {
      if (now - ts > 10000) this.recentMessages.delete(key);
    }

    // Use bot's user access token — sends as the bot user
    const token = await this.tokenManager.getAccessToken('bot');
    if (!token) {
      console.error('BlazeChatAPI: no bot access token');
      return false;
    }

    try {
      const response = await fetch(`${BLAZE_API}/chats/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': this.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channelId: channelId || this.channelId,
          message: message.substring(0, 500),
        }),
      });

      if (response.status === 429) {
        console.warn('BlazeChatAPI: rate limited');
        return false;
      }

      if (!response.ok) {
        const err = await response.text();
        console.error(`BlazeChatAPI: send failed (${response.status}):`, err.substring(0, 200));
        return false;
      }

      return true;
    } catch (error) {
      console.error('BlazeChatAPI: send error:', error.message);
      return false;
    }
  }
}

module.exports = BlazeChatAPI;
