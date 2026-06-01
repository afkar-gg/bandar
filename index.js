'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CHANNELS_PATH = path.join(__dirname, 'channels.json');

// Queue for gacha requests to reduce CPU load
const gachaQueue = [];
let isProcessingQueue = false;

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
}

function normalizeConfig(config) {
  const resolved = { ...config };

  resolved.prefix = 'b.';
  resolved.requestTimeoutMs = Number(resolved.requestTimeoutMs) > 0 ? Number(resolved.requestTimeoutMs) : 12000;
  resolved.rule34MaxAttempts = Number(resolved.rule34MaxAttempts) > 0 ? Number(resolved.rule34MaxAttempts) : 4;
  resolved.rule34PagePool = Number(resolved.rule34PagePool) > 0 ? Number(resolved.rule34PagePool) : 150;
  resolved.userAgent = resolved.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  if (!resolved.token || typeof resolved.token !== 'string') {
    throw new Error('config.json is missing "token".');
  }

  if (!resolved.rule34UserId || !resolved.rule34ApiKey) {
    throw new Error('config.json requires "rule34UserId" and "rule34ApiKey" for Rule34 API authentication.');
  }

  return resolved;
}

async function loadConfig() {
  let config;
  try {
    config = await readJson(CONFIG_PATH);
  } catch (error) {
    throw new Error(`Failed to read config.json: ${error.message}`);
  }

  return normalizeConfig(config);
}

async function loadAllowlist() {
  try {
    const data = await readJson(CHANNELS_PATH);
    const allowed = Array.isArray(data.allowedChannelIds) ? data.allowedChannelIds.filter(Boolean) : [];
    return new Set(allowed);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      await writeJsonAtomic(CHANNELS_PATH, { allowedChannelIds: [] });
      return new Set();
    }

    throw new Error(`Failed to read channels.json: ${error.message}`);
  }
}

async function saveAllowlist(allowlist) {
  await writeJsonAtomic(CHANNELS_PATH, { allowedChannelIds: Array.from(allowlist) });
}

const AI_GENERATED_TAGS = new Set([
  'ai_generated',
  'stable_diffusion',
  'midjourney',
  'dall-e',
  'novelai',
  'ai_art',
  'generated_by_ai',
]);

const NHENTAI_API_BASE = 'https://nhentai.net/api';
const NHENTAI_EXT_MAP = { p: 'png', j: 'jpg', g: 'gif' };

function getNHentaiExtension(t) {
  return NHENTAI_EXT_MAP[t] || 'jpg';
}

function parseRule34Tags(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function isAiGenerated(post) {
  if (!post || typeof post.tags !== 'string') {
    return false;
  }

  const postTags = post.tags.split(/\s+/).map((tag) => tag.toLowerCase());
  return postTags.some((tag) => AI_GENERATED_TAGS.has(tag));
}

function buildRule34ApiUrl(config, tags) {
  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: '100',
    user_id: String(config.rule34UserId),
    api_key: String(config.rule34ApiKey),
  });

  if (tags.length > 0) {
    params.set('tags', tags.join(' '));
  }

  // Rule34 uses page index as pid. We probe random pages to approximate random selection.
  const randomPid = Math.floor(Math.random() * config.rule34PagePool);
  params.set('pid', String(randomPid));

  return `https://api.rule34.xxx/index.php?${params.toString()}`;
}

function buildRule34ApiUrlWithPage(config, tags, page) {
  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: '100',
    user_id: String(config.rule34UserId),
    api_key: String(config.rule34ApiKey),
  });

  if (tags.length > 0) {
    params.set('tags', tags.join(' '));
  }

  params.set('pid', String(page));

  return `https://api.rule34.xxx/index.php?${params.toString()}`;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(rawAttributes) {
  const attributes = {};
  const attributePattern = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
  let match = attributePattern.exec(rawAttributes);

  while (match) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
    match = attributePattern.exec(rawAttributes);
  }

  return attributes;
}

function parseRule34XmlPosts(xmlText) {
  const postPattern = /<post\s+([^>]*?)\/>/g;
  const posts = [];
  let match = postPattern.exec(xmlText);

  while (match) {
    posts.push(parseXmlAttributes(match[1]));
    match = postPattern.exec(xmlText);
  }

  if (posts.length > 0) {
    return posts;
  }

  if (/<posts\b[^>]*>\s*<\/posts>/i.test(xmlText)) {
    return [];
  }

  return null;
}

