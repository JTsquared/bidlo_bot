const fs = require('fs');
const path = require('path');

const TOKEN_URL = 'https://blaze.stream/bapi/oauth2/token';
const REFRESH_URL = 'https://blaze.stream/bapi/oauth2/refresh';
const ENV_PATH = path.join(__dirname, '.env');

class BlazeTokenManager {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokens = {}; // keyed by name: { accessToken, refreshToken, expiresAt }
  }

  addToken(name, accessToken, refreshToken) {
    this.tokens[name] = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 82800000, // Assume ~23h remaining on fresh token
    };
  }

  async getAccessToken(name) {
    const token = this.tokens[name];
    if (!token) return null;

    // Refresh if expiring within 5 minutes
    if (Date.now() > token.expiresAt - 300000) {
      await this.refresh(name);
    }

    return token.accessToken;
  }

  async refresh(name) {
    const token = this.tokens[name];
    if (!token?.refreshToken) {
      console.error(`BlazeToken: no refresh token for ${name}`);
      return false;
    }

    try {
      const response = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          refreshToken: token.refreshToken,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`BlazeToken: refresh failed for ${name} (${response.status}):`, err.substring(0, 200));
        return false;
      }

      const data = await response.json();
      token.accessToken = data.accessToken;
      token.expiresAt = Date.now() + (data.expiresIn - 60) * 1000;

      // Update refresh token if a new one was issued
      if (data.refreshToken) {
        token.refreshToken = data.refreshToken;
      }

      console.log(`BlazeToken: refreshed ${name} (expires in ${data.expiresIn}s)`);

      // Persist new tokens to .env
      this.saveToEnv(name, token);

      return true;
    } catch (error) {
      console.error(`BlazeToken: refresh error for ${name}:`, error.message);
      return false;
    }
  }

  saveToEnv(name, token) {
    try {
      if (!fs.existsSync(ENV_PATH)) return;
      let content = fs.readFileSync(ENV_PATH, 'utf8');

      const prefix = name === 'bot' ? 'BLAZE_BOT' : 'BLAZE_STREAMER';

      const accessRegex = new RegExp(`^${prefix}_ACCESS_TOKEN=.*$`, 'm');
      const refreshRegex = new RegExp(`^${prefix}_REFRESH_TOKEN=.*$`, 'm');

      if (accessRegex.test(content)) {
        content = content.replace(accessRegex, `${prefix}_ACCESS_TOKEN=${token.accessToken}`);
      }
      if (refreshRegex.test(content) && token.refreshToken) {
        content = content.replace(refreshRegex, `${prefix}_REFRESH_TOKEN=${token.refreshToken}`);
      }

      fs.writeFileSync(ENV_PATH, content);
    } catch (error) {
      console.error(`BlazeToken: failed to save ${name} to .env:`, error.message);
    }
  }

  async getAppToken() {
    const existing = this.tokens['app'];
    if (existing && Date.now() < existing.expiresAt) {
      return existing.accessToken;
    }

    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          grantType: 'client_credentials',
        }),
      });

      if (!response.ok) {
        console.error(`BlazeToken: app token failed (${response.status})`);
        return null;
      }

      const data = await response.json();
      this.tokens['app'] = {
        accessToken: data.accessToken,
        expiresAt: Date.now() + (data.expiresIn - 60) * 1000,
      };
      console.log('BlazeToken: app access token obtained');
      return data.accessToken;
    } catch (error) {
      console.error('BlazeToken: app token error:', error.message);
      return null;
    }
  }
}

module.exports = BlazeTokenManager;
