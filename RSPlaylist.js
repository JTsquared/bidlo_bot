const SEARCH_URL = 'http://rsplaylist.com/api/search.php';
const OWNED_URL = 'http://rsplaylist.com/ajax/owneddlc.php';

class RSPlaylist {
  constructor(channel) {
    this.channel = channel;
    this.ownedSongs = null; // Lazy-loaded set of "artist|title" keys
  }

  async search(query) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`${SEARCH_URL}?search=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`RSPlaylist search failed (${response.status})`);
        return { results: [] };
      }

      const data = await response.json();

      if (data.result === 'Error' || !Array.isArray(data)) {
        return { results: [] };
      }

      return { results: data };
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('RSPlaylist search timed out');
      } else {
        console.error('RSPlaylist search error:', error.message);
      }
      return { results: [] };
    }
  }

  async loadOwnedSongs() {
    if (!this.channel) return;
    if (this.ownedSongs) return;

    console.log(`Loading owned DLC for channel: ${this.channel}...`);
    this.ownedSongs = new Map();

    try {
      let page = 1;
      const pageSize = 500;
      let total = Infinity;

      while ((page - 1) * pageSize < total) {
        const response = await fetch(`${OWNED_URL}?pageIndex=${page}&pageSize=${pageSize}&channel=${encodeURIComponent(this.channel)}`);
        if (!response.ok) break;

        const data = await response.json();
        total = data.itemsCount || 0;

        for (const item of (data.data || [])) {
          const key = `${(item.artist_name || '').toLowerCase()}|${(item.title || '').toLowerCase()}`;
          this.ownedSongs.set(key, item.id);
        }

        page++;
      }

      console.log(`Loaded ${this.ownedSongs.size} owned songs`);
    } catch (error) {
      console.error('Failed to load owned DLC:', error.message);
      this.ownedSongs = new Map();
    }
  }

  isOwned(artist, title) {
    if (!this.ownedSongs) return false;
    const key = `${(artist || '').toLowerCase()}|${(title || '').toLowerCase()}`;
    return this.ownedSongs.has(key);
  }

  async refreshOwned() {
    this.ownedSongs = null;
    await this.loadOwnedSongs();
  }
}

module.exports = RSPlaylist;
