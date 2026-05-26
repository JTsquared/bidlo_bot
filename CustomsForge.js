class CustomsForge {
  constructor(playwrightAuth) {
    this.auth = playwrightAuth;
  }

  async searchArtists(query) {
    try {
      const response = await this.auth.apiGet(`/cdlc/search/artists?q=${encodeURIComponent(query)}`);

      if (!response.ok) {
        console.error(`CustomsForge artist search failed (${response.status})`);
        return { results: [], authExpired: response.status === 401 || response.status === 403 };
      }

      const data = JSON.parse(response.body);
      return { results: data.results || [], authExpired: false };
    } catch (error) {
      console.error('CustomsForge artist search error:', error.message);
      return { results: [], authExpired: false };
    }
  }

  async searchTitles(query) {
    try {
      const response = await this.auth.apiGet(`/cdlc/search/titles?q=${encodeURIComponent(query)}`);

      if (!response.ok) {
        console.error(`CustomsForge title search failed (${response.status})`);
        return { results: [], authExpired: response.status === 401 || response.status === 403 };
      }

      const data = JSON.parse(response.body);
      return { results: data.results || [], authExpired: false };
    } catch (error) {
      console.error('CustomsForge title search error:', error.message);
      return { results: [], authExpired: false };
    }
  }

  async getArtistSongs(artistId, artistName) {
    try {
      const songs = await this.auth.getArtistSongs(artistId);
      return songs.map((s) => ({ artist: artistName, title: s.title }));
    } catch (error) {
      console.error('CustomsForge artist songs error:', error.message);
      return [];
    }
  }

  async search(query) {
    const hasHyphen = query.includes(' - ');
    let artistQuery = null;
    let titleQuery = query;

    if (hasHyphen) {
      const parts = query.split(' - ');
      artistQuery = parts[0].trim();
      titleQuery = parts.slice(1).join(' - ').trim();
    }

    // Always search both artists and titles
    const [titleResult, artistResult] = await Promise.all([
      this.searchTitles(titleQuery),
      this.searchArtists(artistQuery || query),
    ]);

    const authExpired = titleResult.authExpired || artistResult.authExpired;

    // If we have title results, combine with artist info
    if (titleResult.results.length > 0) {
      const combined = [];
      const seen = new Set();
      const matchedArtist = artistResult.results.length > 0
        ? artistResult.results[0].text?.trim()
        : (artistQuery || '');

      for (const title of titleResult.results) {
        const titleText = title.text?.trim() || String(title.id).trim();
        const key = titleText.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          combined.push({ artist: matchedArtist, title: titleText });
        }
      }
      return { results: combined, authExpired };
    }

    // No title results — if we matched an artist, fetch their full song list
    if (artistResult.results.length > 0) {
      // Find the best matching artist (exact match preferred)
      const queryLower = (artistQuery || query).toLowerCase();
      const exactMatch = artistResult.results.find(
        (a) => a.text?.trim().toLowerCase() === queryLower
      );
      const artist = exactMatch || artistResult.results[0];
      const artistName = artist.text?.trim();
      const artistId = artist.id;

      if (artistId) {
        console.log(`Fetching songs for artist: ${artistName} (ID: ${artistId})`);
        const songs = await this.getArtistSongs(artistId, artistName);
        if (songs.length > 0) {
          return { results: songs, authExpired: false };
        }
      }
    }

    return { results: [], authExpired };
  }

  async isAuthenticated() {
    const result = await this.searchArtists('test');
    return !result.authExpired;
  }
}

module.exports = CustomsForge;
