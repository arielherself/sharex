# ShareX Post Pages

A small Node.js web app that renders X-style post URLs as clean standalone pages.

Example route:

```text
/ipaulcanada/status/2042917249317548376
```

The server fetches structured data from the official FixTweet status API (`https://api.fxtwitter.com/:screen_name?/status/:id/:translate_to?`) and renders a server-side HTML page with Open Graph metadata for chat previews. Text, photos, videos/GIFs, quote posts, polls, articles, translations, community notes, and media ordering are rendered directly where the API exposes them. Images, avatars, thumbnails, and X-hosted video files are streamed through `/media/...` encrypted same-origin proxy URLs, so upstream X media URLs are not present in the frontend HTML.

## Run

```bash
npm start
```

## Test

```bash
npm test
```

## Telegram Instant View

Telegram Instant View requires a domain-specific template in Telegram's Instant View editor. This app emits stable `data-iv-*` attributes and an `.iv-body` section for that parser.

Use [docs/telegram-instant-view.tpl](docs/telegram-instant-view.tpl) as the starting template for your deployed domain at `https://instantview.telegram.org/my/`.

Optional environment variables:

```bash
PORT=3000
HOST=127.0.0.1
PUBLIC_ORIGIN=https://sharex.com
MEDIA_TOKEN_SECRET=replace-with-a-long-random-secret
TELEGRAM_IV_DIRECT_MEDIA=1
APP_USER_AGENT="ShareXPostPages/0.1 contact@example.com"
```

`MEDIA_TOKEN_SECRET` should be set in production so media proxy URLs cannot be decrypted with the development fallback secret.

`TELEGRAM_IV_DIRECT_MEDIA=1` is optional. On serverless hosts such as Vercel, it lets Telegram's Instant View fetcher follow `/media/...` video requests to the upstream video file instead of forcing the serverless function to stream the full MP4. Normal browser HTML still uses same-origin `/media/...` URLs.
