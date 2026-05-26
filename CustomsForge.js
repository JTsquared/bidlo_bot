const CUSTOMSFORGE_BASE = 'https://ignition4.customsforge.com';

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

    const combined = [];
    const seen = new Set();

    if (titleResult.results.length > 0 && artistResult.results.length > 0) {
      // Have both — pair artist names with title results
      const matchedArtist = artistResult.results[0]?.text?.trim() || artistQuery || query;
      for (const title of titleResult.results) {
        const titleText = title.text?.trim() || String(title.id).trim();
        const key = titleText.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          combined.push({ artist: matchedArtist, title: titleText });
        }
      }
    } else if (titleResult.results.length > 0) {
      // Only title matches
      for (const title of titleResult.results) {
        const titleText = title.text?.trim() || String(title.id).trim();
        const key = titleText.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          combined.push({ artist: '', title: titleText });
        }
      }
    } else if (artistResult.results.length > 0 && !hasHyphen) {
      // Only artist matches and no specific title — return artist names so user can refine
      for (const artist of artistResult.results) {
        const artistText = artist.text?.trim() || String(artist.id).trim();
        const key = artistText.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          combined.push({ artist: artistText, title: '(use !request artist - song title)' });
        }
      }
    }

    return { results: combined, authExpired };
  }

  async isAuthenticated() {
    const result = await this.searchArtists('test');
    return !result.authExpired;
  }
}

module.exports = CustomsForge;
