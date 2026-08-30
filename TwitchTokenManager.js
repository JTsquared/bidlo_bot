const fs = require('fs');
const path = require('path');

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const ENV_PATH = path.join(__dirname, '.env');

class TwitchTokenManager {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokens = {}; // keyed by name: { accessToken, refreshToken, expiresAt }
  }

  addToken(name, accessToken, refreshToken) {
    this.tokens[name] = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 14400000, // Assume ~4h remaining on fresh token
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
      console.error(`TwitchToken: no refresh token for ${name}`);
      return false;
    }

    try {
      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      });

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`TwitchToken: refresh failed for ${name} (${response.status}):`, err.substring(0, 200));
        return false;
      }

      const data = await response.json();
      token.accessToken = data.access_token;
      token.expiresAt = Date.now() + (data.expires_in - 60) * 1000;

      // Twitch always returns a new refresh token
      if (data.refresh_token) {
        token.refreshToken = data.refresh_token;
      }

      console.log(`TwitchToken: refreshed ${name} (expires in ${data.expires_in}s)`);

      // Persist new tokens to .env
      this.saveToEnv(name, token);

      return true;
    } catch (error) {
      console.error(`TwitchToken: refresh error for ${name}:`, error.message);
      return false;
    }
  }

  saveToEnv(name, token) {
    try {
      if (!fs.existsSync(ENV_PATH)) return;
      let content = fs.readFileSync(ENV_PATH, 'utf8');

      const prefix = name === 'bot' ? 'TWITCH_BOT' : 'TWITCH_STREAMER';

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
      console.error(`TwitchToken: failed to save ${name} to .env:`, error.message);
    }
  }

  async getAppToken() {
    const existing = this.tokens['app'];
    if (existing && Date.now() < existing.expiresAt) {
      return existing.accessToken;
    }

    try {
      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
      });

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        console.error(`TwitchToken: app token failed (${response.status})`);
        return null;
      }

      const data = await response.json();
      this.tokens['app'] = {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      };
      console.log('TwitchToken: app access token obtained');
      return data.access_token;
    } catch (error) {
      console.error('TwitchToken: app token error:', error.message);
      return null;
    }
  }

  /**
   * Exchange an authorization code for tokens (used by OAuth callback).
   * Returns { access_token, refresh_token, expires_in } or null on failure.
   */
  async exchangeCode(code, redirectUri) {
    try {
      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error(`TwitchToken: code exchange failed (${response.status}):`, err.substring(0, 200));
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('TwitchToken: code exchange error:', error.message);
      return null;
    }
  }

  /**
   * Validate a token and get user info (login, user_id, scopes).
   */
  async validate(accessToken) {
    try {
      const response = await fetch(VALIDATE_URL, {
        headers: { Authorization: `OAuth ${accessToken}` },
      });

      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('TwitchToken: validate error:', error.message);
      return null;
    }
  }
}

module.exports = TwitchTokenManager;
