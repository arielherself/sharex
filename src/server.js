const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Readable } = require("stream");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "";
const SITE_NAME = process.env.SITE_NAME || "ShareX";
const APP_USER_AGENT =
  process.env.APP_USER_AGENT ||
  "ShareXPostPages/0.1 (+https://example.invalid; contact required)";
const MAX_THREAD_DEPTH = 12;
const TOKEN_SECRET =
  process.env.MEDIA_TOKEN_SECRET ||
  "development-only-secret-change-MEDIA_TOKEN_SECRET";
const TOKEN_KEY = crypto.createHash("sha256").update(TOKEN_SECRET).digest();

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const STYLESHEET_VERSION = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(PUBLIC_DIR, "styles.css")))
  .digest("hex")
  .slice(0, 12);
const SCRIPT_VERSION = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(PUBLIC_DIR, "app.js")))
  .digest("hex")
  .slice(0, 12);
const ASSET_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".png", "image/png"],
]);

const UPSTREAM_MEDIA_HOSTS = new Set([
  "pbs.twimg.com",
  "video.twimg.com",
  "abs.twimg.com",
  "ton.twimg.com",
]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64url(value) {
  return Buffer.from(value, "base64url");
}

function encryptUrl(upstreamUrl) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", TOKEN_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(upstreamUrl, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${base64url(iv)}.${base64url(tag)}.${base64url(encrypted)}`;
}

function decryptUrl(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpError(400, "Invalid media token");
  }

  try {
    const [iv, tag, encrypted] = parts.map(fromBase64url);
    const decipher = crypto.createDecipheriv("aes-256-gcm", TOKEN_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HttpError(400, "Invalid media token");
  }
}

function getRequestOrigin(req) {
  if (PUBLIC_ORIGIN) {
    return PUBLIC_ORIGIN.replace(/\/$/, "");
  }

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function mediaUrl(origin, upstreamUrl, absolute = false) {
  if (!upstreamUrl) {
    return "";
  }
  const pathValue = `/media/${encryptUrl(upstreamUrl)}`;
  return absolute ? `${origin}${pathValue}` : pathValue;
}

function validateMediaUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "Invalid upstream media URL");
  }

  if (parsed.protocol !== "https:" || !UPSTREAM_MEDIA_HOSTS.has(parsed.hostname)) {
    throw new HttpError(403, "Media host is not allowed");
  }

  return parsed.toString();
}

function shouldRedirectTelegramMedia(req, upstreamUrl) {
  if (process.env.TELEGRAM_IV_DIRECT_MEDIA !== "1") {
    return false;
  }

  const userAgent = req.headers["user-agent"] || "";
  if (!/TelegramBot|Telegram/i.test(userAgent)) {
    return false;
  }

  try {
    const parsed = new URL(upstreamUrl);
    return parsed.hostname === "video.twimg.com";
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function compactText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripXUrls(value) {
  return String(value || "").trim().replace(
    /https?:\/\/(?:pbs|video)\.twimg\.com\/[^\s]+/gi,
    "[link]"
  );
}

function renderText(value) {
  const text = stripXUrls(value);
  const urlPattern = /(https?:\/\/[^\s<]+)/gi;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = urlPattern.exec(text)) !== null) {
    const [url] = match;
    parts.push(escapeHtml(text.slice(lastIndex, match.index)));
    if (isBlockedFrontendUrl(url)) {
      parts.push('<span class="muted">[link]</span>');
    } else {
      parts.push(
        `<a href="${escapeAttr(url)}" rel="nofollow noopener noreferrer" target="_blank">${escapeHtml(url)}</a>`
      );
    }
    lastIndex = match.index + url.length;
  }

  parts.push(escapeHtml(text.slice(lastIndex)));
  return parts.join("").replace(/\n/g, "<br>");
}

