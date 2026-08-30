const EventEmitter = require('events');
const WebSocket = require('ws');

const TWITCH_EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const TWITCH_API = 'https://api.twitch.tv/helix';

class TwitchEventSub extends EventEmitter {
  constructor(tokenManager) {
    super();
    this.tokenManager = tokenManager;
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.subscribedTypes = new Set();
    this.pendingSubscriptions = [];
    this.keepaliveTimeout = null;
    this.keepaliveTimeoutMs = 15000; // Twitch default, updated from welcome message
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.broadcasterId = null;
  }

  async connect() {
    console.log('[TwitchEventSub] Connecting...');

    return new Promise((resolve) => {
      this.ws = new WebSocket(TWITCH_EVENTSUB_URL);

      this.ws.on('open', () => {
        console.log('[TwitchEventSub] WebSocket connected, waiting for session_welcome...');
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (error) {
          console.error('[TwitchEventSub] Parse error:', error.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[TwitchEventSub] Disconnected (${code}): ${reason || 'unknown'}`);
        this.isConnected = false;
        this.sessionId = null;
        this.clearKeepalive();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[TwitchEventSub] WebSocket error:', error.message);
      });

      this.once('ready', () => resolve(true));

      setTimeout(() => {
        if (!this.isConnected) {
          console.error('[TwitchEventSub] Connection timed out');
          resolve(false);
        }
      }, 15000);
    });
  }

  handleMessage(msg) {
    const messageType = msg.metadata?.message_type;

    if (messageType === 'session_welcome') {
      this.sessionId = msg.payload?.session?.id;
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Update keepalive timeout from server
      const serverTimeout = msg.payload?.session?.keepalive_timeout_seconds;
      if (serverTimeout) {
        // Add buffer — if we don't hear within timeout + 10s, reconnect
        this.keepaliveTimeoutMs = (serverTimeout + 10) * 1000;
      }

      console.log(`[TwitchEventSub] Session established: ${this.sessionId}`);
      this.resetKeepalive();
      this.emit('ready');
      this.processPendingSubscriptions();
      return;
    }

    if (messageType === 'session_keepalive') {
      this.resetKeepalive();
      return;
    }

    if (messageType === 'session_reconnect') {
      // Twitch is telling us to reconnect to a new URL
      const reconnectUrl = msg.payload?.session?.reconnect_url;
      if (reconnectUrl) {
        console.log('[TwitchEventSub] Server requested reconnect');
        this.reconnectToUrl(reconnectUrl);
      }
      return;
    }

    if (messageType === 'notification') {
      this.resetKeepalive();
      this.handleNotification(msg);
      return;
    }

    if (messageType === 'revocation') {
      const subType = msg.payload?.subscription?.type;
      console.log(`[TwitchEventSub] Subscription revoked: ${subType}`);
      this.subscribedTypes.delete(subType);
      return;
    }
  }

  handleNotification(msg) {
    const subType = msg.payload?.subscription?.type;
    const event = msg.payload?.event;
    if (!event) return;

    switch (subType) {
      case 'channel.raid': {
        const username = event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'Someone';
        const viewerCount = event.viewers || 0;
        this.emit('raid', {
          username,
          userId: event.from_broadcaster_user_id,
          viewerCount,
          timestamp: Date.now(),
        });
        break;
      }
      case 'channel.subscribe': {
        this.emit('subscription', {
          username: event.user_name || event.user_login,
          userId: event.user_id,
          tier: event.tier,
          isGift: event.is_gift,
        });
        break;
      }
      default:
        this.emit('event', { type: subType, event });
        break;
    }
  }

  async subscribe(type, condition) {
    if (!this.sessionId) {
      this.pendingSubscriptions.push({ type, condition });
      console.log(`[TwitchEventSub] Queued subscription for ${type}`);
      return true;
    }

    if (this.subscribedTypes.has(type)) return true;

    const token = await this.tokenManager.getAppToken();
    if (!token) return false;

    try {
      const response = await fetch(`${TWITCH_API}/eventsub/subscriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': this.tokenManager.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type,
          version: '1',
          condition,
          transport: {
            method: 'websocket',
            session_id: this.sessionId,
          },
        }),
      });

      if (response.ok) {
        this.subscribedTypes.add(type);
        console.log(`[TwitchEventSub] Subscribed to ${type}`);
        return true;
      } else {
        const err = await response.text();
        console.error(`[TwitchEventSub] Failed to subscribe ${type} (${response.status}):`, err.substring(0, 200));
        return false;
      }
    } catch (error) {
      console.error(`[TwitchEventSub] Error subscribing ${type}:`, error.message);
      return false;
    }
  }

  async subscribeChannel(broadcasterId) {
    this.broadcasterId = broadcasterId;

    await this.subscribe('channel.raid', {
      to_broadcaster_user_id: broadcasterId,
    });
  }

  async processPendingSubscriptions() {
    const pending = [...this.pendingSubscriptions];
    this.pendingSubscriptions = [];
    for (const { type, condition } of pending) {
      await this.subscribe(type, condition);
    }

    // Re-subscribe to channel events if we had a broadcaster ID
    if (this.broadcasterId) {
      await this.subscribeChannel(this.broadcasterId);
    }
  }

  resetKeepalive() {
    this.clearKeepalive();
    this.keepaliveTimeout = setTimeout(() => {
      console.log('[TwitchEventSub] Keepalive timeout — reconnecting');
      if (this.ws) this.ws.close();
    }, this.keepaliveTimeoutMs);
  }

  clearKeepalive() {
    if (this.keepaliveTimeout) {
      clearTimeout(this.keepaliveTimeout);
      this.keepaliveTimeout = null;
    }
  }

  async reconnectToUrl(url) {
    // Close old connection, connect to new URL
    const oldWs = this.ws;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[TwitchEventSub] Reconnected to new URL');
      if (oldWs) oldWs.close();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (error) {
        console.error('[TwitchEventSub] Parse error:', error.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[TwitchEventSub] Disconnected (${code}): ${reason || 'unknown'}`);
      this.isConnected = false;
      this.sessionId = null;
      this.clearKeepalive();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[TwitchEventSub] WebSocket error:', error.message);
    });
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[TwitchEventSub] Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    console.log(`[TwitchEventSub] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);

    setTimeout(async () => {
      if (!this.isConnected) {
        await this.connect();
      }
    }, delay);
  }

  disconnect() {
    this.clearKeepalive();
    this.maxReconnectAttempts = 0; // Prevent reconnect on intentional disconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.subscribedTypes.clear();
    this.pendingSubscriptions = [];
    console.log('[TwitchEventSub] Disconnected');
  }
}

module.exports = TwitchEventSub;
