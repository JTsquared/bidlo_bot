const fs = require('fs');
const path = require('path');

const CHANNEL_CACHE_FILE = path.join(__dirname, 'channel_cache.json');

class BlazeAPI {
  constructor(config) {
    this.config = config;
    this.baseUrl = 'https://blaze.stream/bapi';
    this.channelCache = this.loadChannelCache();
  }

  loadChannelCache() {
    try {
      if (fs.existsSync(CHANNEL_CACHE_FILE)) {
        return JSON.parse(fs.readFileSync(CHANNEL_CACHE_FILE, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading channel cache:', error.message);
    }
    return {};
  }

  saveChannelCache() {
    try {
      fs.writeFileSync(CHANNEL_CACHE_FILE, JSON.stringify(this.channelCache, null, 2));
    } catch (error) {
      console.error('Error saving channel cache:', error.message);
    }
  }

  getHeaders() {
    const { authToken, visitorId } = this.config;
    return {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      Cookie: `visitorId=${visitorId}; token=${authToken}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Visitor-Id': visitorId,
    };
  }

  async isFollowingChannel(channelId) {
    try {
      const response = await fetch(`${this.baseUrl}/channels/${channelId}/info`, { method: 'GET', headers: this.getHeaders() });
      if (response.ok) {
        const result = await response.json();
        return result.success && result.data?.isFollower === true;
      }
      return false;
    } catch { return false; }
  }

  async isChannelLive(channelId) {
    try {
      const response = await fetch(`${this.baseUrl}/channels/${channelId}`, { method: 'GET', headers: this.getHeaders() });
      if (response.ok) {
        const result = await response.json();
        const data = result.data || result;
        const isLive = data.isLive === true || data.is_live === true || data.streamingState === 'STREAMING';
        return isLive;
      }
      return false;
    } catch { return false; }
  }

  async followChannel(channelId) {
    try {
      const response = await fetch(`${this.baseUrl}/channels/${channelId}/follow`, {
        method: 'POST',
        headers: { ...this.getHeaders(), 'Content-Length': '0' },
      });
      return response.ok;
    } catch { return false; }
  }
}

module.exports = BlazeAPI;
