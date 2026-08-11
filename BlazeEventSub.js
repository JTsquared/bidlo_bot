const { io } = require('socket.io-client');
const EventEmitter = require('events');

const BLAZE_API = 'https://api.blaze.stream/v1';

class BlazeEventSub extends EventEmitter {
  constructor(tokenManager, clientId) {
    super();
    this.tokenManager = tokenManager;
    this.clientId = clientId;
    this.socket = null;
    this.sessionId = null;
    this.isConnected = false;
    this.subscribedChannels = new Map();
    this.pendingSubscriptions = [];
    this.previousChannels = [];
  }

  async connect() {
    // Use app token (client_credentials) — doesn't require user OAuth
    const token = await this.tokenManager.getAppToken();
    if (!token) {
      console.error('[EventSub] No access token available');
      return false;
    }

    console.log('[EventSub] Connecting...');
    this.serverDisconnects = 0;

    this.socket = io('https://blaze.stream', {
      path: '/ws',
      transports: ['websocket'],
      upgrade: false,
      auth: { token: `Bearer ${token}` },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
    });

    this.socket.on('connect', async () => {
      console.log('[EventSub] Socket connected, waiting for session_welcome...');
      this.serverDisconnects = 0;
      const freshToken = await this.tokenManager.getAppToken().catch(() => null);
      if (freshToken && this.socket) {
        this.socket.auth = { token: `Bearer ${freshToken}` };
      }
    });

    this.socket.on('eventsub', (data) => this.handleMessage(data));

    this.socket.on('disconnect', (reason) => {
      console.log(`[EventSub] Disconnected: ${reason}`);
      if (this.subscribedChannels.size > 0) {
        this.previousChannels = Array.from(this.subscribedChannels.keys());
      }
      this.isConnected = false;
      this.sessionId = null;
      this.subscribedChannels.clear();

      if (reason === 'io server disconnect' && this.socket) {
        this.serverDisconnects++;
        if (this.serverDisconnects > 5) {
          console.error('[EventSub] Too many server disconnects, stopping reconnection');
          return;
        }
        var delay = Math.min(3000 * Math.pow(2, this.serverDisconnects - 1), 60000);
        console.log(`[EventSub] Reconnecting in ${delay / 1000}s (attempt ${this.serverDisconnects})...`);
        setTimeout(async () => {
          if (!this.isConnected && this.socket) {
            const freshToken = await this.tokenManager.getAppToken().catch(() => null);
            if (freshToken) this.socket.auth = { token: `Bearer ${freshToken}` };
            this.socket.connect();
          }
        }, delay);
      }
    });

    this.socket.on('connect_error', async (error) => {
      console.error('[EventSub] Connection error:', error.message);
      const freshToken = await this.tokenManager.getAppToken().catch(() => null);
      if (freshToken && this.socket) {
        this.socket.auth = { token: `Bearer ${freshToken}` };
      }
    });

    return new Promise((resolve) => {
      this.once('ready', () => resolve(true));
      setTimeout(() => {
        if (!this.isConnected) {
          console.error('[EventSub] Timed out waiting for session_welcome');
          resolve(false);
        }
      }, 15000);
    });
  }

  handleMessage(data) {
    if (!data || !data.metadata) return;
    const { messageType, subscriptionType } = data.metadata;

    if (messageType === 'session_welcome') {
      this.sessionId = data.payload?.sessionId;
      this.isConnected = true;
      console.log(`[EventSub] Session established: ${this.sessionId}`);
      this.emit('ready');
      this.processPendingSubscriptions();
      return;
    }

    if (messageType === 'notification' && data.payload) {
      this.handleNotification(subscriptionType, data.payload);
    }
  }

  handleNotification(type, payload) {
    switch (type) {
      case 'channel.raid':
        this.handleRaid(payload);
        break;
      default:
        this.emit('event', { type, payload });
        break;
    }
  }

  handleRaid(payload) {
    const { raider, channelId } = payload;
    if (!raider) return;

    const username = raider.displayName || raider.username || 'Someone';
    const viewerCount = payload.viewerCount || payload.viewers || payload.raidSize || null;

    this.emit('raid', {
      channelId,
      username,
      userId: raider.id,
      avatarUrl: raider.avatarUrl,
      viewerCount,
      timestamp: Date.now(),
    });
  }

  async subscribeChannel(channelId, eventTypes = ['channel.raid']) {
    if (!this.sessionId) {
      this.pendingSubscriptions.push({ channelId, eventTypes });
      console.log(`[EventSub] Queued subscription for ${channelId.substring(0, 8)}...`);
      return true;
    }

    const token = await this.tokenManager.getAppToken();
    if (!token) return false;

    let allSuccess = true;
    for (const type of eventTypes) {
      const channelSubs = this.subscribedChannels.get(channelId);
      if (channelSubs && channelSubs.has(type)) continue;

      try {
        const response = await fetch(`${BLAZE_API}/events/subscriptions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Client-Id': this.clientId,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            type,
            version: '1',
            sessionId: this.sessionId,
            condition: { channelId },
          }),
        });

        if (response.ok) {
          if (!this.subscribedChannels.has(channelId)) {
            this.subscribedChannels.set(channelId, new Set());
          }
          this.subscribedChannels.get(channelId).add(type);
          console.log(`[EventSub] Subscribed to ${type}`);
        } else {
          const err = await response.text();
          console.error(`[EventSub] Failed to subscribe ${type} (${response.status}):`, err.substring(0, 200));
          allSuccess = false;
        }
      } catch (error) {
        console.error(`[EventSub] Error subscribing ${type}:`, error.message);
        allSuccess = false;
      }
    }
    return allSuccess;
  }

  async processPendingSubscriptions() {
    const pending = [...this.pendingSubscriptions];
    this.pendingSubscriptions = [];
    for (const { channelId, eventTypes } of pending) {
      await this.subscribeChannel(channelId, eventTypes);
    }
    if (this.previousChannels.length > 0) {
      const channels = [...this.previousChannels];
      this.previousChannels = [];
      console.log(`[EventSub] Re-subscribing ${channels.length} channel(s) after reconnect...`);
      for (const channelId of channels) {
        await this.subscribeChannel(channelId);
      }
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.subscribedChannels.clear();
    this.pendingSubscriptions = [];
  }
}

module.exports = BlazeEventSub;
