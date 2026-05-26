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

    const [titleResult, artistResult] = await Promise.all([
      this.searchTitles(titleQuery),
      artistQuery ? this.searchArtists(artistQuery) : Promise.resolve({ results: [], authExpired: false }),
    ]);

    const authExpired = titleResult.authExpired || artistResult.authExpired;

    const combined = [];
    const seen = new Set();

    if (hasHyphen && artistResult.results.length > 0 && titleResult.results.length > 0) {
      const artistNames = artistResult.results.map((a) => a.text.trim().toLowerCase());
      for (const title of titleResult.results) {
        const titleText = title.text?.trim() || String(title.id).trim();
        const key = titleText.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          const matchedArtist = artistResult.results.find((a) => artistNames.includes(a.text.trim().toLowerCase()));
          combined.push({
            artist: matchedArtist ? matchedArtist.text.trim() : artistQuery,
            title: titleText,
          });
        }
      }
    } else {
      for (const title of titleResult.results) {
        const titleText = title.text?.trim() || String(title.id).trim();
        const key = titleText.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          combined.push({ artist: '', title: titleText });
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
