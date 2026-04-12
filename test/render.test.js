const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeTweet,
  renderTweet,
  renderMeta,
  sanitizeExternalUrl,
} = require("../src/server");

const ORIGIN = "https://sharex.test";

function baseTweet(overrides = {}) {
  return {
    id: "2040000000000000000",
    text: "hello world",
    author: {
      name: "Tester",
      screen_name: "tester",
      avatar_url: "https://pbs.twimg.com/profile_images/avatar.jpg",
    },
    created_at: "Wed Apr 08 11:17:46 +0000 2026",
    created_timestamp: 1775647066,
    replies: 1,
    retweets: 2,
    likes: 3,
    views: 4,
    ...overrides,
  };
}

test("renders poll, translation, community note, external media, and ordered media", () => {
  const tweet = baseTweet({
    media: {
      all: [
        {
          type: "photo",
          url: "https://pbs.twimg.com/media/photo.jpg",
          width: 100,
          height: 80,
        },
        {
          type: "gif",
          url: "https://video.twimg.com/tweet_video/video.mp4",
          thumbnail_url: "https://pbs.twimg.com/tweet_video_thumb/thumb.jpg",
          width: 320,
          height: 240,
          format: "video/mp4",
        },
      ],
      external: {
        type: "video",
        url: "https://media.example.test/video.mp4",
        width: 640,
        height: 360,
        duration: 125,
      },
    },
    poll: {
      choices: [
        { label: "A", count: 6, percentage: 60 },
        { label: "B", count: 4, percentage: 40 },
      ],
      total_votes: 10,
      time_left_en: "2 hours left",
    },
    translation: {
      text: "translated text",
      source_lang: "ja",
      target_lang: "en",
    },
    community_note: "context for readers",
  });

  const normalized = normalizeTweet(tweet, ORIGIN);
  const html = renderTweet(normalized);

  assert.match(html, /photo-grid/);
  assert.match(html, /post-video/);
  assert.match(html, /poll-card/);
  assert.match(html, /translation-card/);
  assert.match(html, /community-note/);
  assert.match(html, /external-media/);
  assert.match(html, /data-iv-post/);
  assert.match(html, /class="iv-body"/);
  assert.match(html, /replies/);
  assert.match(html, /reposts/);
  assert.match(html, /likes/);
  assert.match(html, /views/);
  assert.match(html, /https:\/\/media\.example\.test\/video\.mp4/);
  assert.doesNotMatch(html, /pbs\.twimg\.com|video\.twimg\.com|twitter\.com|x\.com/);
});

test("does not expose blocked external media URLs", () => {
  assert.equal(sanitizeExternalUrl("https://x.com/example/status/1"), "");
  assert.equal(sanitizeExternalUrl("https://pbs.twimg.com/media/photo.jpg"), "");
  assert.equal(
    sanitizeExternalUrl("https://video.example.test/movie.mp4"),
    "https://video.example.test/movie.mp4"
  );
});

test("article metadata prefers article title, preview, and cover", () => {
  const tweet = baseTweet({
    text: "",
    article: {
      title: "Article title",
      preview_text: "Article preview",
      cover_media: {
        media_info: {
          original_img_url: "https://pbs.twimg.com/media/cover.jpg",
          original_img_width: 1200,
          original_img_height: 630,
        },
      },
      content: { blocks: [], entityMap: [] },
      media_entities: [],
    },
  });

  const meta = renderMeta(tweet, ORIGIN, "/tester/status/2040000000000000000");
  assert.match(meta, /Article title/);
  assert.match(meta, /Article preview/);
  assert.match(meta, /https:\/\/sharex\.test\/media\//);
  assert.doesNotMatch(meta, /pbs\.twimg\.com/);
});

test("quoted posts expose author attribution for Instant View", () => {
  const tweet = baseTweet({
    quote: baseTweet({
      text: "quoted body",
      author: {
        name: "Quoted Author",
        screen_name: "quoted",
        avatar_url: "https://pbs.twimg.com/profile_images/quoted.jpg",
      },
    }),
  });

  const html = renderTweet(normalizeTweet(tweet, ORIGIN));
  assert.match(html, /class="quote-author"/);
  assert.match(html, /Quoted Author/);
  assert.match(html, /@quoted/);
});