function isBlockedFrontendUrl(value) {
  try {
    const parsed = new URL(value);
    return /(?:^|\.)twimg\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function formatCount(value) {
  if (typeof value !== "number") {
    return "0";
  }
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function formatDate(timestamp) {
  if (!timestamp) {
    return "";
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp * 1000));
}

async function fetchTweet(screenName, statusId) {
  const apiUrl = `https://api.fxtwitter.com/${encodeURIComponent(
    screenName
  )}/status/${encodeURIComponent(statusId)}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": APP_USER_AGENT,
    },
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, "FixTweet returned an unreadable response");
  }

  if (!response.ok || payload.code !== 200 || !payload.tweet) {
    const code = payload.code || response.status || 502;
    const message = payload.message || "Unable to fetch post";
    throw new HttpError(code === 404 ? 404 : code === 401 ? 403 : 502, message);
  }

  return payload.tweet;
}

async function fetchThread(screenName, statusId) {
  const tweet = await fetchTweet(screenName, statusId);
  const ancestors = [];
  const seen = new Set([String(tweet.id || statusId)]);
  let current = tweet;

  for (let depth = 0; depth < MAX_THREAD_DEPTH; depth += 1) {
    const embeddedParent = getEmbeddedReplyParent(current);
    const parentId = getReplyParentId(current);
    if (!parentId || seen.has(parentId)) {
      break;
    }
    seen.add(parentId);

    if (embeddedParent) {
      ancestors.unshift(embeddedParent);
      current = embeddedParent;
      continue;
    }

    try {
      const parent = await fetchTweet(
        getReplyParentScreenName(current) || "i",
        parentId
      );
      ancestors.unshift(parent);
      current = parent;
    } catch {
      break;
    }
  }

  return { tweet, ancestors };
}

function getEmbeddedReplyParent(tweet) {
  return tweet?.replying_to_status &&
    typeof tweet.replying_to_status === "object"
    ? tweet.replying_to_status
    : null;
}

function getReplyParentId(tweet) {
  const parent = tweet?.replying_to_status;
  if (!parent) {
    return "";
  }
  if (typeof parent === "string" || typeof parent === "number") {
    return String(parent);
  }
  return String(parent.id || parent.status_id || "");
}

function getReplyParentScreenName(tweet) {
  const replyTarget = tweet?.replying_to;
  if (!replyTarget) {
    return "";
  }
  if (typeof replyTarget === "string") {
    return replyTarget.replace(/^@/, "");
  }
  return String(
    replyTarget.screen_name || replyTarget.screenName || replyTarget.username || ""
  ).replace(/^@/, "");
}

function normalizeTweet(tweet, origin, absoluteMedia = false, depth = 0) {
  const media = tweet.media || {};
  const tweetId = String(tweet.id || "");
  const photos = (media.photos || []).map((photo) =>
    normalizePhoto(photo, origin, absoluteMedia)
  );
  const videos = (media.videos || []).map((video) =>
    normalizeVideo(video, origin, absoluteMedia, tweetId)
  );
  const external = media.external
    ? normalizeExternalMedia(media.external)
    : null;
  return {
    id: tweetId,
    text: stripXUrls(tweet.text || ""),
    author: {
      name: tweet.author?.name || "Unknown",
      screenName: tweet.author?.screen_name || "",
      avatar: mediaUrl(origin, tweet.author?.avatar_url || "", absoluteMedia),
    },
    originalUrl: buildOriginalPostUrl(tweet),
    createdAt: tweet.created_at || "",
    createdTimestamp: tweet.created_timestamp || null,
    counts: {
      replies: tweet.replies || 0,
      retweets: tweet.retweets || 0,
      likes: tweet.likes || 0,
      views: tweet.views || null,
    },
    translation: tweet.translation
      ? {
          text: stripXUrls(tweet.translation.text || ""),
          sourceLang: tweet.translation.source_lang || "",
          targetLang: tweet.translation.target_lang || "",
        }
      : null,
    communityNote: normalizeCommunityNote(tweet.community_note),
    media: {
      all: Array.isArray(media.all)
        ? media.all
            .map((item) => normalizeMediaItem(item, origin, absoluteMedia, tweetId))
            .filter(Boolean)
        : [],
      photos,
      videos,
      external,
      mosaic: media.mosaic
        ? {
            type: "mosaic_photo",
            src: mediaUrl(
              origin,
              media.mosaic.formats?.webp || media.mosaic.formats?.jpeg || "",
              absoluteMedia
            ),
            width: media.mosaic.width || null,
            height: media.mosaic.height || null,
          }
        : null,
    },
    poll: tweet.poll
      ? {
          choices: (tweet.poll.choices || []).map((choice) => ({
            label: choice.label || "",
            count: choice.count || 0,
            percentage: choice.percentage || 0,
          })),
          totalVotes: tweet.poll.total_votes || 0,
          endsAt: tweet.poll.ends_at || "",
          timeLeft: tweet.poll.time_left_en || "",
        }
      : null,
    article: tweet.article ? normalizeArticle(tweet.article, origin, absoluteMedia) : null,
    quote:
      tweet.quote && depth < 1
        ? normalizeTweet(tweet.quote, origin, absoluteMedia, depth + 1)
        : null,
  };
}

function buildOriginalPostUrl(tweet) {
  const screenName = tweet.author?.screen_name || tweet.author?.screenName || "";
  const id = tweet.id || "";
  if (!screenName || !id) {
    return "";
  }
  return `https://fxtwitter.com/${encodeURIComponent(screenName)}/status/${encodeURIComponent(id)}`;
}

function normalizeCommunityNote(note) {
  if (!note) {
    return null;
  }

  if (typeof note === "string") {
    return stripXUrls(note);
  }

  const text = note.text || note.summary || note.body || "";
  return text ? stripXUrls(text) : null;
}

function normalizeMediaItem(item, origin, absoluteMedia = false, tweetId = "") {
  if (item.type === "photo") {
    return normalizePhoto(item, origin, absoluteMedia);
  }

  if (item.type === "video" || item.type === "gif") {
    return normalizeVideo(item, origin, absoluteMedia, tweetId);
  }

  return null;
}

function normalizePhoto(photo, origin, absoluteMedia = false) {
  return {
    type: "photo",
    src: mediaUrl(origin, photo.url, absoluteMedia),
    width: photo.width || null,
    height: photo.height || null,
    alt: photo.altText || "Post photo",
  };
}

function normalizeVideo(video, origin, absoluteMedia = false, tweetId = "") {
  const source = selectVideoSource(video, { quality: "best" });
  return {
    type: video.type || "video",
    src: mediaUrl(origin, source.url, absoluteMedia),
    poster: mediaUrl(origin, video.thumbnail_url, absoluteMedia),
    width: video.width || null,
    height: video.height || null,
    format: source.format || video.format || "video/mp4",
    downloadFilename: videoDownloadFilename(source.format || video.format || "video/mp4", tweetId),
  };
}

function selectVideoSource(video, options = {}) {
  const quality = options.quality || "smallest";
  const variants = [...(video.variants || []), ...(video.formats || [])]
    .filter((variant) => {
      const contentType = variant.content_type || "";
      const container = variant.container || "";
      return (
        variant.url &&
        (contentType === "video/mp4" ||
          container === "mp4" ||
          /\.mp4(?:\?|$)/i.test(variant.url)) &&
        Number(variant.bitrate || 0) > 0
      );
    })
    .sort((a, b) =>
      quality === "best"
        ? Number(b.bitrate || 0) - Number(a.bitrate || 0)
        : Number(a.bitrate || 0) - Number(b.bitrate || 0)
    );

  const selected = variants[0];
  return {
    url: selected?.url || video.url,
    format: selected?.content_type || video.format || "video/mp4",
  };
}

function normalizeExternalMedia(external) {
  const safeUrl = sanitizeExternalUrl(external.url);
  if (!safeUrl) {
    return null;
  }

  return {
    type: external.type || "video",
    url: safeUrl,
    width: external.width || null,
    height: external.height || null,
    duration: external.duration || null,
    playable: isLikelyDirectVideoUrl(safeUrl),
  };
}

function sanitizeExternalUrl(value) {
  if (!value || isBlockedFrontendUrl(value)) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function isLikelyDirectVideoUrl(value) {
  try {
    const parsed = new URL(value);
    return /\.(mp4|webm|mov|m4v)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeArticle(article, origin, absoluteMedia = false) {
  const coverUrl = article.cover_media?.media_info?.original_img_url || "";
  const mediaEntities = (article.media_entities || []).map((entity) => ({
    mediaId: String(entity.media_id),
    src: mediaUrl(origin, entity.media_info?.original_img_url || "", absoluteMedia),
    width: entity.media_info?.original_img_width || null,
    height: entity.media_info?.original_img_height || null,
  }));
  const mediaById = new Map(
    mediaEntities.map((entity) => [entity.mediaId, entity])
  );
  const entityMap = normalizeEntityMap(article.content?.entityMap || []);

  return {
    id: String(article.id || ""),
    title: stripXUrls(article.title || ""),
    previewText: stripXUrls(article.preview_text || ""),
    cover: coverUrl
      ? {
          src: mediaUrl(origin, coverUrl, absoluteMedia),
          width: article.cover_media?.media_info?.original_img_width || null,
          height: article.cover_media?.media_info?.original_img_height || null,
        }
      : null,
    modifiedAt: article.modified_at || "",
    content: {
      blocks: article.content?.blocks || [],
      entityMap,
    },
    mediaEntities,
    mediaById,
    toJSON() {
      return {
        id: this.id,
        title: this.title,
        previewText: this.previewText,
        cover: this.cover,
        modifiedAt: this.modifiedAt,
        content: {
          blocks: this.content.blocks,
          entityMap: serializeArticleEntityMap(this.content.entityMap),
        },
        mediaEntities: this.mediaEntities,
      };
    },
  };
}

function serializeArticleEntityMap(entityMap) {
  return Object.fromEntries(
    [...entityMap.entries()].map(([key, entity]) => {
      if (entity?.type === "LINK") {
        return [
          key,
          {
            ...entity,
            data: {
              ...entity.data,
              url: sanitizeExternalUrl(entity.data?.url),
            },
          },
        ];
      }
      return [key, entity];
    })
  );
}

function normalizeEntityMap(entityMap) {
  if (Array.isArray(entityMap)) {
    return new Map(
      entityMap.map((entity, index) => [
        String(entity.key ?? index),
        entity.value || entity,
      ])
    );
  }

  return new Map(
    Object.entries(entityMap || {}).map(([key, entity]) => [
      String(key),
      entity.value || entity,
    ])
  );
}

function renderPhotoGrid(media) {
  if (!media.photos.length && !media.mosaic?.src) {
    return "";
  }

  const photos = media.photos.length
    ? media.photos
    : [
        {
          src: media.mosaic.src,
          width: media.mosaic.width,
          height: media.mosaic.height,
          alt: "Post photo",
        },
      ];

  const gridClass = photos.length > 1 ? " photo-grid-thumbnails" : "";

  return `
    <div class="photo-grid${gridClass}">
      ${photos
        .map(
          (photo) => `
        <figure class="photo-tile">
          <a class="photo-link" href="${escapeAttr(photo.src)}" rel="noopener noreferrer" aria-label="Open photo preview">
            <img
              src="${escapeAttr(photo.src)}"
              alt="${escapeAttr(photo.alt)}"
              loading="lazy"
              decoding="async"
              width="${escapeAttr(photo.width || "")}"
              height="${escapeAttr(photo.height || "")}"
            >
          </a>
        </figure>`
        )
        .join("")}
    </div>`;
}

function renderMedia(media) {
  if (media.all.length > 0) {
    const parts = [];
    let photoBatch = [];

    const flushPhotos = () => {
      if (photoBatch.length) {
        parts.push(renderPhotoGrid({ photos: photoBatch, mosaic: null }));
        photoBatch = [];
      }
    };

    for (const item of media.all) {
      if (item.type === "photo") {
        photoBatch.push(item);
        continue;
      }

      flushPhotos();
      if (item.type === "video" || item.type === "gif") {
        parts.push(renderVideos({ videos: [item] }));
      }
    }
    flushPhotos();

    if (media.external) {
      parts.push(renderExternalMedia(media.external));
    }

    return parts.join("");
  }

  return [
    renderPhotoGrid(media),
    renderVideos(media),
    renderExternalMedia(media.external),
  ].join("");
}

function renderVideos(media) {
  if (!media.videos.length) {
    return "";
  }

  return `
    <div class="video-stack">
      ${media.videos
        .map((video) => {
          const isGif = video.type === "gif";
          return `
        <video
          class="post-video"
          controls
          ${isGif ? "autoplay loop muted playsinline" : "playsinline"}
          poster="${escapeAttr(video.poster)}"
          ${video.width ? `width="${escapeAttr(video.width)}"` : ""}
          ${video.height ? `height="${escapeAttr(video.height)}"` : ""}
        >
          <source src="${escapeAttr(video.src)}" type="${escapeAttr(video.format)}">
          Your browser cannot play this video.
        </video>
        <a class="video-download" href="${escapeAttr(videoDownloadUrl(video.src, video.downloadFilename || videoDownloadFilename(video.format)))}" download="${escapeAttr(video.downloadFilename || videoDownloadFilename(video.format))}" rel="noopener noreferrer">Download video</a>`;
        })
        .join("")}
    </div>`;
}

function videoDownloadUrl(src, filenameOrFormat) {
  if (!src) {
    return "";
  }

  if (/^\/media\/[A-Za-z0-9_.-]+$/.test(src)) {
    const filename = filenameOrFormat?.includes(".")
      ? filenameOrFormat
      : videoDownloadFilename(filenameOrFormat);
    return `${src}/${filename}?download=1`;
  }

  return src;
}

function videoDownloadFilename(format, postId = "") {
  const extension = mediaExtension(format);
  const basename = String(postId || "").replace(/[^A-Za-z0-9_-]/g, "") || "video";
  return `${basename}.${extension}`;
}

function screenshotFilename(postId = "") {
  const basename = String(postId || "").replace(/[^A-Za-z0-9_-]/g, "") || "post";
  return `${basename}.png`;
}

function mediaExtension(format) {
  const normalized = String(format || "").toLowerCase();
  if (normalized.includes("webm")) {
    return "webm";
  }
  if (normalized.includes("quicktime") || normalized.includes("mov")) {
    return "mov";
  }
  return "mp4";
}

function renderExternalMedia(external) {
  if (!external) {
    return "";
  }

  if (external.playable) {
    return `
      <div class="external-media">
        <video
          class="post-video"
          controls
          playsinline
          ${external.width ? `width="${escapeAttr(external.width)}"` : ""}
          ${external.height ? `height="${escapeAttr(external.height)}"` : ""}
        >
          <source src="${escapeAttr(external.url)}">
          Your browser cannot play this video.
        </video>
      </div>`;
  }

  const duration = external.duration
    ? `<span>${escapeHtml(formatDuration(external.duration))}</span>`
    : "";

  return `
    <aside class="external-media">
      <p class="eyebrow">External ${escapeHtml(external.type)}</p>
      <a href="${escapeAttr(external.url)}" rel="nofollow noopener noreferrer" target="_blank">Open media</a>
      ${duration}
    </aside>`;
}

function renderTranslation(translation) {
  if (!translation?.text) {
    return "";
  }

  const label =
    translation.sourceLang && translation.targetLang
      ? `${translation.sourceLang.toUpperCase()} to ${translation.targetLang.toUpperCase()}`
      : "Translation";

  return `
    <section class="translation-card" aria-label="Translation">
      <p class="eyebrow">${escapeHtml(label)}</p>
      <p>${renderText(translation.text)}</p>
    </section>`;
}

function renderCommunityNote(note) {
  if (!note) {
    return "";
  }

  return `
    <aside class="community-note" aria-label="Community note">
      <p class="eyebrow">Community note</p>
      <p>${renderText(note)}</p>
    </aside>`;
}

function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) {
    return "";
  }

  const minutes = Math.floor(total / 60);
  const remainder = Math.round(total % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function renderPoll(poll) {
  if (!poll?.choices?.length) {
    return "";
  }

  return `
    <section class="poll-card" aria-label="Poll">
      <p class="eyebrow">Poll</p>
      <div class="poll-options">
        ${poll.choices
          .map(
            (choice) => `
          <div class="poll-option">
            <div class="poll-row">
              <span>${escapeHtml(choice.label)}</span>
              <strong>${escapeHtml(formatPollPercent(choice.percentage))}</strong>
            </div>
            <progress class="poll-bar" max="100" value="${escapeAttr(clampPercent(choice.percentage))}" aria-label="${escapeAttr(choice.label)}: ${escapeAttr(formatPollPercent(choice.percentage))}"></progress>
          </div>`
          )
          .join("")}
      </div>
      <p class="poll-meta">
        ${escapeHtml(formatCount(poll.totalVotes))} votes${poll.timeLeft ? ` · ${escapeHtml(poll.timeLeft)}` : ""}
      </p>
    </section>`;
}

function formatPollPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return "0%";
  }
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(percent)}%`;
}

function clampPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, percent));
}

function renderArticle(article) {
  if (!article) {
    return "";
  }

  const blocks = article.content.blocks
    .map((block) => renderArticleBlock(article, block))
    .join("");

  return `
    <section class="article-body" aria-label="Article">
      <header class="article-header">
        <p class="eyebrow">Article</p>
        <h1>${escapeHtml(article.title)}</h1>
        ${article.previewText ? `<p class="article-preview">${renderText(article.previewText)}</p>` : ""}
      </header>
      ${
        article.cover?.src
          ? `<figure class="article-cover">
              <img src="${escapeAttr(article.cover.src)}" alt="" loading="lazy" decoding="async" width="${escapeAttr(article.cover.width || "")}" height="${escapeAttr(article.cover.height || "")}">
            </figure>`
          : ""
      }
      <div class="article-content">
        ${blocks}
      </div>
    </section>`;
}

function renderArticleBlock(article, block) {
  const text = stripXUrls(block.text || "");
  if (block.type === "atomic") {
    const media = getArticleBlockMedia(article, block);
    return media?.src
      ? `<figure class="article-image">
          <img src="${escapeAttr(media.src)}" alt="" loading="lazy" decoding="async" width="${escapeAttr(media.width || "")}" height="${escapeAttr(media.height || "")}">
        </figure>`
      : "";
  }

  if (!text.trim()) {
    return '<div class="article-break" aria-hidden="true"></div>';
  }

  const content = renderArticleInlineText(text, block, article);
  if (block.type === "header-two") {
    return `<h2>${content}</h2>`;
  }

  if (block.type === "unordered-list-item") {
    return `<p class="article-list-item"><span aria-hidden="true">-</span><span>${content}</span></p>`;
  }

  if (block.type === "ordered-list-item") {
    return `<p class="article-list-item ordered"><span aria-hidden="true"></span><span>${content}</span></p>`;
  }

  return `<p>${content}</p>`;
}

function getArticleBlockMedia(article, block) {
  const entityKey = block.entityRanges?.[0]?.key;
  if (entityKey === undefined) {
    return null;
  }

  const entity = article.content.entityMap.get(String(entityKey));
  const mediaId = entity?.data?.mediaItems?.[0]?.mediaId;
  return mediaId ? article.mediaById.get(String(mediaId)) : null;
}

function renderArticleInlineText(text, block, article) {
  const ranges = [
    ...(block.inlineStyleRanges || []).map((range) => ({
      type: "style",
      style: range.style,
      start: range.offset,
      end: range.offset + range.length,
    })),
    ...(block.entityRanges || []).map((range) => ({
      type: "entity",
      entity: article.content.entityMap.get(String(range.key)),
      start: range.offset,
      end: range.offset + range.length,
    })),
  ].filter((range) => range.start < range.end);

  const boundaries = new Set([0, text.length]);
  for (const range of ranges) {
    boundaries.add(Math.max(0, Math.min(text.length, range.start)));
    boundaries.add(Math.max(0, Math.min(text.length, range.end)));
  }

  const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
  return sortedBoundaries
    .slice(0, -1)
    .map((start, index) => {
      const end = sortedBoundaries[index + 1];
      if (start === end) {
        return "";
      }

      const segmentRanges = ranges.filter(
        (range) => range.start <= start && range.end >= end
      );
      const styles = new Set(
        segmentRanges
          .filter((range) => range.type === "style")
          .map((range) => range.style)
      );
      const link = segmentRanges.find(
        (range) => range.type === "entity" && range.entity?.type === "LINK"
      )?.entity?.data?.url;
      let html = escapeHtml(text.slice(start, end));

      if (styles.has("Bold")) {
        html = `<strong>${html}</strong>`;
      }
      if (styles.has("Italic")) {
        html = `<em>${html}</em>`;
      }
      if (link && !isBlockedFrontendUrl(link)) {
        html = `<a href="${escapeAttr(link)}" rel="nofollow noopener noreferrer" target="_blank">${html}</a>`;
      }

      return html;
    })
    .join("");
}

function renderTweet(tweet, options = {}) {
  const isQuote = Boolean(options.quote);
  const isThreadPost = Boolean(options.thread);
  const exposeInstantView = !isQuote && !isThreadPost;
  const pageTitle = options.title || `${tweet.author.name} (@${tweet.author.screenName})`;
  const avatar = tweet.author.avatar
    ? `<img class="avatar" src="${escapeAttr(tweet.author.avatar)}" alt="" loading="lazy" decoding="async">`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${escapeHtml(
        tweet.author.name.slice(0, 1).toUpperCase() || "?"
      )}</span>`;
  const dateLabel = formatDate(tweet.createdTimestamp);

  return `
    <article
      class="${isQuote ? "quote-post" : isThreadPost ? "post-card thread-post" : "post-card"}"
      ${exposeInstantView ? `data-iv-post data-iv-title="${escapeAttr(pageTitle)}" data-iv-author="${escapeAttr(tweet.author.name)}" data-iv-published-timestamp="${escapeAttr(tweet.createdTimestamp || "")}"` : ""}
    >
      ${
        isQuote
          ? `<p class="quote-author"><strong>${escapeHtml(tweet.author.name)}</strong> <span>@${escapeHtml(tweet.author.screenName)}</span></p>`
          : ""
      }
      <header class="post-header">
        ${avatar}
        <div class="identity">
          <div class="display-name">${escapeHtml(tweet.author.name)}</div>
          <div class="handle">@${escapeHtml(tweet.author.screenName)}</div>
        </div>
      </header>

      <section class="iv-body">
        ${
          tweet.originalUrl
            ? `<p class="original-link"><a href="${escapeAttr(tweet.originalUrl)}" rel="nofollow noopener noreferrer" target="_blank">original post</a></p>`
            : ""
        }
        ${
          tweet.text
            ? `<p class="post-text">${renderText(tweet.text)}</p>`
            : tweet.article
              ? ""
              : `<p class="post-text muted">No text content.</p>`
        }

        ${renderMedia(tweet.media)}
        ${renderPoll(tweet.poll)}
        ${renderArticle(tweet.article)}
        ${renderTranslation(tweet.translation)}
        ${renderCommunityNote(tweet.communityNote)}
        ${tweet.quote ? `<hr class="quote-separator">${renderTweet(tweet.quote, { quote: true })}` : ""}

        <footer class="post-footer">
          ${dateLabel ? `<time datetime="${escapeAttr(tweet.createdAt)}">${escapeHtml(dateLabel)} UTC</time>` : ""}
          <div class="counts" aria-label="Post engagement">
            <span>${formatCount(tweet.counts.replies)} replies</span>
            <span>${formatCount(tweet.counts.retweets)} reposts</span>
            <span>${formatCount(tweet.counts.likes)} likes</span>
            ${
              typeof tweet.counts.views === "number"
                ? `<span>${formatCount(tweet.counts.views)} views</span>`
                : ""
            }
          </div>
        </footer>
      </section>
    </article>`;
}

function renderThread(ancestors, tweet, title) {
  if (!ancestors.length) {
    return renderTweet(tweet, { title });
  }

  return `
    <section class="thread" aria-label="Thread">
      ${ancestors.map((ancestor) => renderTweet(ancestor, { thread: true })).join("")}
      ${renderTweet(tweet, { title })}
    </section>`;
}

function getPageTitle(tweet) {
  const screenName = tweet.author?.screen_name || tweet.author?.screenName || "";
  const authorName = tweet.author?.name || "Unknown";
  const articleTitle = stripXUrls(tweet.article?.title || "");
  return articleTitle || `${authorName} (@${screenName})`;
}

function renderMeta(tweet, origin, pathValue) {
  const screenName = tweet.author?.screen_name || tweet.author?.screenName || "";
  const authorName = tweet.author?.name || "Unknown";
  const title = getPageTitle(tweet);
  const description =
    compactText(stripXUrls(tweet.article?.preview_text || tweet.text)) ||
    `Post by ${authorName || screenName}`;
  const absoluteTweet = `${origin}${pathValue}`;
  const previewImage = getPreviewImage(tweet, origin);
  const video = firstAvailableVideoSource(tweet);
  const videoUrl = video ? mediaUrl(origin, video.url, true) : "";

  return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="${escapeAttr(absoluteTweet)}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="${escapeAttr(SITE_NAME)}">
    <meta property="og:title" content="${escapeAttr(title)}">
    <meta property="og:description" content="${escapeAttr(description)}">
    <meta property="og:url" content="${escapeAttr(absoluteTweet)}">
    <meta property="og:image" content="${escapeAttr(previewImage.url)}">
    <meta property="og:image:secure_url" content="${escapeAttr(previewImage.url)}">
    <meta property="og:image:type" content="${escapeAttr(previewImage.type)}">
    <meta property="og:image:width" content="${escapeAttr(previewImage.width)}">
    <meta property="og:image:height" content="${escapeAttr(previewImage.height)}">
    <meta property="og:image:alt" content="${escapeAttr(description)}">
    <meta name="twitter:card" content="${video ? "player" : "summary_large_image"}">
    <meta name="twitter:title" content="${escapeAttr(title)}">
    <meta name="twitter:description" content="${escapeAttr(description)}">
    <meta name="twitter:image" content="${escapeAttr(previewImage.url)}">
    <meta name="twitter:image:alt" content="${escapeAttr(description)}">
    ${
      video
        ? `
    <meta property="og:video" content="${escapeAttr(videoUrl)}">
    <meta property="og:video:secure_url" content="${escapeAttr(videoUrl)}">
    <meta property="og:video:type" content="${escapeAttr(video.format || "video/mp4")}">
    ${video.width ? `<meta property="og:video:width" content="${escapeAttr(video.width)}">` : ""}
    ${video.height ? `<meta property="og:video:height" content="${escapeAttr(video.height)}">` : ""}`
        : ""
    }`;
}

function getPreviewImage(tweet, origin) {
  const media = firstAvailableImageMedia(tweet);
  if (media?.url) {
    return {
      url: mediaUrl(origin, media.url, true),
      width: media.width || 1200,
      height: media.height || 630,
      type: media.contentType || contentTypeForImageUrl(media.url),
    };
  }

  return {
    url: `${origin}/assets/preview.png`,
    width: 1200,
    height: 630,
    type: "image/png",
  };
}

function firstAvailableImageMedia(tweet) {
  const media = tweet.media || {};
  const articleCover = tweet.article?.cover_media?.media_info;
  const firstAllPhoto = media.all?.find((item) => item.type === "photo");
  const firstAllVideoThumb = media.all?.find(
    (item) => item.type === "video" || item.type === "gif"
  );
  const photo = media.photos?.[0];
  const video = media.videos?.[0];

  if (articleCover?.original_img_url) {
    return {
      url: articleCover.original_img_url,
      width: articleCover.original_img_width,
      height: articleCover.original_img_height,
    };
  }

  if (firstAllPhoto?.url) {
    return {
      url: firstAllPhoto.url,
      width: firstAllPhoto.width,
      height: firstAllPhoto.height,
    };
  }

  if (firstAllVideoThumb?.thumbnail_url) {
    return {
      url: firstAllVideoThumb.thumbnail_url,
      width: firstAllVideoThumb.width,
      height: firstAllVideoThumb.height,
    };
  }

  if (photo?.url) {
    return { url: photo.url, width: photo.width, height: photo.height };
  }

  if (video?.thumbnail_url) {
    return {
      url: video.thumbnail_url,
      width: video.width,
      height: video.height,
    };
  }

  if (media.mosaic?.formats?.webp || media.mosaic?.formats?.jpeg) {
    const url = media.mosaic.formats.webp || media.mosaic.formats.jpeg;
    return {
      url,
      width: media.mosaic.width,
      height: media.mosaic.height,
    };
  }

  return null;
}

function contentTypeForImageUrl(value) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith(".png")) {
      return "image/png";
    }
    if (pathname.endsWith(".webp")) {
      return "image/webp";
    }
    if (pathname.endsWith(".gif")) {
      return "image/gif";
    }
    return "image/jpeg";
  } catch {
    return "image/jpeg";
  }
}

function stylesheetHref() {
  return `/assets/styles.css?v=${STYLESHEET_VERSION}`;
}

function scriptHref() {
  return `/assets/app.js?v=${SCRIPT_VERSION}`;
}

function firstAvailableVideoSource(tweet) {
  const video =
    tweet.media?.all?.find((item) => item.type === "video" || item.type === "gif") ||
    tweet.media?.videos?.[0];
  if (!video?.url) {
    return null;
  }

  const source = selectVideoSource(video);
  return {
    ...video,
    url: source.url,
    format: source.format || video.format,
  };
}

function renderPage(tweet, origin, pathValue, ancestors = []) {
  const normalizedAncestors = ancestors.map((ancestor) =>
    normalizeTweet(ancestor, origin, false)
  );
  const normalized = normalizeTweet(tweet, origin, false);
  const title = getPageTitle(tweet);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderMeta(tweet, origin, pathValue)}
  <link rel="stylesheet" href="${escapeAttr(stylesheetHref())}">
</head>
<body>
  <main class="page-shell">
    <header class="site-header" aria-label="Site">
      <a class="site-title" href="/">${escapeHtml(SITE_NAME)}</a>
      <div class="site-actions">
        <button class="theme-toggle" type="button" aria-pressed="false" aria-label="Toggle color theme" data-theme-toggle>Theme: Light</button>
        <button class="screenshot-button" type="button" data-screenshot-target="article[data-iv-post]" data-screenshot-filename="${escapeAttr(screenshotFilename(normalized.id))}">Screenshot</button>
      </div>
    </header>
    ${renderThread(normalizedAncestors, normalized, title)}
  </main>
  <script src="${escapeAttr(scriptHref())}" defer></script>
</body>
</html>`;
}

function renderHome() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ShareX Post Viewer</title>
  <meta name="description" content="View a public post as a clean shareable page.">
  <link rel="stylesheet" href="${escapeAttr(stylesheetHref())}">
</head>
<body>
  <main class="page-shell home">
    <section class="post-card resolver">
      <h1>Share a public post cleanly</h1>
      <form method="get" action="/go" class="resolver-form">
        <label for="post-url">Post URL or path</label>
        <div class="resolver-row">
          <input id="post-url" name="u" required placeholder="/user/status/1234567890">
          <button type="submit">Open</button>
        </div>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function renderError(statusCode, message) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(statusCode)} ${escapeHtml(message)}</title>
  <link rel="stylesheet" href="${escapeAttr(stylesheetHref())}">
</head>
<body>
  <main class="page-shell">
    <section class="post-card error-card">
      <p class="eyebrow">${escapeHtml(statusCode)}</p>
      <h1>${escapeHtml(message)}</h1>
      <p class="muted">Check that the post is public and the URL path uses /user/status/id.</p>
    </section>
  </main>
</body>
</html>`;
}

function parseStatusPath(pathname) {
  const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{5,25})\/?$/);
  if (!match) {
    return null;
  }
  return { screenName: match[1], statusId: match[2] };
}

function parseGoTarget(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new HttpError(400, "Missing post URL");
  }

  let pathname = input;
  try {
    const parsed = new URL(input);
    pathname = parsed.pathname;
  } catch {
    pathname = input.startsWith("/") ? input : `/${input}`;
  }

  const status = parseStatusPath(pathname);
  if (!status) {
    throw new HttpError(400, "Unsupported post URL");
  }
  return `/${status.screenName}/status/${status.statusId}`;
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": statusCode === 200 ? "public, max-age=60" : "no-store",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; media-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": statusCode === 200 ? "public, max-age=60" : "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

async function serveAsset(res, pathname) {
  const relative = pathname.replace(/^\/assets\//, "");
  const assetPath = path.join(PUBLIC_DIR, relative);
  if (!assetPath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(403, "Forbidden");
  }

  const ext = path.extname(assetPath);
  const type = ASSET_TYPES.get(ext);
  if (!type) {
    throw new HttpError(404, "Not found");
  }

  let stat;
  try {
    stat = await fs.promises.stat(assetPath);
  } catch {
    throw new HttpError(404, "Not found");
  }
  if (!stat.isFile()) {
    throw new HttpError(404, "Not found");
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(assetPath).pipe(res);
}

function sanitizeDownloadFilename(filename) {
  const clean = String(filename || "")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .replace(/^\.+/, "");
  return clean || "video.mp4";
}

function wantsMediaDownload(req, filename) {
  const url = new URL(req.url, "http://localhost");
  return Boolean(filename) || url.searchParams.has("download");
}

async function proxyMedia(req, res, token, filename = "") {
  const upstreamUrl = validateMediaUrl(decryptUrl(token));
  if (shouldRedirectTelegramMedia(req, upstreamUrl)) {
    res.writeHead(302, {
      Location: upstreamUrl,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return res.end();
  }

  const headers = {
    Accept: req.headers.accept || "*/*",
    "User-Agent": APP_USER_AGENT,
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  const upstream = await fetch(upstreamUrl, { headers });
  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(502, "Unable to fetch media");
  }

  const responseHeaders = {
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
  };

  for (const header of ["content-length", "content-range"]) {
    const value = upstream.headers.get(header);
    if (value) {
      responseHeaders[header.replace(/\b\w/g, (char) => char.toUpperCase())] = value;
    }
  }

  if (wantsMediaDownload(req, filename)) {
    responseHeaders["Content-Disposition"] = `attachment; filename="${sanitizeDownloadFilename(filename || "video.mp4")}"`;
  }

  res.writeHead(upstream.status, responseHeaders);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

async function handleRequest(req, res) {
  const origin = getRequestOrigin(req);
  const url = new URL(req.url, origin);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "Method not allowed");
  }

  if (pathname === "/") {
    return sendHtml(res, 200, renderHome());
  }

  if (pathname === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/go") {
    const target = parseGoTarget(url.searchParams.get("u"));
    res.writeHead(302, { Location: target });
    return res.end();
  }

  if (pathname.startsWith("/assets/")) {
    return serveAsset(res, pathname);
  }

  const mediaMatch = pathname.match(/^\/media\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?$/);
  if (mediaMatch) {
    return proxyMedia(req, res, mediaMatch[1], mediaMatch[2] || "");
  }

  const apiMatch = pathname.match(/^\/api\/status\/([A-Za-z0-9_]{1,15})\/([0-9]{5,25})\/?$/);
  if (apiMatch) {
    const tweet = await fetchTweet(apiMatch[1], apiMatch[2]);
    return sendJson(res, 200, {
      post: normalizeTweet(tweet, origin, false),
    });
  }

  const status = parseStatusPath(pathname);
  if (!status) {
    throw new HttpError(404, "Not found");
  }

  const { tweet, ancestors } = await fetchThread(
    status.screenName,
    status.statusId
  );
  return sendHtml(res, 200, renderPage(tweet, origin, pathname, ancestors));
}

function appHandler(req, res) {
  handleRequest(req, res).catch((error) => {
    const statusCode = error.statusCode || 500;
    const message = statusCode === 500 ? "Unexpected server error" : error.message;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendHtml(res, statusCode, renderError(statusCode, message));
  });
}

const server = http.createServer(appHandler);

function startServer() {
  server.on("error", (error) => {
    console.error(`Unable to start server on ${HOST}:${PORT}: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, () => {
    if (!process.env.MEDIA_TOKEN_SECRET) {
      console.warn("MEDIA_TOKEN_SECRET is not set; using a development fallback secret.");
    }
    console.log(`ShareX post pages listening on http://${HOST}:${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = appHandler;
module.exports.default = appHandler;
module.exports.normalizeTweet = normalizeTweet;
module.exports.renderTweet = renderTweet;
module.exports.renderMeta = renderMeta;
module.exports.selectVideoSource = selectVideoSource;
module.exports.sanitizeExternalUrl = sanitizeExternalUrl;