function parseRule34XmlError(xmlText) {
  const errorMatch = xmlText.match(/<error>([\s\S]*?)<\/error>/i);
  if (!errorMatch) {
    return null;
  }

  const message = errorMatch[1].trim();
  return message ? decodeXmlEntities(message) : 'Unknown API error';
}

async function fetchJson(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.userAgent,
      },
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      const trimmed = text.trim();

      if (trimmed.startsWith('<')) {
        const xmlPosts = parseRule34XmlPosts(trimmed);
        if (xmlPosts !== null) {
          return xmlPosts;
        }

        const xmlError = parseRule34XmlError(trimmed);
        if (xmlError) {
          throw new Error(`Rule34 API error: ${xmlError}`);
        }
      }

      throw new Error(`API did not return JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function looksLikeMedia(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }

  return /^https?:\/\//i.test(url);
}

function isVideoUrl(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }

  const lowerUrl = url.toLowerCase();
  return lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.webm');
}

function isFatalRule34Error(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }

  const message = error.message;
  if (message.startsWith('Rule34 API error:')) {
    return true;
  }

  return message.startsWith('HTTP 401') || message.startsWith('HTTP 403');
}

async function getRandomRule34Post(config, tags) {
  // First, try random pages
  for (let attempt = 0; attempt < config.rule34MaxAttempts; attempt += 1) {
    const url = buildRule34ApiUrl(config, tags);
    let payload;
    try {
      payload = await fetchJson(url, config);
    } catch (error) {
      if (isFatalRule34Error(error)) {
        throw error;
      }
      console.warn(`Rule34 random fetch attempt ${attempt + 1} failed: ${error.message}`);
      continue;
    }

    if (typeof payload === 'string') {
      throw new Error(`Rule34 API error: ${payload}`);
    }

    if (!Array.isArray(payload) || payload.length === 0) {
      continue;
    }

    const valid = payload.filter((post) => {
      if (!post || !looksLikeMedia(post.file_url)) {
        return false;
      }
      if (isAiGenerated(post)) {
        return false;
      }
      return true;
    });

    if (valid.length === 0) {
      continue;
    }

    return pickRandom(valid);
  }

  // Fallback: search lower pages sequentially when random pages fail
  for (let page = 0; page < config.rule34MaxAttempts; page += 1) {
    const url = buildRule34ApiUrlWithPage(config, tags, page);
    let payload;
    try {
      payload = await fetchJson(url, config);
    } catch (error) {
      if (isFatalRule34Error(error)) {
        throw error;
      }
      console.warn(`Rule34 sequential fetch page ${page} failed: ${error.message}`);
      continue;
    }

    if (typeof payload === 'string') {
      throw new Error(`Rule34 API error: ${payload}`);
    }

    if (!Array.isArray(payload) || payload.length === 0) {
      continue;
    }

    const valid = payload.filter((post) => {
      if (!post || !looksLikeMedia(post.file_url)) {
        return false;
      }
      if (isAiGenerated(post)) {
        return false;
      }
      return true;
    });

    if (valid.length === 0) {
      continue;
    }

    return pickRandom(valid);
  }

  return null;
}

function buildRule34Embed(post) {
  const postUrl = `https://rule34.xxx/index.php?page=post&s=view&id=${post.id}`;
  const safeTags = typeof post.tags === 'string' ? post.tags.split(' ').filter(Boolean).slice(0, 15) : [];

  const embed = new EmbedBuilder()
    .setTitle(`Rule34 Post #${post.id}`)
    .setURL(postUrl)
    .setDescription(`[Open post](${postUrl})`)
    .addFields(
      {
        name: 'Tags',
        value: safeTags.length > 0 ? safeTags.join(', ') : 'No tags',
      },
      {
        name: 'Score',
        value: post.score ? String(post.score) : 'N/A',
        inline: true,
      }
    );

  if (looksLikeMedia(post.file_url)) {
    if (isVideoUrl(post.file_url)) {
      embed.setDescription(`[Open post](${postUrl})\n\n*Video file - direct URL sent in message content*`);
    } else {
      embed.setImage(post.file_url);
    }
  }

  return embed;
}

