# b. NSFW Discord Bot

Prefix-only Discord bot with channel authorization and random NSFW gacha commands.

## Commands

- `b.nsfw` toggles bot authorization for the current channel (requires `Manage Channels`).
- `b.nh [tags...]` fetches random nhentai contents with option tags
- `b.34gacha [tags...]` fetches one random Rule34 post with optional filters (or fully random if empty).
- `b.34gacha` examples:
  - `b.34gacha 2girls blue_hair`
  - `b.34gacha -ai_generated`
  - `b.34gacha sort:score`
  - `b.34gacha rating:safe` (also `rating:questionable`, `rating:explicit`)
- Other Rule34 tag operators/filters are passed through as-is.

## Requirements

- Node.js 20+
- Discord bot token
- Rule34 API credentials (`user_id` and `api_key`) from https://rule34.xxx/index.php?page=account&s=options
- Discord Developer Portal intents:
  - `MESSAGE CONTENT INTENT` enabled

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Fill `config.json` values.
3. Run:
   ```bash
   npm start
   ```

## Notes

- Prefix is forced to `b.`.
- gacha commands only work in channels enabled via `b.nsfw`.
- Rule34 API now requires authentication; bot will fail startup if credentials are missing.
- Video posts are sent as direct media URLs in message content instead of file uploads.
