const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://customsforge.com/login/';
const IGNITION_URL = 'https://ignition4.customsforge.com';
const STATE_FILE = path.join(__dirname, 'browser_state.json');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class PlaywrightAuth {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  async launch() {
    console.log('Launching browser for CustomsForge...');
    // Use 'new' headless mode which is indistinguishable from headed
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    // Try to restore saved session state
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.context = await this.browser.newContext({ storageState: state, userAgent: USER_AGENT });
        this.page = await this.context.newPage();
        console.log('  Restored saved browser session');

        // Navigate to ignition4 to check if session is still valid
        await this.page.goto(IGNITION_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.page.waitForTimeout(3000);

        const testResult = await this.apiCall('/cdlc/search/artists?q=test');
        if (testResult.ok) {
          console.log('  Saved session is valid');
          this.isLoggedIn = true;
          return true;
        }
        console.log('  Saved session expired, logging in fresh...');
        await this.page.close();
        await this.context.close();
      } catch (error) {
        console.log('  Could not restore session:', error.message);
      }
    }

    this.context = await this.browser.newContext({ userAgent: USER_AGENT });
    this.page = await this.context.newPage();
    await this.login();
    return this.isLoggedIn;
  }

  async login() {
    // Step 1: Login at customsforge.com/login/ first
    console.log('  Logging in at customsforge.com...');
    await this.page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

    await this.page.fill('input[name="auth"]', this.email);
    await this.page.fill('input[name="password"]', this.password);

    const rememberCheckbox = this.page.locator('input[name="remember_me"]');
    if (await rememberCheckbox.count() > 0) {
      await rememberCheckbox.first().check();
    }

    await this.page.click('button[type="submit"], .ipsButton_primary');
    await this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});

    const currentUrl = this.page.url();
    if (currentUrl.includes('/login')) {
      const errorText = await this.page.evaluate(() => {
        const err = document.querySelector('.ipsMessage_error, .ipsType_warning');
        return err ? err.textContent.trim() : null;
      });
      throw new Error(`Login failed. ${errorText || 'Check your email/password.'}`);
    }
    console.log('  Logged in to CustomsForge');

    // Step 2: Navigate to ignition4/login to trigger OAuth redirect chain
    console.log('  Completing Ignition4 OAuth...');
    await this.page.goto(`${IGNITION_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for OAuth redirects to complete — the chain is:
    // ignition4/login → customsforge.com/oauth/authorize → ignition4/auth/callback → ignition4/
    // We need to wait until we're back on ignition4 with content loaded
    for (let i = 0; i < 15; i++) {
      await this.page.waitForTimeout(1000);
      const url = this.page.url();
      if (url.startsWith(IGNITION_URL) && !url.includes('/login') && !url.includes('/auth/')) {
        break;
      }
      if (i === 14) {
        console.log(`  Warning: still on ${url} after 15s`);
      }
    }

    const finalUrl = this.page.url();
    console.log(`  Landed on: ${finalUrl}`);
    if (!finalUrl.startsWith(IGNITION_URL)) {
      throw new Error(`OAuth flow failed, ended up at: ${finalUrl}`);
    }

    // Extra wait for page scripts to initialize
    await this.page.waitForTimeout(2000);

    // Verify API works
    const testResult = await this.apiCall('/cdlc/search/artists?q=test');
    if (!testResult.ok) {
      console.log(`  API test failed (${testResult.status}): ${testResult.body.substring(0, 100)}`);
      throw new Error(`API returned ${testResult.status} after login`);
    }

    this.isLoggedIn = true;
    console.log('  CustomsForge API access confirmed');

    await this.saveState();
  }

  async apiCall(urlPath) {
    return this.page.evaluate(async (path) => {
      try {
        const xsrfMatch = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
        const xsrfToken = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : null;
        const headers = { 'Accept': 'application/json' };
        if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;

        const res = await fetch(path, {
          credentials: 'same-origin',
          headers,
        });
        const text = await res.text();
        return { status: res.status, ok: res.ok, body: text };
      } catch (err) {
        return { status: 0, ok: false, body: err.message };
      }
    }, urlPath);
  }

  async saveState() {
    try {
      const state = await this.context.storageState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (error) {
      console.error('  Could not save session state:', error.message);
    }
  }

  async apiGet(urlPath) {
    if (!this.isLoggedIn) {
      throw new Error('Not logged in');
    }

    const response = await this.apiCall(urlPath);

    if (response.status === 401 || response.status === 403) {
      console.log(`  Session expired (${response.status}), re-authenticating...`);
      this.isLoggedIn = false;
      await this.page.close();
      await this.context.close();
      this.context = await this.browser.newContext({ userAgent: USER_AGENT });
      this.page = await this.context.newPage();
      await this.login();
      return this.apiCall(urlPath);
    }

    return response;
  }

  async close() {
    if (this.context) await this.saveState();
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isLoggedIn = false;
  }

  static async create() {
    const email = process.env.CUSTOMSFORGE_EMAIL;
    const password = process.env.CUSTOMSFORGE_PASSWORD;

    if (!email || !password) {
      console.error('CUSTOMSFORGE_EMAIL and CUSTOMSFORGE_PASSWORD must be set in .env');
      return null;
    }

    const auth = new PlaywrightAuth(email, password);
    await auth.launch();
    return auth;
  }
}

module.exports = PlaywrightAuth;