async function sendRule34Embed(message, post) {
  try {
    const embed = buildRule34Embed(post);
    const sentEmbedMessage = await safeReplyWithEmbed(message, embed);

    if (!sentEmbedMessage) {
      return null;
    }

    if (isVideoUrl(post.file_url)) {
      try {
        await sentEmbedMessage.reply(post.file_url);
      } catch (error) {
        if (error && error.code === 50013) {
          console.warn(`Cannot send video URL reply in channel ${message.channelId}: Missing Permissions`);
        } else {
          console.error('Error sending video URL reply:', error);
        }
      }
    }

    return sentEmbedMessage;
  } catch (error) {
    if (error && error.code === 50013) {
      console.warn(`Cannot reply to message in channel ${message.channelId}: Missing Permissions`);
    } else {
      console.error('Error sending Rule34 embed:', error);
    }
    return null;
  }
}

async function getRandomNHentaiGallery(config, query = '') {
  const searchQuery = query || '-ai_generated';
  const firstPageUrl = `${NHENTAI_API_BASE}/galleries/search?query=${encodeURIComponent(searchQuery)}&page=1`;

  let firstPage;
  try {
    firstPage = await fetchJson(firstPageUrl, config);
  } catch (error) {
    console.error('nHentai search fetch error:', error);
    return null;
  }

  const results = firstPage ? (firstPage.result || firstPage.results) : null;
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const numPages = Math.min(firstPage.num_pages || 1, 500);
  const randomPage = Math.floor(Math.random() * numPages) + 1;

  let galleryPool;
  if (randomPage === 1) {
    galleryPool = results;
  } else {
    const pageUrl = `${NHENTAI_API_BASE}/galleries/search?query=${encodeURIComponent(searchQuery)}&page=${randomPage}`;
    try {
      const pageData = await fetchJson(pageUrl, config);
      galleryPool = pageData ? (pageData.result || pageData.results) : null;
    } catch (error) {
      console.warn(`nHentai search page ${randomPage} fetch failed, falling back to first page: ${error.message}`);
      galleryPool = results;
    }
  }

  if (!Array.isArray(galleryPool) || galleryPool.length === 0) {
    return null;
  }

  return pickRandom(galleryPool);
}

function buildNHentaiEmbed(gallery) {
  const galleryUrl = `https://nhentai.net/g/${gallery.id}/`;
  const coverExt = getNHentaiExtension(gallery.images.cover.t);
  const coverUrl = `https://t.nhentai.net/galleries/${gallery.media_id}/cover.${coverExt}`;

  const title = gallery.title.english || gallery.title.japanese || gallery.title.pretty || 'Untitled';
  const tags = Array.isArray(gallery.tags)
    ? gallery.tags
      .filter((t) => t.type === 'tag')
      .map((t) => t.name)
      .slice(0, 15)
    : [];

  const embed = new EmbedBuilder()
    .setTitle(title.slice(0, 256))
    .setURL(galleryUrl)
    .setDescription(`[Open gallery](${galleryUrl})`)
    .addFields(
      {
        name: 'Tags',
        value: tags.length > 0 ? tags.join(', ') : 'No tags',
      },
      {
        name: 'Pages',
        value: gallery.num_pages ? String(gallery.num_pages) : 'N/A',
        inline: true,
      },
      {
        name: 'ID',
        value: String(gallery.id),
        inline: true,
      }
    )
    .setImage(coverUrl);

  return embed;
}

async function sendNHentaiEmbed(message, gallery) {
  try {
    const embed = buildNHentaiEmbed(gallery);
    await safeReplyWithEmbed(message, embed);
  } catch (error) {
    if (error && error.code === 50013) {
      console.warn(`Cannot reply to message in channel ${message.channelId}: Missing Permissions`);
    } else {
      console.error('Error sending nHentai embed:', error);
    }
  }
}

async function handleNHentaiCommand(message, query, config) {
  return new Promise((resolve) => {
    const processFn = async (queueConfig) => {
      const usedConfig = queueConfig || config;
      const gallery = await getRandomNHentaiGallery(usedConfig, query);

      if (!gallery) {
        await safeReply(message, query
          ? `No nHentai gallery found for query: ${query}`
          : 'No nHentai gallery found right now.');
        resolve();
        return;
      }

      await sendNHentaiEmbed(message, gallery);
      resolve();
    };

    gachaQueue.push({ message, process: processFn, config });
    processGachaQueue();
  });
}

