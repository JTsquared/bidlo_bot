require('dotenv').config();

const BlazeAPI = require('./BlazeAPI.js');
const BlazeWebSocket = require('./BlazeWebSocket.js');
const SongDatabase = require('./Database.js');
const CustomsForge = require('./CustomsForge.js');
const CommandHandler = require('./CommandHandler.js');
const WebServer = require('./WebServer.js');
const TimedMessages = require('./TimedMessages.js');
const PlaywrightAuth = require('./PlaywrightAuth.js');

// --- Validate env ---
const blazeConfig = {
  authToken: process.env.BLAZE_AUTH_TOKEN,
  visitorId: process.env.BLAZE_VISITOR_ID,
  channelId: process.env.BLAZE_CHANNEL_ID,
};

if (!blazeConfig.authToken || blazeConfig.authToken === 'your_auth_token_here') {
  console.error('Please set your Blaze credentials in .env (see .env.example)');
  process.exit(1);
}

const streamerUsername = process.env.STREAMER_USERNAME;
if (!streamerUsername) {
  console.error('Please set STREAMER_USERNAME in .env');
  process.exit(1);
}

// Target channel — the streamer's channel where the bot listens and responds
// Falls back to the bot's own channel if not set
const targetChannelId = process.env.BIDLO_PERV_CHANNEL_ID || blazeConfig.channelId;

const webPort = parseInt(process.env.WEB_PORT) || 3000;
const hasCFCredentials = !!(process.env.CUSTOMSFORGE_EMAIL && process.env.CUSTOMSFORGE_PASSWORD);

// --- Initialize ---
const db = new SongDatabase();
const blazeAPI = new BlazeAPI(blazeConfig);
const blazeWS = new BlazeWebSocket({ ...blazeConfig, targetChannelId }, blazeAPI);

let playwrightAuth = null;
let cf = null;
let isStreamLive = false;

const sendMessage = (channelId, message) => blazeWS.sendChatMessage(channelId, message);
const commandHandler = new CommandHandler(db, null, sendMessage, streamerUsername);
const timedMessages = new TimedMessages(sendMessage, targetChannelId);
const webServer = new WebServer(db, timedMessages, webPort);

// --- CustomsForge session management ---
async function connectCustomsForge() {
  if (cf || !hasCFCredentials) return;

  try {
    console.log('CustomsForge: connecting...');
    playwrightAuth = await PlaywrightAuth.create();
    if (playwrightAuth && playwrightAuth.isLoggedIn) {
      cf = new CustomsForge(playwrightAuth);
      commandHandler.cf = cf;
      console.log('CustomsForge: connected — live search enabled');
    }
  } catch (error) {
    console.warn('CustomsForge: connection failed -', error.message);
    console.warn('Song search will use local cache only');
  }
}

async function disconnectCustomsForge() {
  if (!playwrightAuth) return;

  console.log('CustomsForge: disconnecting...');
  cf = null;
  commandHandler.cf = null;
  await playwrightAuth.close();
  playwrightAuth = null;
  console.log('CustomsForge: disconnected');
}

// --- Chat handler ---
blazeWS.on('chatMessage', (data) => {
  if (!data.text || !data.channelId) return;
  commandHandler.handle(data.username, data.userId || data.userChannelId, data.text, data.channelId);
});

// --- Stream status handlers ---
blazeWS.on('streamLive', async () => {
  if (isStreamLive) return;
  isStreamLive = true;
  console.log('Stream is LIVE — activating song requests');
  await connectCustomsForge();
});

blazeWS.on('streamOffline', async () => {
  if (!isStreamLive) return;
  isStreamLive = false;
  console.log('Stream is OFFLINE — deactivating song requests');
  await disconnectCustomsForge();
});

// --- Periodic live status poll (fallback in case we miss socket events) ---
let liveCheckInterval = null;

function startLivePolling() {
  if (liveCheckInterval) return;
  liveCheckInterval = setInterval(async () => {
    const live = await blazeAPI.isChannelLive(targetChannelId);
    if (live && !isStreamLive) {
      isStreamLive = true;
      console.log('Stream is LIVE (detected via poll)');
      await connectCustomsForge();
    } else if (!live && isStreamLive) {
      isStreamLive = false;
      console.log('Stream is OFFLINE (detected via poll)');
      await disconnectCustomsForge();
    }
  }, 120000); // Check every 2 minutes
}

function stopLivePolling() {
  if (liveCheckInterval) {
    clearInterval(liveCheckInterval);
    liveCheckInterval = null;
  }
}

// --- Reconnection ---
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;
let isReconnecting = false;

async function attemptReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;

  while (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * reconnectAttempts;
    console.log(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await blazeWS.connect();
      reconnectAttempts = 0;
      isReconnecting = false;
      console.log('Reconnected successfully');
      return;
    } catch (error) {
      console.error(`Reconnect attempt ${reconnectAttempts} failed:`, error.message);
    }
  }

  isReconnecting = false;
  console.error(`Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
}

// --- Events ---
blazeWS.on('connected', async () => {
  console.log('Blaze connected - bot ready');
  timedMessages.start();
  startLivePolling();

  // Check if stream is already live on connect
  const live = await blazeAPI.isChannelLive(targetChannelId);
  if (live && !isStreamLive) {
    isStreamLive = true;
    console.log('Stream is currently LIVE');
    await connectCustomsForge();
  } else if (!live) {
    console.log('Stream is currently offline — will connect to CustomsForge when stream goes live');
  }
});

blazeWS.on('disconnected', (reason) => {
  console.log('Blaze disconnected:', reason);
  timedMessages.stop();
  stopLivePolling();
  attemptReconnect();
});

// --- Start ---
async function main() {
  console.log('Bidlo Bot starting...');

  const stats = db.getStats();
  console.log(`Database: ${stats.artists} artists, ${stats.titles} titles cached`);

  if (!hasCFCredentials) {
    console.warn('CustomsForge: no credentials set — song search will use local cache only');
  }

  webServer.start();

  try {
    await blazeWS.connect();
    console.log(`Connected to Blaze — streamer: ${streamerUsername}`);
    console.log(`Web UI: http://localhost:${webPort}`);
    console.log(`OBS Overlay: http://localhost:${webPort}/overlay`);
  } catch (error) {
    console.error('Initial connection failed:', error.message);
    console.log('Web UI is still available — the bot will retry connecting');
    attemptReconnect();
  }
}

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down...');
  stopLivePolling();
  timedMessages.stop();
  blazeWS.disconnect();
  webServer.stop();
  await disconnectCustomsForge();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
