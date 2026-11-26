const test = require('node:test');
const assert = require('node:assert/strict');
const { getYoutubeVideoUrl, resolveYoutubeVideo } = require('../src/music');

test('YouTube video URLs are accepted but playlists and other hosts are rejected', () => {
  assert.equal(getYoutubeVideoUrl('https://youtu.be/abc123'), 'https://youtu.be/abc123');
  assert.equal(getYoutubeVideoUrl('https://www.youtube.com/watch?v=abc123'), 'https://www.youtube.com/watch?v=abc123');
  assert.throws(() => getYoutubeVideoUrl('https://youtube.com/playlist?list=abc'), /video, not a playlist/);
  assert.throws(() => getYoutubeVideoUrl('https://example.com/watch?v=abc123'), /YouTube video URL/);
});

test('song searches resolve the first YouTube video and report empty results', async () => {
  const calls = [];
  const playback = {
    search: async (...args) => {
      calls.push(args);
      return [{ url: 'https://www.youtube.com/watch?v=abc123', title: 'Example song' }];
    }
  };

  assert.deepEqual(await resolveYoutubeVideo('Example song', playback), {
    url: 'https://www.youtube.com/watch?v=abc123',
    title: 'Example song'
  });
  assert.deepEqual(calls, [[
    'Example song',
    { limit: 1, source: { youtube: 'video' } }
  ]]);
  await assert.rejects(
    resolveYoutubeVideo('no match', { search: async () => [] }),
    /No YouTube results/
  );
});

test('malformed, unsupported, or empty inputs do not fall through to search', async () => {
  let searched = false;
  const playback = { search: async () => { searched = true; return []; } };

  await assert.rejects(resolveYoutubeVideo('', playback), /Enter a song name/);
  await assert.rejects(resolveYoutubeVideo('https://example.com/song', playback), /YouTube video URL/);
  await assert.rejects(resolveYoutubeVideo('https://youtube.com/playlist?list=abc', playback), /video, not a playlist/);
  assert.equal(searched, false);
});
