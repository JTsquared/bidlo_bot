const BLAZE_API = 'https://api.blaze.stream/v1';
const BLAZE_TOKEN_URL = 'https://blaze.stream/bapi/oauth2/token';

class SubscriberService {
  constructor(clientId, clientSecret, channelId) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.channelId = channelId;
    this.appAccessToken = null;
    this.tokenExpiresAt = 0;
    this.subscribers = new Map(); // lowercase username -> subscriber info
    this.lastRefresh = 0;
    this.refreshIntervalMs = 300000; // Refresh every 5 minutes
  }

  async getAppToken() {
    if (this.appAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.appAccessToken;
    }

    try {
      const response = await fetch(BLAZE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          grantType: 'client_credentials',
        }),
      });

      if (!response.ok) {
        console.error(`Blaze app token failed (${response.status}):`, await response.text());
        return null;
      }

      const data = await response.json();
      this.appAccessToken = data.accessToken;
      this.tokenExpiresAt = Date.now() + (data.expiresIn - 60) * 1000; // Refresh 60s early
      console.log('Blaze: app access token obtained');
      return this.appAccessToken;
    } catch (error) {
      console.error('Blaze app token error:', error.message);
      return null;
    }
  }

  async refresh() {
    if (!this.clientId || !this.clientSecret) return;

    const token = await this.getAppToken();
    if (!token) return;

    try {
      let allRows = [];
      let cursor = null;

      do {
        const params = new URLSearchParams({ limit: '100' });
        if (this.channelId) params.set('channelId', this.channelId);
        if (cursor) params.set('cursor', cursor);

        const response = await fetch(`${BLAZE_API}/channels/subscribers?${params}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Client-Id': this.clientId,
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          console.error(`Subscriber list failed (${response.status}):`, await response.text());
          break;
        }

        const data = await response.json();
        const rows = data.rows || [];
        allRows = allRows.concat(rows);
        cursor = data.pagination?.cursor || null;
      } while (cursor);

      this.subscribers.clear();
      for (const sub of allRows) {
        const name = (sub.username || sub.displayName || '').toLowerCase();
        if (name) {
          this.subscribers.set(name, {
            userId: sub.userId,
            displayName: sub.displayName,
            username: sub.username,
            expiresAt: sub.subscriptionInfo?.expiresAt,
          });
        }
      }

      this.lastRefresh = Date.now();
      console.log(`Subscribers: ${this.subscribers.size} active`);
    } catch (error) {
      console.error('Subscriber refresh error:', error.message);
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
