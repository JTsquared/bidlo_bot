const { test } = require('node:test');
const assert = require('node:assert/strict');
const SQLite = require('better-sqlite3');
const Database = require('../Database');
const CommandHandler = require('../CommandHandler');
const WebServer = require('../WebServer');
const { Readable } = require('node:stream');

function database(t) {
  const db = Object.create(Database.prototype);
  db.db = new SQLite(':memory:');
  db.init();
  t.after(() => db.close());
  return db;
}

test('requests default open and retain the saved setting after initialization', (t) => {
  const db = database(t);
  assert.equal(db.areSongRequestsEnabled(), true);
  db.setSongRequestsEnabled(false);
  db.init();
  assert.equal(db.areSongRequestsEnabled(), false);
  db.setSongRequestsEnabled(true);
  assert.equal(db.areSongRequestsEnabled(), true);
});

test('closed requests reject both aliases and pending picks on every platform', async (t) => {
  const db = database(t);
  db.setSongRequestsEnabled(false);
  const replies = [];
  const handler = new CommandHandler(db, { search() { assert.fail('Search should not run'); } },
    (channel, message) => replies.push({ channel, message }));
  handler.isStreamLive = true;
  for (const channel of ['twitch', 'arena', 'blaze']) {
    for (const command of ['!request song', '!sr song', '!pick 1']) {
      await handler.handle(channel + command, 'id', command, channel);
    }
  }
  assert.equal(replies.length, 9);
  for (const reply of replies) assert.match(reply.message, /New song requests are no longer being accepted at this time\. You can request a song the next time I'm live!/);
  assert.deepEqual(db.getQueue(), []);
});

test('closing during a search blocks enqueueing; reopening accepts requests', async (t) => {
  const db = database(t);
  const song = { artist: 'Artist', title: 'Song' };
  const handler = new CommandHandler(db, { async search() {
    db.setSongRequestsEnabled(false);
    return { results: [song] };
  } }, () => {});
  handler.isStreamLive = true;
  await handler.handleRequest('viewer', 'id', 'song', 'twitch');
  assert.equal(db.getQueue().length, 0);
  db.setSongRequestsEnabled(true);
  handler.rs.search = async () => ({ results: [song] });
  await handler.handleRequest('viewer', 'id', 'song', 'twitch');
  assert.equal(db.getQueue().length, 1);
});

test('admin API validates updates and requires authentication', async (t) => {
  const db = database(t);
  const server = new WebServer(db);
  async function call(method, body, authenticated = true) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = '/api/song-requests';
    req.headers = {};
    server.isAuthenticated = () => authenticated;
    let status, result;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(value) { result = value; } };
    await server.handleRequest(req, res);
    return { status, data: result ? JSON.parse(result) : null };
  }
  assert.equal((await call('PUT', { enabled: false }, false)).status, 302);
  assert.equal(db.areSongRequestsEnabled(), true);
  assert.equal((await call('PUT', { enabled: 'false' })).status, 400);
  assert.deepEqual((await call('PUT', { enabled: false })).data, { enabled: false });
  assert.deepEqual((await call('GET')).data, { enabled: false });
  assert.deepEqual((await call('PUT', { enabled: true })).data, { enabled: true });
  const script = server.getDashboardHTML().match(/<script>([\s\S]*?)<\/script>/)[1];
  new (require('node:vm').Script)(script);
});
