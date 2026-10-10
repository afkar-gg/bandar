# Bandar (bkp) Discord Bot

Prefix-only Discord bot with channel authorization and random NSFW gacha commands.

## Commands

- `b.help` (or `b.h`) displays the help embed guide with all commands, options, and model list.
- `b.nsfw` toggles bot authorization for the current channel (requires `Manage Channels`).
- `b.poi [query]` fetches random Nekopoi contents with optional query
- `b.34gacha [tags...]` fetches one random Rule34 post with optional filters (or fully random if empty).
- `b.34gacha` examples:
  - `b.34gacha 2girls blue_hair`
  - `b.34gacha -ai_generated`
  - `b.34gacha sort:score`
  - `b.34gacha rating:safe` (also `rating:questionable`, `rating:explicit`)
- Other Rule34 tag operators/filters are passed through as-is.

## Self-Destruct (Nuke)

Emergency command that deletes **all channels** (including all messages) and **all deletable roles** in the server. Protected by multiple layers:

1. `b.nuke` — only executable by **Server Owner** or members with **Administrator** permission. Bot then requests nuclear code via **DM**.
2. Kirim **kode nuklir** ke DM bot. DM message auto-deleted. Bot immediately reports **CORRECT** or **INCORRECT** (via DM and server channel); 3 wrong attempts cancels the process.
3. After correct code, bot asks for confirmation: run `b.nuke confirm`.
4. Bot runs a **10-second countdown** cancellable anytime with `b.nuke abort` (or `b.abort`).

Role `@everyone`, bot/integration-managed roles, and roles above the bot's highest role are not deleted.

Nuclear code is **secret** and not shown in help/README. Set via `nukePassword` in `config.json`, or more securely via environment variable `NUKE_PASSWORD`. Verification session expires in 2 minutes.

## ⚠️ Purge Messages

Command to delete **N latest messages** in channel (max 1000). Uses the same security mechanism as nuke:

1. `b.purge <jumlah>` — hanya **Server Owner** atau **Administrator**. Bot minta kode purge lewat **DM**.
2. Send **purge code** to bot DM. DM auto-deleted. Bot reports **CORRECT**/**INCORRECT** (DM + channel); 3 wrong attempts cancels.
3. After correct code, bot asks "sure?" → run `b.purge confirm`.
4. **Countdown 10 detik** (bisa dibatalkan `b.purge abort` / `b.abort`) → hapus pesan.

Pesan >14 hari tidak bisa dihapus massal (batasan Discord). Purge code is separate from nuke: `purgePassword` in config.json or env `PURGE_PASSWORD`.

## Setup Nuke

1. **Set kode nuklir** (pilih salah satu):
   - **Environment variable** (direkomendasikan, tidak ikut ke git):
     ```bash
     export NUKE_PASSWORD="kode-rahasia-anda"
     ```
   - **Atau di `config.json`** (sudah di `.gitignore`, tapi kurang aman):
     ```json
     {
       "nukePassword": "kode-rahasia-anda"
     }
     ```
   - If not set, nuke feature is disabled and `b.nuke` will reject.

2. **Set kode purge** (pilih salah satu, terpisah dari nuklir):
   - **Environment variable** (direkomendasikan):
     ```bash
     export PURGE_PASSWORD="kode-purge-anda"
     ```
   - **Atau di `config.json`**:
     ```json
     {
       "purgePassword": "kode-purge-anda"
     }
     ```
   - If not set, purge feature is disabled and `b.purge` will reject.

3. **Pastikan bot punya permission**:
   - `Manage Channels` — required to delete channels.
   - `Manage Roles` — required to delete roles.
   - `Send Messages` & `View Channel` — for sending replies & notifications.
   - Practically: give bot **Administrator** role.

3. **User harus mengizinkan DM** dari member server (Settings → Privacy → "Allow direct messages from server members"), karena kode nuklir dikirim lewat DM.

4. **Restart bot** setelah mengubah config/env:
   ```bash
   npm start
   ```

## Requirements

- Node.js 20+
- Discord bot token
- Rule34 API credentials (`user_id` and `api_key`) from https://rule34.xxx/index.php?page=account&s=options
- Discord Developer Portal intents:
  - `MESSAGE CONTENT INTENT` enabled
  - `DIRECT MESSAGES` intent is requested in code (no portal toggle needed) — required for bot to receive nuclear code via DM.

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
- Gacha commands only work in channels enabled via `b.nsfw`.
- Rule34 API now requires authentication; bot will fail startup if credentials are missing.
- Video posts are sent as direct media URLs in message content instead of file uploads.
