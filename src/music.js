const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'music.youtube.com',
  'm.youtube.com',
  'youtu.be'
]);

function getYoutubeVideoUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Use a YouTube video URL or search by song name.');
  }

  const isShortUrl = url.hostname.toLowerCase() === 'youtu.be' &&
    url.pathname.split('/').filter(Boolean).length > 0;
  const isVideoUrl = url.searchParams.has('v') ||
    /^\/(?:shorts|embed|live)\/[^/]+/.test(url.pathname);
  if (!isShortUrl && !isVideoUrl) {
    throw new Error('The URL must point to a YouTube video, not a playlist or channel.');
  }

  return url.href;
}

async function resolveYoutubeVideo(query, playback = require('play-dl')) {
  const input = String(query ?? '').trim();
  if (!input) throw new Error('Enter a song name or YouTube video URL.');

  const url = getYoutubeVideoUrl(input);
  if (url) return { url, title: null };
  if (/^(?:https?:\/\/|www\.)/i.test(input)) {
    throw new Error('Use a YouTube video URL or search by song name.');
  }

  const results = await playback.search(input, {
    limit: 1,
    source: { youtube: 'video' }
  });
  const video = results[0];
  if (!video?.url) throw new Error(`No YouTube results were found for "${input}".`);
  return { url: video.url, title: video.title || input };
}

module.exports = { getYoutubeVideoUrl, resolveYoutubeVideo };