function buildHelp(prefix) {
  return [
    `Commands (${prefix}):`,
    `${prefix}nsfw - toggle this channel authorization (Manage Channels required)`,
    `${prefix}34gacha or ${prefix}34g [tags...] - random Rule34 post (no tags = fully random)`,
    `  examples: ${prefix}34gacha 2girls blue_hair`,
    `${prefix}nhgacha or ${prefix}nh [query...] - random nHentai gallery (no query = random)`,
    `  examples: ${prefix}nhgacha mosaic japanese`,
    `  exclude tags: ${prefix}34gacha -ai_generated`,
    `  sort: ${prefix}34gacha sort:score`,
    `  filters: ${prefix}34gacha rating:safe | rating:questionable | rating:explicit`,
    '  tip: other Rule34 tag operators/filters also work (passed through as-is)',
  ].join('\n');
}

async function safeReply(message, content) {
  try {
    await message.reply(content);
  } catch (error) {
    if (error && error.code === 50013) {
      console.warn(`Cannot reply to message in channel ${message.channelId}: Missing Permissions`);
    } else {
      console.error('Error sending reply:', error);
    }
  }
}

async function processGachaQueue() {
  if (isProcessingQueue || gachaQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (gachaQueue.length > 0) {
    const item = gachaQueue.shift();
    try {
      await item.process(item.config);
    } catch (error) {
      console.error('Queue item processing error:', error);
      if (item.message && !item.message.deleted) {
        await safeReply(item.message, 'Command failed. Check bot logs and config.');
      }
    }
  }

  isProcessingQueue = false;
}

async function handleGachaCommand(message, tags, config) {
  return new Promise((resolve) => {
    const processFn = async (queueConfig) => {
      const usedConfig = queueConfig || config;
      const post = await getRandomRule34Post(usedConfig, tags);

      if (!post) {
        await safeReply(message, tags.length > 0
          ? `No Rule34 post found for tags: ${tags.join(', ')}`
          : 'No Rule34 post found right now.');
        resolve();
        return;
      }

      await sendRule34Embed(message, post);
      resolve();
    };

    gachaQueue.push({ message, process: processFn, config });
    processGachaQueue();
  });
}

async function safeReplyWithEmbed(message, embed) {
  try {
    const result = await message.reply({ embeds: [embed] });
    return result;
  } catch (error) {
    if (error && error.code === 50013) {
      console.warn(`Cannot reply to message in channel ${message.channelId}: Missing Permissions`);
    } else {
      console.error('Error sending reply:', error);
    }
    return null;
  }
}

async function main() {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
  const config = await loadConfig();
  const allowlist = await loadAllowlist();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    if (!client.user) {
      return;
    }
    console.log(`Logged in as ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot || typeof message.content !== 'string') {
      return;
    }

    // Case-insensitive prefix check
    const prefixMatch = message.content.toLowerCase().startsWith(config.prefix);
    if (!prefixMatch) {
      return;
    }

    const rawInput = message.content.slice(config.prefix.length).trim();
    if (!rawInput) {
      await safeReply(message, buildHelp(config.prefix));
      return;
    }

    const [commandRaw, ...rest] = rawInput.split(' ');
    const command = commandRaw.toLowerCase();

    try {
      if (command === 'nsfw') {
        if (!message.member || !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          await safeReply(message, 'You need `Manage Channels` permission to use this command.');
          return;
        }

        if (allowlist.has(message.channelId)) {
          allowlist.delete(message.channelId);
          await saveAllowlist(allowlist);
          await safeReply(message, 'NSFW bot access is now disabled for this channel.');
          return;
        }

        allowlist.add(message.channelId);
        await saveAllowlist(allowlist);
        await safeReply(message, 'NSFW bot access is now enabled for this channel.');
        return;
      }

      if (!allowlist.has(message.channelId)) {
        await safeReply(message, 'This channel is not authorized. Use `b.nsfw` first (Manage Channels required).');
        return;
      }

      if (command === '34gacha' || command === '34g') {
        const tagsInput = rest.join(' ').trim();
        const tags = parseRule34Tags(tagsInput);
        await handleGachaCommand(message, tags, config);
        return;
      }

      if (command === 'nhgacha' || command === 'nh') {
        const query = rest.join(' ').trim();
        await handleNHentaiCommand(message, query, config);
        return;
      }

      await safeReply(message, buildHelp(config.prefix));
    } catch (error) {
      console.error('Command error:', error);
      await safeReply(message, 'Command failed. Check bot logs and config.');
    }
  });

  await client.login(config.token);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
