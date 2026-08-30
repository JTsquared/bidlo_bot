const EventEmitter = require('events');
const WebSocket = require('ws');

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

class TwitchChat extends EventEmitter {
  constructor(tokenManager, channel) {
    super();
    this.tokenManager = tokenManager;
    this.channel = channel.toLowerCase().replace('#', '');
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.recentMessages = new Map();
  }

  async connect() {
    const token = await this.tokenManager.getAccessToken('bot');
    if (!token) {
      console.error('[TwitchChat] No bot access token available');
      return false;
    }

    // Validate token to get bot username
    const validation = await this.tokenManager.validate(token);
    if (!validation) {
      console.error('[TwitchChat] Token validation failed');
      return false;
    }
    this.botUsername = validation.login;

    console.log(`[TwitchChat] Connecting as ${this.botUsername}...`);

    return new Promise((resolve) => {
      this.ws = new WebSocket(TWITCH_IRC_URL);

      this.ws.on('open', () => {
        // Request tags for user metadata (badges, display name, user ID, etc.)
        this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        this.ws.send(`PASS oauth:${token}`);
        this.ws.send(`NICK ${this.botUsername}`);
      });

      this.ws.on('message', (data) => {
        const raw = data.toString();
        const lines = raw.split('\r\n').filter(Boolean);
        for (const line of lines) {
          this.handleLine(line, resolve);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[TwitchChat] Disconnected (${code}): ${reason || 'unknown'}`);
        this.isConnected = false;
        this.stopPing();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[TwitchChat] WebSocket error:', error.message);
      });

      // Timeout if we don't connect in 15 seconds
      setTimeout(() => {
        if (!this.isConnected) {
          console.error('[TwitchChat] Connection timed out');
          resolve(false);
        }
      }, 15000);
    });
  }

  handleLine(line, resolveConnect) {
    // Respond to PING to stay connected
    if (line.startsWith('PING')) {
      this.ws.send('PONG :tmi.twitch.tv');
      return;
    }

    // Parse IRC tags
    let tags = {};
    let remainder = line;

    if (remainder.startsWith('@')) {
      const spaceIdx = remainder.indexOf(' ');
      const tagStr = remainder.substring(1, spaceIdx);
      remainder = remainder.substring(spaceIdx + 1);
      for (const part of tagStr.split(';')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx !== -1) {
          tags[part.substring(0, eqIdx)] = part.substring(eqIdx + 1);
        }
      }
    }

    // Parse prefix, command, params
    let prefix = '';
    if (remainder.startsWith(':')) {
      const spaceIdx = remainder.indexOf(' ');
      prefix = remainder.substring(1, spaceIdx);
      remainder = remainder.substring(spaceIdx + 1);
    }

    const parts = remainder.split(' ');
    const command = parts[0];

    // Successfully joined channel
    if (command === '376' || command === '001') {
      this.ws.send(`JOIN #${this.channel}`);
    }

    if (command === 'JOIN' && remainder.includes(`#${this.channel}`)) {
      console.log(`[TwitchChat] Joined #${this.channel}`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.startPing();
      if (resolveConnect) resolveConnect(true);
    }

    // Chat message
    if (command === 'PRIVMSG') {
      const channelName = parts[1];
      const text = parts.slice(2).join(' ').replace(/^:/, '');

      const username = tags['display-name'] || prefix.split('!')[0] || 'Anonymous';
      const userId = tags['user-id'] || '';
      const isSub = tags['subscriber'] === '1';
      const isMod = tags['mod'] === '1';
      const badges = tags['badges'] || '';
      const isBroadcaster = badges.includes('broadcaster');

      this.emit('chatMessage', {
        username,
        userId,
        text,
        channelId: channelName,
        messageId: tags['id'] || '',
        isSubscriber: isSub,
        isMod,
        isBroadcaster,
        badges,
        emotes: tags['emotes'] || '',
        color: tags['color'] || '',
      });
    }

    // USERNOTICE covers subs, raids, gift subs, etc.
    if (command === 'USERNOTICE') {
      const msgId = tags['msg-id'];

      if (msgId === 'raid') {
        const raiderName = tags['display-name'] || tags['login'] || 'Someone';
        const viewerCount = parseInt(tags['msg-param-viewerCount']) || 0;

        this.emit('raid', {
          username: raiderName,
          userId: tags['user-id'] || '',
          viewerCount,
          timestamp: Date.now(),
        });
      }

      if (msgId === 'sub' || msgId === 'resub') {
        this.emit('subscription', {
          username: tags['display-name'] || tags['login'],
          userId: tags['user-id'],
          months: parseInt(tags['msg-param-cumulative-months']) || 1,
          tier: tags['msg-param-sub-plan'] || '1000',
          message: parts.slice(2).join(' ').replace(/^:/, '') || '',
        });
      }
    }

    // RECONNECT — Twitch is asking us to reconnect
    if (command === 'RECONNECT') {
      console.log('[TwitchChat] Server requested reconnect');
      this.ws.close();
    }
  }

  async sendMessage(message) {
    if (!this.isConnected || !this.ws) return false;

    // Deduplicate messages within 3 seconds
    const dedupeKey = message;
    const lastSent = this.recentMessages.get(dedupeKey);
    const now = Date.now();
    if (lastSent && now - lastSent < 3000) return true;
    this.recentMessages.set(dedupeKey, now);
    for (const [key, ts] of this.recentMessages) {
      if (now - ts > 10000) this.recentMessages.delete(key);
    }

    try {
      // Twitch chat max is 500 characters
      this.ws.send(`PRIVMSG #${this.channel} :${message.substring(0, 500)}`);
      return true;
    } catch (error) {
      console.error('[TwitchChat] Send error:', error.message);
      return false;
    }
  }

  startPing() {
    this.stopPing();
    // Send PING every 4 minutes to keep connection alive
    this.pingTimer = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.send('PING :tmi.twitch.tv');
      }
    }, 240000);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[TwitchChat] Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    console.log(`[TwitchChat] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      if (!this.isConnected) {
        await this.connect();
      }
    }, delay);
  }

  disconnect() {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.maxReconnectAttempts = 0; // Prevent reconnect on intentional disconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    console.log('[TwitchChat] Disconnected');
  }
}

module.exports = TwitchChat;
