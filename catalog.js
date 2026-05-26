require('dotenv').config();

const SongDatabase = require('./Database.js');
const CustomsForge = require('./CustomsForge.js');
const PlaywrightAuth = require('./PlaywrightAuth.js');

const db = new SongDatabase();

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DELAY_MS = 500;

async function catalogArtists(cf) {
  console.log('Cataloging artists A-Z...');
  let totalArtists = 0;

  for (const letter of ALPHABET) {
    const result = await cf.searchArtists(letter);

    if (result.authExpired) {
      console.error('Auth expired! Could not recover.');
      break;
    }

    if (result.results.length > 0) {
      db.cacheArtists(result.results);
      totalArtists += result.results.length;
      console.log(`  "${letter}": ${result.results.length} artists (${totalArtists} total)`);
    } else {
      console.log(`  "${letter}": 0 artists`);
    }

    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  return totalArtists;
}

async function catalogTitles(cf) {
  console.log('Cataloging titles A-Z...');
  let totalTitles = 0;

  for (const letter of ALPHABET) {
    const result = await cf.searchTitles(letter);

    if (result.authExpired) {
      console.error('Auth expired! Could not recover.');
      break;
    }

    if (result.results.length > 0) {
      const titleItems = result.results.map((r) => ({
        id: r.text?.trim() || String(r.id).trim(),
        text: r.text?.trim() || String(r.id).trim(),
      }));
      db.cacheTitles(titleItems);
      totalTitles += titleItems.length;
      console.log(`  "${letter}": ${titleItems.length} titles (${totalTitles} total)`);
    } else {
      console.log(`  "${letter}": 0 titles`);
    }

    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  return totalTitles;
}

async function main() {
  console.log('CustomsForge Catalog Builder');
  console.log('===========================');

  const auth = await PlaywrightAuth.create();
  if (!auth || !auth.isLoggedIn) {
    console.error('Could not authenticate with CustomsForge.');
    db.close();
    process.exit(1);
  }

  const cf = new CustomsForge(auth);

  console.log('Authenticated with CustomsForge\n');

  const beforeStats = db.getStats();
  console.log(`Before: ${beforeStats.artists} artists, ${beforeStats.titles} titles\n`);

  await catalogArtists(cf);
  console.log('');
  await catalogTitles(cf);

  const afterStats = db.getStats();
  console.log(`\nDone! ${afterStats.artists} artists, ${afterStats.titles} titles in database`);
  console.log(`Added: ${afterStats.artists - beforeStats.artists} artists, ${afterStats.titles - beforeStats.titles} titles`);

  await auth.close();
  db.close();
}

main();
