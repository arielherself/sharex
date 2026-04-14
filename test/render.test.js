const assert = require("node:assert/strict");
const test = require("node:test");

const appHandler = require("../src/server");
const {
  normalizeTweet,
  renderTweet,
  renderMeta,
  selectVideoSource,
  sanitizeExternalUrl,
} = appHandler;

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

function renderRequest(url) {
  return new Promise((resolve, reject) => {
    const req = {
      method: "GET",
      url,
      headers: { host: "sharex.test" },
    };
    const res = {
      headersSent: false,
      statusCode: null,
      headers: null,
      body: "",
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
      },
      end(chunk = "") {
        this.body += chunk;
        resolve(this);
      },
      destroy(error) {
        reject(error);
      },
    };

    appHandler(req, res);
  });
}

test("html pages use a fingerprinted stylesheet URL", async () => {
  const res = await renderRequest("/");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /href="\/assets\/styles\.css\?v=[a-f0-9]{12}"/);
});

test("post pages load the photo overlay script", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 200, tweet: baseTweet() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const res = await renderRequest("/tester/status/2040000000000000000");
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /href="\/assets\/styles\.css\?v=[a-f0-9]{12}"/);
    assert.match(res.body, /src="\/assets\/app\.js\?v=[a-f0-9]{12}" defer/);
    assert.match(res.body, /<a class="site-title" href="\/">ShareX<\/a>/);
    assert.match(res.body, /class="[^"]*\bscreenshot-button\b[^"]*"[^>]*data-screenshot-target="\.thread, article\[data-iv-post\]"/);
    assert.match(res.body, /data-screenshot-filename="2040000000000000000\.png"/);
    assert.ok(res.body.indexOf("site-title") < res.body.indexOf("data-iv-post"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reply pages render fetched parent chain before the selected post", async () => {
  const originalFetch = globalThis.fetch;
  const tweets = {
    root: baseTweet({
      id: "2040000000000000001",
      text: "root post",
      author: {
        name: "Root Author",
        screen_name: "rooter",
        avatar_url: "https://pbs.twimg.com/profile_images/root.jpg",
      },
    }),
    parent: baseTweet({
      id: "2040000000000000002",
      text: "parent reply",
      author: {
        name: "Parent Author",
        screen_name: "parenter",
        avatar_url: "https://pbs.twimg.com/profile_images/parent.jpg",
      },
      replying_to: "rooter",
      replying_to_status: "2040000000000000001",
    }),
    target: baseTweet({
      id: "2040000000000000003",
      text: "selected reply",
      author: {
        name: "Target Author",
        screen_name: "targeter",
        avatar_url: "https://pbs.twimg.com/profile_images/target.jpg",
      },
      replying_to: "parenter",
      replying_to_status: "2040000000000000002",
    }),
  };

  globalThis.fetch = async (url) => {
    const statusId = new URL(url).pathname.split("/").at(-1);
    const tweet = Object.values(tweets).find((item) => item.id === statusId);
    return new Response(JSON.stringify({ code: 200, tweet }), {
      status: tweet ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const res = await renderRequest("/targeter/status/2040000000000000003");
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /class="thread"/);
    assert.ok(res.body.indexOf("root post") < res.body.indexOf("parent reply"));
    assert.ok(res.body.indexOf("parent reply") < res.body.lastIndexOf("selected reply"));
    assert.equal((res.body.match(/\sdata-iv-post(?:\s|>)/g) || []).length, 1);
    assert.ok(res.body.indexOf("data-iv-post") < res.body.lastIndexOf("selected reply"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
          type: "photo",
          url: "https://pbs.twimg.com/media/photo2.jpg",
          width: 80,
          height: 120,
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
  assert.match(html, /photo-grid-thumbnails/);
  assert.match(html, /class="photo-link" href="\/media\//);
  assert.doesNotMatch(html, /class="photo-link"[^>]*target="_blank"/);
  assert.doesNotMatch(html, /count-[1-4]/);
  assert.match(html, /post-video/);
  assert.match(html, /class="video-download" href="\/media\/[^"]+\/2040000000000000000\.mp4\?download=1" download="2040000000000000000\.mp4"/);
  assert.match(html, /Download video/);
  assert.match(html, /poll-card/);
  assert.match(html, /translation-card/);
  assert.match(html, /community-note/);
  assert.match(html, /external-media/);
  assert.match(html, /data-iv-post/);
  assert.match(html, /class="iv-body"/);
  assert.match(html, /original post/);
  assert.match(html, /https:\/\/fxtwitter\.com\/tester\/status\/2040000000000000000/);
  assert.match(html, /replies/);
  assert.match(html, /reposts/);
  assert.match(html, /likes/);
  assert.match(html, /views/);
  assert.match(html, /https:\/\/media\.example\.test\/video\.mp4/);
  assert.doesNotMatch(html, /pbs\.twimg\.com|video\.twimg\.com/);
  assert.doesNotMatch(html, /https:\/\/(?:[^/]+\.)?x\.com|https:\/\/(?:[^/]+\.)?twitter\.com/);
});

test("webpage videos use the best variant while metadata keeps the small preview", () => {
  const tweet = baseTweet({
    media: {
      videos: [
        {
          type: "video",
          url: "https://video.twimg.com/fallback.mp4",
          thumbnail_url: "https://pbs.twimg.com/tweet_video_thumb/thumb.jpg",
          width: 1280,
          height: 720,
          format: "video/mp4",
          variants: [
            {
              url: "https://video.twimg.com/low.mp4",
              content_type: "video/mp4",
              bitrate: 832000,
            },
            {
              url: "https://video.twimg.com/high.mp4",
              content_type: "video/mp4",
              bitrate: 2176000,
            },
          ],
        },
      ],
    },
  });

  const html = renderTweet(normalizeTweet(tweet, ORIGIN));
  const meta = renderMeta(tweet, ORIGIN, "/tester/status/2040000000000000000");

  assert.match(html, /video-download/);
  assert.match(html, /\/media\//);
  assert.doesNotMatch(html, /video\.twimg\.com/);
  assert.doesNotMatch(meta, /video\.twimg\.com/);
  assert.equal(selectVideoSource(tweet.media.videos[0], { quality: "best" }).url, "https://video.twimg.com/high.mp4");
  assert.equal(selectVideoSource(tweet.media.videos[0]).url, "https://video.twimg.com/low.mp4");
});

test("does not expose blocked external media URLs", () => {
  assert.equal(sanitizeExternalUrl("https://pbs.twimg.com/media/photo.jpg"), "");
  assert.equal(
    sanitizeExternalUrl("https://video.example.test/movie.mp4"),
    "https://video.example.test/movie.mp4"
  );
});

test("keeps explicit non-media links in post text", () => {
  const tweet = baseTweet({
    text: "read https://example.com/post and https://t.co/abc123",
  });

  const html = renderTweet(normalizeTweet(tweet, ORIGIN));
  assert.match(html, /https:\/\/example\.com\/post/);
  assert.match(html, /https:\/\/t\.co\/abc123/);
  assert.doesNotMatch(html, /\[link\]/);
});

test("photo grids stay three-column without placeholder classes", () => {
  const photo = (index) => ({
    type: "photo",
    url: `https://pbs.twimg.com/media/photo${index}.jpg`,
    width: 100,
    height: 100,
  });

  assert.match(
    renderTweet(normalizeTweet(baseTweet({ media: { photos: [photo(1), photo(2)] } }), ORIGIN)),
    /photo-grid photo-grid-thumbnails/
  );
  assert.doesNotMatch(
    renderTweet(
      normalizeTweet(
        baseTweet({ media: { photos: [photo(1), photo(2), photo(3), photo(4)] } }),
        ORIGIN
      )
    ),
    /photo-remainder-/
  );
});

test("photo grid css preserves full image aspect ratios", () => {
  const styles = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../public/styles.css"),
    "utf8"
  );
  const script = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../public/app.js"),
    "utf8"
  );

  assert.match(styles, /\.photo-tile img \{[^}]*height: auto;/s);
  assert.match(styles, /color-scheme: light dark;/);
  assert.match(styles, /@media \(prefers-color-scheme: dark\)/);
  assert.match(styles, /--bg: #000000;/);
  assert.match(styles, /--panel: #000000;/);
  assert.match(styles, /\.photo-grid \{[^}]*background: transparent;/s);
  assert.match(styles, /\.photo-grid-thumbnails \{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /\.photo-grid-thumbnails \.photo-tile \{[^}]*aspect-ratio: 1 \/ 1;/s);
  assert.doesNotMatch(styles, /photo-remainder-/);
  assert.match(styles, /\.photo-link \{[^}]*height: 100%;/s);
  assert.match(styles, /\.photo-grid-thumbnails \.photo-tile img \{[^}]*object-fit: contain;/s);
  assert.match(styles, /\.photo-overlay \{/);
  assert.match(styles, /\.photo-overlay \{[^}]*overflow: hidden;/s);
  assert.match(styles, /\.photo-overlay \{[^}]*padding: 72px 20px 24px;/s);
  assert.match(styles, /\.photo-overlay-image \{[^}]*max-width: calc\(100vw - 40px\);/s);
  assert.match(styles, /\.photo-overlay-image \{[^}]*max-height: calc\(100vh - 96px\);/s);
  assert.match(styles, /\.photo-overlay-image \{[^}]*width: auto;/s);
  assert.match(styles, /\.photo-overlay-image \{[^}]*height: auto;/s);
  assert.match(styles, /\.photo-overlay-image \{[^}]*object-fit: contain;/s);
  assert.match(styles, /\.photo-overlay\.screenshot-overlay \.photo-overlay-image \{[^}]*border-radius: 0;/s);
  assert.match(styles, /\[data-screenshot-render\]\.post-card \{[^}]*border-radius: 0;/s);
  assert.match(script, /closest\("a\.photo-link"\)/);
  assert.match(script, /closest\("\.screenshot-button"\)/);
  assert.match(script, /renderElementImage/);
  assert.match(script, /await prepareScreenshotClone\(clone\)/);
  assert.match(script, /clone\.setAttribute\("data-screenshot-render", "true"\)/);
  assert.match(script, /blobToDataUrl/);
  assert.match(script, /decodeCloneImages/);
  assert.match(script, /image\.decode\(\)/);
  assert.match(script, /image\.complete/);
  assert.match(script, /image\.loading = "eager"/);
  assert.match(script, /image\.decoding = "sync"/);
  assert.match(script, /preloadImage\(image\.src/);
  assert.match(script, /waitForFrames\(2\)/);
  assert.match(script, /Promise\.race\(\[/);
  assert.match(script, /IMAGE_DECODE_TIMEOUT_MS/);
  assert.match(script, /fetchWithTimeout/);
  assert.match(script, /style="width:100%;height:100%;background:var\(--panel\);"/);
  assert.match(script, /canvas\.toDataURL\("image\/png"\)/);
  assert.match(script, /new File\(\[blob\], filename/);
  assert.match(script, /navigator\.share\(\{/);
  assert.match(script, /files: \[currentScreenshotFile\]/);
  assert.match(script, /navigator\.canShare\(\{ files: \[file\] \}\)/);
  assert.match(styles, /\.screenshot-button \{/);
  assert.match(styles, /\.screenshot-share \{/);
  assert.doesNotMatch(styles, /screenshot-download/);
  assert.doesNotMatch(script, /screenshotDownload/);
  assert.match(script, /className = "photo-overlay"/);
  assert.match(script, /classList\.add\("screenshot-overlay"\)/);
  assert.match(script, /classList\.remove\("screenshot-overlay"\)/);
  assert.match(styles, /\.video-download \{/);
  assert.doesNotMatch(styles, /\.photo-tile img \{[^}]*object-fit: cover;/s);
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
  assert.match(html, /<hr class="quote-separator">/);
  assert.match(html, /class="quote-author"/);
  assert.match(html, /Quoted Author/);
  assert.match(html, /@quoted/);
});
