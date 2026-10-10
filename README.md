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

## ⚠️ Self-Destruct (Nuke)

Command darurat yang menghapus **seluruh channel** (beserta semua pesannya) dan **seluruh role** yang bisa dihapus di server. Dilindungi beberapa lapis:

1. `b.nuke` — hanya bisa dijalankan oleh **Server Owner** atau member dengan izin **Administrator**. Bot lalu meminta kode nuklir lewat **DM**.
2. Kirim **kode nuklir** ke DM bot. Pesan DM otomatis dihapus. Bot langsung memberi tahu **BENAR** atau **SALAH** (via DM dan channel server); salah 3x membatalkan proses.
3. Setelah kode benar, bot meminta konfirmasi: jalankan `b.nuke confirm`.
4. Bot menjalankan **countdown 10 detik** yang bisa dibatalkan kapan saja dengan `b.nuke abort` (atau `b.abort`).

Role `@everyone`, role yang dikelola bot/integrasi, dan role di atas role bot tidak dihapus.

Kode nuklir bersifat **rahasia** dan tidak ditampilkan di help/README. Set lewat `nukePassword` di `config.json`, atau lebih aman lewat environment variable `NUKE_PASSWORD`. Sesi verifikasi kedaluwarsa dalam 2 menit.

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
   - Jika tidak diset, fitur nuke nonaktif dan `b.nuke` akan menolak.

2. **Pastikan bot punya permission**:
   - `Manage Channels` — wajib untuk hapus channel.
   - `Manage Roles` — wajib untuk hapus role.
   - `Send Messages` & `View Channel` — untuk kirim balasan & notifikasi.
   - Praktisnya: beri role **Administrator** ke bot.

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
  - `DIRECT MESSAGES` intent is requested in code (no portal toggle needed) — diperlukan agar bot bisa menerima kode nuklir lewat DM.

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
