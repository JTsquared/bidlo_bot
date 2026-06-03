const BLAZE_API = 'https://api.blaze.stream/v1';

class SubscriberService {
  constructor(tokenManager, clientId, channelId) {
    this.tokenManager = tokenManager;
    this.clientId = clientId;
    this.channelId = channelId;
    this.subscribers = new Map();
    this.lastRefresh = 0;
    this.refreshIntervalMs = 300000; // 5 minutes
  }

  async refresh() {
    // Use streamer's token (has access to their subscriber list)
    const token = await this.tokenManager.getAccessToken('streamer');
    if (!token) {
      console.error('Subscribers: no streamer access token');
      return;
    }

    try {
      let allRows = [];
      let cursor = null;

      do {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);

        const response = await fetch(`${BLAZE_API}/channels/subscribers?${params}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Client-Id': this.clientId,
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const err = await response.text();
          console.error(`Subscribers: list failed (${response.status}):`, err.substring(0, 200));
          break;
        }

        const data = await response.json();
        if (allRows.length === 0) {
          console.log('Subscribers: response:', JSON.stringify(data).substring(0, 500));
        }
        const rows = data.rows || data.data?.rows || data.data || [];
        allRows = allRows.concat(Array.isArray(rows) ? rows : []);
        cursor = data.pagination?.cursor || data.data?.pagination?.cursor || null;
      } while (cursor);

      this.subscribers.clear();
      for (const sub of allRows) {
        const name = (sub.slug || sub.username || sub.displayName || '').toLowerCase();
        if (name) {
          this.subscribers.set(name, {
            userId: sub.id || sub.userId,
            displayName: sub.displayName,
            username: sub.slug || sub.username,
          });
        }
      }

      this.lastRefresh = Date.now();
      console.log(`Subscribers: ${this.subscribers.size} active`);
    } catch (error) {
      console.error('Subscribers: refresh error:', error.message);
    }
  }

  async isSubscriber(username) {
    if (Date.now() - this.lastRefresh > this.refreshIntervalMs) {
      await this.refresh();
    }
    return this.subscribers.has(username.toLowerCase());
  }
}

module.exports = SubscriberService;
