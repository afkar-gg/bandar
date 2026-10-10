'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns');
const https = require('node:https');
const crypto = require('node:crypto');
const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(['1.1.1.1', '8.8.8.8', '8.8.4.4']);
const vm = require('node:vm');

const dnsCache = {};
const originalLookup = dns.lookup;

async function resolveDoH(host) {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await res.json();
    const aRecord = data.Answer?.find(ans => ans.type === 1);
    if (aRecord?.data) return aRecord.data;
  } catch (e) {
    try {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
        headers: { 'Accept': 'application/dns-json' },
        signal: AbortSignal.timeout(3000)
      });
      const data = await res.json();
      const aRecord = data.Answer?.find(ans => ans.type === 1);
      if (aRecord?.data) return aRecord.data;
    } catch (e2) {
      // ignore
    }
  }
  return null;
}

dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const sendResult = (ip) => {
    if (options && options.all) {
      callback(null, [{ address: ip, family: 4 }]);
    } else {
      callback(null, ip, 4);
    }
  };
  
  const bypassHosts = ['nekopoi.care', 'streampoi.com', 'playmogo.com', 'api-inference.huggingface.co', 'huggingface.co'];
  const shouldBypass = bypassHosts.some(host => hostname === host || hostname.endsWith('.' + host));
  
  if (shouldBypass) {
     if (dnsCache[hostname]) {
       sendResult(dnsCache[hostname]);
       return;
     }
     
     resolveDoH(hostname).then(ip => {
       if (ip) {
         dnsCache[hostname] = ip;
         sendResult(ip);
       } else {
         originalLookup(hostname, options, callback);
       }
     }).catch(() => {
       originalLookup(hostname, options, callback);
     });
  } else {
     originalLookup(hostname, options, callback);
  }
};

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
  Partials,
  Events,
} = require('discord.js');

const { logInteraction } = require('./logger');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CHANNELS_PATH = path.join(__dirname, 'channels.json');

const MODERATOR_COMMANDS = new Set([
  'nsfw',
  'nuke',
  'selfdestruct',
  'purge',
  'abort',
]);

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
  resolved.imageGenTimeoutMs = Number(resolved.imageGenTimeoutMs) > 0 ? Number(resolved.imageGenTimeoutMs) : 120000;
  resolved.rule34MaxAttempts = Number(resolved.rule34MaxAttempts) > 0 ? Number(resolved.rule34MaxAttempts) : 4;
  resolved.rule34PagePool = Number(resolved.rule34PagePool) > 0 ? Number(resolved.rule34PagePool) : 150;
  resolved.userAgent = resolved.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  resolved.pollinationsApiKey = resolved.pollinationsApiKey || '';
  resolved.hordeApiKey = resolved.hordeApiKey || '';
  resolved.hordeTimeoutMs = Number(resolved.hordeTimeoutMs) > 0 ? Number(resolved.hordeTimeoutMs) : 600000;
  // Nuclear code for self-destruct: secret, only for Server Owner / Administrator.
  // Can be set via config.json ("nukePassword") or env NUKE_PASSWORD (safer).
  resolved.nukePassword = process.env.NUKE_PASSWORD || resolved.nukePassword || '';
  resolved.purgePassword = process.env.PURGE_PASSWORD || resolved.purgePassword || '';
  resolved.nukeCountdownSeconds = Number.isFinite(Number(resolved.nukeCountdownSeconds)) && Number(resolved.nukeCountdownSeconds) >= 0 ? Number(resolved.nukeCountdownSeconds) : 10;
  resolved.purgeCountdownSeconds = Number.isFinite(Number(resolved.purgeCountdownSeconds)) && Number(resolved.purgeCountdownSeconds) >= 0 ? Number(resolved.purgeCountdownSeconds) : 10;

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
  'deepfake',
  'synthesized',
  'aiart',
  'stablediffusion',
  'midjourneyv6',
  'nijijourney',
  'openai',
]);

const NEKOPOI_API_BASE = 'https://nekopoi.care/wp-json/wp/v2';


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
  let isAiFiltered = false;

  const fetchAndFilter = async (currentTags, pid, isRandom = true) => {
    const url = isRandom 
      ? buildRule34ApiUrl(config, currentTags)
      : buildRule34ApiUrlWithPage(config, currentTags, pid);
    
    try {
      const payload = await fetchJson(url, config);
      if (typeof payload === 'string') return { posts: [], filtered: false };
      if (!Array.isArray(payload) || payload.length === 0) return { posts: [], filtered: false };

      const valid = payload.filter((post) => {
        if (!post || !looksLikeMedia(post.file_url)) return false;
        if (isAiGenerated(post)) return false;
        return true;
      });

      return { posts: valid, filtered: valid.length === 0 && payload.length > 0 };
    } catch (error) {
      if (isFatalRule34Error(error)) throw error;
      return { posts: [], filtered: false };
    }
  };

  // Try random pages
  for (let attempt = 0; attempt < config.rule34MaxAttempts; attempt += 1) {
    const result = await fetchAndFilter(tags, 0, true);
    if (result.posts.length > 0) return pickRandom(result.posts);
    if (result.filtered) isAiFiltered = true;
  }

  // Fallback: sequential pages
  for (let page = 0; page < config.rule34MaxAttempts; page += 1) {
    const result = await fetchAndFilter(tags, page, false);
    if (result.posts.length > 0) return pickRandom(result.posts);
    if (result.filtered) isAiFiltered = true;
  }

  // Smart Correction: If still no results and tags have spaces, try joining with underscores
  if (tags.length > 1) {
    const joinedTag = [tags.join('_')];
    const result = await fetchAndFilter(joinedTag, 0, false);
    if (result.posts.length > 0) return pickRandom(result.posts);
    if (result.filtered) isAiFiltered = true;
  }

  if (isAiFiltered) return 'FILTERED_AI';
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

function isNekopoiAiGenerated(post) {
  const title = post.title.rendered.toLowerCase();
  const excerpt = post.excerpt.rendered.toLowerCase();
  const content = title + ' ' + excerpt;
  
  // Simple keyword check
  const aiKeywords = ['ai', 'stable diffusion', 'midjourney', 'dall-e', 'novelai', 'ai art', 'deepfake', 'synthesized', 'aiart', 'stablediffusion', 'midjourneyv6', 'nijijourney', 'openai'];
  return aiKeywords.some((keyword) => content.includes(keyword));
}

async function getRandomNekopoiPost(config, query = '') {
  let url = `${NEKOPOI_API_BASE}/posts?_embed&per_page=20`;
  
  if (query && query !== 'RANDOM_PAGE_FALLBACK') {
    url += `&search=${encodeURIComponent(query)}`;
  } else {
    // Probing random pages to approximate random selection
    const randomPage = Math.floor(Math.random() * 100) + 1;
    url += `&page=${randomPage}`;
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.userAgent,
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs || 10000),
    });

    if (!response.ok) {
      if (response.status === 400 && !query) {
        // Fallback to first page if random page is out of bounds
        return getRandomNekopoiPost(config, 'RANDOM_PAGE_FALLBACK');
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const posts = await response.json();
    if (!Array.isArray(posts) || posts.length === 0) {
      return null;
    }

    // Filter AI generated posts
    const validPosts = posts.filter(post => !isNekopoiAiGenerated(post));
    
    if (validPosts.length === 0) {
      // If all posts in this batch are AI, retry
      if (query === 'RANDOM_PAGE_FALLBACK') return null;
      return getRandomNekopoiPost(config, 'RANDOM_PAGE_FALLBACK');
    }

    return pickRandom(validPosts);
  } catch (error) {
    if (query === 'RANDOM_PAGE_FALLBACK') return null;
    console.error('Nekopoi fetch error:', error);
    // Silent fallback to first page
    if (!query) {
      return getRandomNekopoiPost(config, 'RANDOM_PAGE_FALLBACK');
    }
    return null;
  }
}

async function getRandomNhentaiPost(config, query = '', sort = 'popular') {
    let url = 'https://nhentai.net/api/v2/galleries/random';
    if (query) {
        url = `https://nhentai.net/api/v2/search?query=${encodeURIComponent(query)}&sort=${sort}`;
    }

    const headers = { 'User-Agent': config.userAgent };
    if (config.nhentaiApiKey) {
        headers['Authorization'] = `Bearer ${config.nhentaiApiKey}`;
    }

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) return null;
        let data = await response.json();

        let post = data;
        if (query && data.result && Array.isArray(data.result)) {
            post = pickRandom(data.result);
        } else if (Array.isArray(data)) {
            post = pickRandom(data);
        }

        // If we only got an ID or minimal data, fetch full details
        if (post && post.id && (!post.title || !post.media_id)) {
            const detailRes = await fetch(`https://nhentai.net/api/v2/galleries/${post.id}`, { headers });
            if (detailRes.ok) {
                post = await detailRes.json();
            }
        }

        return post;
    } catch (error) {
        console.error('nhentai fetch error:', error);
        return null;
    }
}

async function scrapeNekopoiDetails(pageUrl, userAgent, timeoutMs = 8000) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    
    if (!res.ok) return null;
    const html = await res.text();
    
    const streamFrames = [];
    const iframeRegex = /<div id="nk-stream-\d+"[^>]*>\s*<iframe src="([^"]+)"/gi;
    let match;
    while ((match = iframeRegex.exec(html)) !== null) {
      streamFrames.push(match[1]);
    }
    
    if (streamFrames.length === 0) {
      const altIframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
      while ((match = altIframeRegex.exec(html)) !== null) {
        const url = match[1];
        if (url.includes('playmogo') || url.includes('streampoi')) {
          streamFrames.push(url);
        }
      }
    }
    
    let directStreamUrl = null;
    const streampoiUrl = streamFrames.find(url => url.includes('streampoi.com'));
    if (streampoiUrl) {
      try {
        const embedRes = await fetch(streampoiUrl, {
          headers: {
            'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://nekopoi.care/'
          },
          signal: AbortSignal.timeout(2500)
        });
        if (embedRes.ok) {
          const embedHtml = await embedRes.text();
          const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
          let scriptMatch;
          let packedScript = '';
          while ((scriptMatch = scriptRegex.exec(embedHtml)) !== null) {
            const scriptContent = scriptMatch[1];
            if (scriptContent.includes('eval(function(p,a,c,k,e,d)')) {
              packedScript = scriptContent.trim();
              break;
            }
          }
          
          if (packedScript) {
            let unpackedResult = '';
            const sandbox = {
              eval: function(code) {
                unpackedResult = code;
              },
              window: {},
              document: {},
              $: function() { return { cookie: function() {} }; }
            };
            vm.createContext(sandbox);
            vm.runInContext(packedScript, sandbox);
            
            const fileMatch = unpackedResult.match(/file\s*:\s*["']([^"']+)["']/i);
            if (fileMatch) {
              directStreamUrl = fileMatch[1];
            }
          }
        }
      } catch (err) {
        console.warn("Streampoi unpack skipped/failed:", err.message);
      }
    }
    
    const downloads = [];
    const rowRegex = /<div class="nk-download-row"><div class="nk-download-name">([\s\S]+?)<\/div><div class="nk-download-links"><b>LINK<\/b><p>([\s\S]+?)<\/p>/gi;
    while ((match = rowRegex.exec(html)) !== null) {
      const name = match[1].replace(/<[^>]*>/g, '').trim();
      const linksHtml = match[2];
      
      const links = [];
      const linkRegex = /<a href="([^"]+)">([^<]+)<\/a>/gi;
      let linkMatch;
      while ((linkMatch = linkRegex.exec(linksHtml)) !== null) {
        links.push({
          url: linkMatch[1],
          host: linkMatch[2].trim()
        });
      }
      
      downloads.push({
        name,
        links
      });
    }
    
    return {
      streamFrames,
      directStreamUrl,
      downloads
    };
  } catch (err) {
    console.error("Scraping error:", err.message);
    return null;
  }
}

function buildNekopoiEmbed(post, scrapedDetails = null) {
  const title = post.title.rendered
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&amp;/g, '&');

  const postUrl = post.link;
  
  let imageUrl = null;
  if (post._embedded && post._embedded['wp:featuredmedia'] && post._embedded['wp:featuredmedia'][0]) {
    imageUrl = post._embedded['wp:featuredmedia'][0].source_url;
  }

  const description = post.excerpt.rendered
    .replace(/<[^>]*>/g, '')
    .replace(/&hellip;/g, '...')
    .replace(/&nbsp;/g, ' ')
    .trim();

  const embed = new EmbedBuilder()
    .setTitle(title.slice(0, 256))
    .setURL(postUrl)
    .setDescription(description.slice(0, 2048) || `[Open post](${postUrl})`)
    .addFields(
      {
        name: 'Date',
        value: new Date(post.date).toLocaleDateString(),
        inline: true,
      },
      {
        name: 'ID',
        value: String(post.id),
        inline: true,
      }
    );

  if (scrapedDetails) {
    if (scrapedDetails.streamFrames && scrapedDetails.streamFrames.length > 0) {
      let streamVal = scrapedDetails.streamFrames.map((url, idx) => `[Server ${idx + 1}](${url})`).join(' | ');
      if (scrapedDetails.directStreamUrl) {
        streamVal += `\n[Direct Stream (.m3u8)](${scrapedDetails.directStreamUrl})`;
      }
      embed.addFields({
        name: 'Streaming Links',
        value: streamVal,
        inline: false
      });
    }

    if (scrapedDetails.downloads && scrapedDetails.downloads.length > 0) {
      const dlLines = scrapedDetails.downloads.map(dl => {
        const qMatch = dl.name.match(/\[([^\]]+)\]$/);
        const quality = qMatch ? qMatch[1] : 'Download';
        const linksStr = dl.links.map(link => `[${link.host}](${link.url})`).join(' | ');
        return `**${quality}**: ${linksStr}`;
      });

      let currentVal = '';
      let chunkIdx = 1;
      for (const line of dlLines) {
        if (currentVal.length + line.length + 2 > 1024) {
          embed.addFields({
            name: `Download Links Part ${chunkIdx}`,
            value: currentVal,
            inline: false
          });
          currentVal = line;
          chunkIdx++;
        } else {
          currentVal = currentVal ? `${currentVal}\n${line}` : line;
        }
      }
      if (currentVal) {
        embed.addFields({
          name: chunkIdx > 1 ? `Download Links Part ${chunkIdx}` : 'Download Links',
          value: currentVal,
          inline: false
        });
      }
    }
  }

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  return embed;
}

function buildNhentaiEmbed(post) {
    if (!post || !post.id) return new EmbedBuilder().setTitle('Error: Post not found or invalid data');
    
    let title = 'No Title';
    try {
        if (post.title) {
            if (typeof post.title === 'string') title = post.title;
            else if (typeof post.title === 'object') {
                title = post.title.pretty || post.title.english || post.title.japanese || 'No Title';
            }
        } else if (post.name) {
            title = post.name;
        }
    } catch (e) { console.error('Title mapping error', e); }

    const postUrl = `https://nhentai.net/g/${post.id}/`;
    const mediaId = post.media_id || post.mediaId || (post.images?.cover?.t ? post.images.cover.t : null);
    
    let ext = 'jpg';
    if (post.images?.cover?.t === 'p') ext = 'png';
    else if (post.images?.cover?.t === 'g') ext = 'gif';
    
    const thumbUrl = mediaId ? `https://t.nhentai.net/galleries/${mediaId}/cover.${ext}` : null;
    
    let tagString = 'No tags';
    try {
        if (Array.isArray(post.tags)) {
            tagString = post.tags.map(t => (typeof t === 'object' ? t.name : t)).slice(0, 15).join(', ');
        }
    } catch (e) { console.error('Tags mapping error', e); }

    const pages = post.num_pages || post.numPages || (Array.isArray(post.pages) ? post.pages.length : 'Unknown');

    const embed = new EmbedBuilder()
        .setTitle(title.length > 250 ? title.slice(0, 250) + '...' : title)
        .setURL(postUrl)
        .addFields(
            { name: 'ID', value: String(post.id), inline: true },
            { name: 'Pages', value: String(pages), inline: true },
            { name: 'Tags', value: tagString || 'No tags' }
        )
        .setFooter({ text: 'nhentai.net' });
    if (thumbUrl) {
        embed.setImage(thumbUrl);
    }
    return embed;
}

async function sendNekopoiEmbed(message, post, config) {
  try {
    const scraped = await scrapeNekopoiDetails(post.link, config?.userAgent, config?.requestTimeoutMs || 8000);
    const embed = buildNekopoiEmbed(post, scraped);
    await safeReplyWithEmbed(message, embed);
  } catch (error) {
    if (error && error.code === 50013) {
      console.warn(`Cannot reply to message in channel ${message.channelId}: Missing Permissions`);
    } else {
      console.error('Error sending Nekopoi embed:', error);
    }
  }
}

async function sendNhentaiEmbed(message, post) {
    try {
        const embed = buildNhentaiEmbed(post);
        await safeReplyWithEmbed(message, embed);
    } catch (error) {
        if (error && error.code === 50013) {
            console.warn(`Cannot reply to message in channel ${message.channelId}: Missing Permissions`);
        } else {
            console.error('Error sending nhentai embed:', error);
        }
    }
}

async function handleNekopoiCommand(message, query, config) {
  return new Promise((resolve, reject) => {
    const processFn = async (queueConfig) => {
      try {
        const usedConfig = queueConfig || config;
        const post = await getRandomNekopoiPost(usedConfig, query);

        if (!post) {
          logInteraction('gacha_result', { type: 'nekopoi', query, result: 'not_found' });
          await safeReply(message, query
            ? `No Nekopoi post found for query: ${query}`
            : 'No Nekopoi post found right now.');
          resolve();
          return;
        }

        logInteraction('gacha_result', { type: 'nekopoi', query, result: 'success', postId: post.id });
        await sendNekopoiEmbed(message, post, usedConfig);
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    gachaQueue.push({ message, process: processFn, config });
    processGachaQueue();
  });
}

async function handleNhentaiCommand(message, query, config, sort = 'popular') {
  return new Promise((resolve, reject) => {
    const processFn = async (queueConfig) => {
      try {
        const usedConfig = queueConfig || config;
        const post = await getRandomNhentaiPost(usedConfig, query, sort);

        if (!post) {
          logInteraction('gacha_result', { type: 'nhentai', query, sort, result: 'not_found' });
          await safeReply(message, query
            ? `No nhentai post found for query: ${query}`
            : 'No nhentai post found right now.');
          resolve();
          return;
        }

        logInteraction('gacha_result', { type: 'nhentai', query, sort, result: 'success', postId: post.id });
        await sendNhentaiEmbed(message, post);
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    gachaQueue.push({ message, process: processFn, config });
    processGachaQueue();
  });
}


// ─── Pollinations Image Generation (free) ──────────────────────────────────

const POLLINATIONS_HOST = 'image.pollinations.ai';

const POLLINATION_MODELS = {
  'flux': { id: 'flux', label: 'FLUX' },
  'flux-realism': { id: 'flux-realism', label: 'FLUX Realism' },
  'flux-anime': { id: 'flux-anime', label: 'FLUX Anime' },
  'flux-3d': { id: 'flux-3d', label: 'FLUX 3D' },
  'any-dark': { id: 'any-dark', label: 'Any Dark' },
  'turbo': { id: 'turbo', label: 'SDXL Turbo' },
  'sana': { id: 'sana', label: 'SANA' },
};

const POLLINATION_DEFAULT_MODEL = 'flux';

const POLLINATION_SIZES = {
  'square': { width: 1024, height: 1024 },
  'portrait': { width: 768, height: 1024 },
  'landscape': { width: 1280, height: 720 },
  'wide': { width: 1280, height: 720 },
  'tall': { width: 720, height: 1280 },
  'phone': { width: 720, height: 1280 },
  '1:1': { width: 1024, height: 1024 },
  '3:4': { width: 768, height: 1024 },
  '4:3': { width: 1024, height: 768 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
};

const POLLINATION_DEFAULT_SIZE = 'square';

/**
 * Resolve a hostname using a custom DNS resolver pointed at Cloudflare/Google
 * IPs (1.1.1.1, 8.8.8.8) via plain UDP DNS — completely bypasses the system
 * resolver and requires no HTTP/TLS at all.
 */
async function resolveViaCustomDns(hostname) {
  try {
    const ips = await dnsResolver.resolve4(hostname);
    return ips && ips.length > 0 ? ips[0] : null;
  } catch (_) {
    return null;
  }
}

/**
 * HTTPS request helper that pre-resolves the hostname via the custom UDP DNS
 * resolver and connects straight to the IP with correct SNI/Host headers.
 */
async function httpsRequestRaw(host, path, { headers = {}, method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  const resolvedIp = (await resolveViaCustomDns(host)) || host;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: resolvedIp,
        servername: host,
        path,
        method,
        headers: { Host: host, ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Request timed out setelah ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Generate an image via the free Pollinations API:
 *   GET https://image.pollinations.ai/prompt/{prompt}?model=..&width=..&height=..&nologo=true
 * Optional API key (config.pollinationsApiKey) for priority & paid models,
 * but this API runs FREE without a key.
 * Returns { buffer, contentType, modelId }.
 */
async function generateImagePollinations(config, prompt, modelKey = POLLINATION_DEFAULT_MODEL, sizeInput = POLLINATION_DEFAULT_SIZE, isFallback = false) {
  const model = POLLINATION_MODELS[modelKey] || POLLINATION_MODELS[POLLINATION_DEFAULT_MODEL];
  const size = (typeof sizeInput === 'object' && sizeInput && sizeInput.width && sizeInput.height)
    ? sizeInput
    : (POLLINATION_SIZES[sizeInput] || POLLINATION_SIZES[POLLINATION_DEFAULT_SIZE]);

  const hasApiKey = Boolean(config.pollinationsApiKey);
  const host = hasApiKey ? 'gen.pollinations.ai' : 'image.pollinations.ai';
  const endpoint = hasApiKey ? '/image' : '/prompt';

  const params = new URLSearchParams({
    model: model.id,
    width: String(size.width),
    height: String(size.height),
  });

  const headers = {};
  if (hasApiKey) {
    headers['Authorization'] = `Bearer ${config.pollinationsApiKey}`;
  }

  const path = `${endpoint}/${encodeURIComponent(prompt)}?${params.toString()}`;
  const res = await httpsRequestRaw(host, path, { headers, timeoutMs: config.imageGenTimeoutMs });

  if (res.statusCode !== 200) {
    let msg = '';
    try {
      const parsed = JSON.parse(res.buffer.toString());
      msg = (parsed.error && (parsed.error.message || parsed.error.detail)) || parsed.detail || parsed.message || '';
    } catch (_) {}
    if (!msg) msg = res.buffer.toString().slice(0, 200);

    // If a non-default model failed (e.g. upstream 429 rate limit or 500), auto-fallback to flux
    if (modelKey !== POLLINATION_DEFAULT_MODEL && !isFallback) {
      console.warn(`Pollinations model ${modelKey} failed (${res.statusCode}), falling back to ${POLLINATION_DEFAULT_MODEL}...`);
      return generateImagePollinations(config, prompt, POLLINATION_DEFAULT_MODEL, size, true);
    }

    throw new Error(`Pollinations error ${res.statusCode}: ${msg}`);
  }

  const contentType = res.headers['content-type'] || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    if (modelKey !== POLLINATION_DEFAULT_MODEL && !isFallback) {
      return generateImagePollinations(config, prompt, POLLINATION_DEFAULT_MODEL, size, true);
    }
    // Pollinations sometimes returns text/JSON even on HTTP 200 (e.g. prompt rejected by content filter)
    throw new Error(`Pollinations did not return an image (${contentType}): ${res.buffer.toString().slice(0, 200)}`);
  }

  const label = isFallback ? `${model.id} (fallback)` : model.id;
  return { buffer: res.buffer, contentType, modelId: label };
}

// ─── AI Horde Image Generation (free, NSFW, queued) ──────────────────────────

const HORDE_HOST = 'stablehorde.net';

// Curated models from active models on horde — only those with active workers
// and good reputation. res: 'xl' → requires higher resolution (more expensive kudos).
const HORDE_MODELS = {
  // ── Anime SD1.5 — cheap & fast (~6 kudos/image at 512²) ──
  'abyss':       { id: 'AbyssOrangeMix-AfterDark', group: 'anime', label: 'AbyssOrangeMix AfterDark' },
  'deliberate':  { id: 'Deliberate 3.0', group: 'anime', label: 'Deliberate 3.0' },
  'anything':    { id: 'Anything v5', group: 'anime', label: 'Anything v5' },
  'acertain':    { id: 'ACertainThing', group: 'anime', label: 'ACertainThing' },
  'grapefruit':  { id: 'Grapefruit Hentai', group: 'anime', label: 'Grapefruit Hentai' },
  'dreamshaper': { id: 'Dreamshaper', group: 'anime', label: 'Dreamshaper' },
  'lyriel':      { id: 'Lyriel', group: 'anime', label: 'Lyriel' },
  'ned':         { id: 'NeverEnding Dream', group: 'anime', label: 'NeverEnding Dream' },
  'mix526':      { id: '526Mix-Animated', group: 'anime', label: '526Mix-Animated' },
  'flat2d':      { id: 'Flat-2D Animerge', group: 'anime', label: 'Flat-2D Animerge' },
  'toonyou':     { id: 'ToonYou', group: 'anime', label: 'ToonYou' },

  // ── Anime XL / Pony / Illustrious — highest quality, more expensive ──
  'wai':         { id: 'WAI-NSFW-illustrious-SDXL', group: 'animexl', res: 'xl', label: 'WAI NSFW Illustrious SDXL' },
  'illustrious': { id: 'WAI-NSFW-illustrious-SDXL', group: 'animexl', res: 'xl', label: 'WAI NSFW Illustrious SDXL' },
  'waipony':     { id: 'WAI-ANI-NSFW-PONYXL', group: 'animexl', res: 'xl', label: 'WAI NSFW Pony XL' },
  'nova':        { id: 'Nova Anime XL', group: 'animexl', res: 'xl', label: 'Nova Anime XL' },
  'hassaku':     { id: 'Hassaku XL', group: 'animexl', res: 'xl', label: 'Hassaku XL' },
  'aam':         { id: 'AAM XL', group: 'animexl', res: 'xl', label: 'AAM XL' },
  'pony':        { id: 'AMPonyXL', group: 'animexl', res: 'xl', label: 'AMPonyXL' },
  'albedo':      { id: 'AlbedoBase XL 3.1', group: 'animexl', res: 'xl', label: 'AlbedoBase XL 3.1' },
  'animagine':   { id: 'Animagine XL', group: 'animexl', res: 'xl', label: 'Animagine XL' },
  'prefpony':    { id: 'Prefect Pony', group: 'animexl', res: 'xl', label: 'Prefect Pony' },
  'rag':         { id: 'Rag Illustrious Mix', group: 'animexl', res: 'xl', label: 'Rag Illustrious Mix' },
  'zavy':        { id: 'ZavyChromaXL', group: 'animexl', res: 'xl', label: 'ZavyChromaXL' },
  'anima':       { id: 'Anima-Turbo-v1.1', group: 'animexl', res: 'xl', label: 'Anima-Turbo v1.1' },

  // ── Realistic ──
  'real':        { id: 'AbsoluteReality', group: 'real', label: 'AbsoluteReality' },
  'rv':          { id: 'Realistic Vision', group: 'real', label: 'Realistic Vision' },
  'juggernaut':  { id: 'Juggernaut XL', group: 'real', res: 'xl', label: 'Juggernaut XL' },
  'icbinp':      { id: "ICBINP - I Can't Believe It's Not Photography", group: 'real', label: 'ICBINP (photorealistic)' },
  'icbinpxl':    { id: 'ICBINP XL', group: 'real', res: 'xl', label: 'ICBINP XL' },
  'natvis':      { id: 'NatViS', group: 'real', label: 'NatViS' },
  'realbiter':   { id: 'RealBiter', group: 'real', label: 'RealBiter' },
  'perfectworld':{ id: 'Perfect World', group: 'real', label: 'Perfect World' },
  'majicmix':    { id: 'majicMIX realistic', group: 'real', label: 'majicMIX realistic' },
  'edge':        { id: 'Edge Of Realism', group: 'real', label: 'Edge Of Realism' },
  'etherreal':   { id: 'Ether Real Mix', group: 'real', label: 'Ether Real Mix' },
  'woopwoop':    { id: 'Woop-Woop Photo', group: 'real', label: 'Woop-Woop Photo' },
  'cyberpony':   { id: 'CyberRealistic Pony', group: 'real', res: 'xl', label: 'CyberRealistic Pony' },

  // ── Furry ──
  'furry':       { id: 'BB95 Furry Mix v14', group: 'furry', label: 'BB95 Furry Mix v14' },
  'novafurry':   { id: 'Nova Furry XL', group: 'furry', res: 'xl', label: 'Nova Furry XL' },
  'yiff':        { id: "Lawlas's yiff mix", group: 'furry', label: "Lawlas's yiff mix" },

  // ── Experimental / fast ──
  'flux':        { id: 'Flux.1-Schnell fp8 (Compact)', group: 'exp', label: 'FLUX.1 Schnell fp8' },
  'krea':        { id: 'Krea2-Turbo_fp8', group: 'exp', label: 'Krea2 Turbo fp8' },
  'zturbo':      { id: 'Z-Image-Turbo', group: 'exp', label: 'Z-Image Turbo' },
  'sdbase':      { id: 'stable_diffusion', group: 'exp', label: 'Stable Diffusion 1.5 (base)' },
};

const HORDE_MODEL_GROUPS = [
  { key: 'anime',   name: 'Anime (cheap, fast)' },
  { key: 'animexl', name: 'Anime XL/Pony (high quality)' },
  { key: 'real',    name: 'Realistic' },
  { key: 'furry',   name: 'Furry' },
  { key: 'exp',     name: 'Experimental / fast' },
];

const HORDE_DEFAULT_MODEL = 'abyss';

const HORDE_SIZES = {
  'square': { width: 512, height: 512 },
  'portrait': { width: 576, height: 768 },
  'landscape': { width: 768, height: 448 },
  'wide': { width: 768, height: 448 },
  'tall': { width: 448, height: 768 },
  'phone': { width: 448, height: 768 },
  '1:1': { width: 512, height: 512 },
  '3:4': { width: 576, height: 768 },
  '4:3': { width: 768, height: 576 },
  '16:9': { width: 768, height: 448 },
  '9:16': { width: 448, height: 768 },
};

const HORDE_DEFAULT_SIZE = 'square';
const HORDE_DEFAULT_STEPS = 20;
const HORDE_MIN_STEPS = 8;
const HORDE_MAX_STEPS = 40;

// Estimated horde kudos cost ≈ (width * height * steps) / 1e6
function estimateHordeKudos(width, height, steps) {
  return Math.max(1, Math.ceil((width * height * steps) / 1000000));
}

// XL models degrade at low resolutions — scale 1.5x, round to nearest multiple of 64
function scaleHordeSize(width, height, scale) {
  if (!scale || scale === 1) return { width, height };
  const round64 = (n) => Math.max(64, Math.round((n * scale) / 64) * 64);
  return { width: round64(width), height: round64(height) };
}

function formatHordeModelList() {
  return HORDE_MODEL_GROUPS.map((g) => {
    const keys = Object.keys(HORDE_MODELS).filter((k) => HORDE_MODELS[k].group === g.key);
    return `${g.name}: ${keys.join(', ')}`;
  }).join('\n    ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHordeError(res, stage) {
  let msg = '';
  try {
    const parsed = JSON.parse(res.buffer.toString());
    msg = (parsed.message || (parsed.errors && parsed.errors.apikey) || '').toString();
  } catch (_) {}
  if (!msg) msg = res.buffer.toString().slice(0, 200);
  switch (res.statusCode) {
    case 401:
      return new Error('Horde: API key rejected (401) — check hordeApiKey in config.json.');
    case 429:
      return new Error('Horde: rate limit / insufficient kudos (429). Try again later.');
    default:
      return new Error(`Horde error ${res.statusCode} during ${stage}: ${msg}`);
  }
}

function formatHordeEta(sec) {
  if (!sec || sec <= 0) return null;
  if (sec < 60) return `${Math.max(1, Math.round(sec))} seconds`;
  return `${Math.ceil(sec / 60)} minutes`;
}

function formatElapsed(sec) {
  if (!sec || sec < 0) return '0 seconds';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} seconds`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m} minutes ${s} seconds` : `${m} minutes`;
}

async function updateHordeStatus(statusMsg, info, prompt, modelKey, sizeKey) {
  if (!statusMsg) return;
  const eta = formatHordeEta(info.waitTimeSec);
  const pos = typeof info.queuePosition === 'number' ? info.queuePosition : null;

  let queueLine;
  if (pos !== null && pos > 0) {
    queueLine = `Queue: **${pos} ahead**`;
    if (typeof info.processing === 'number' && info.processing > 0) queueLine += ` (${info.processing} processing)`;
    queueLine += ` | Estimated: **~${eta || 'a few minutes'}**`;
  } else if (pos === 0) {
    queueLine = `Processing by worker...${eta ? ` (approx. **~${eta}**)` : ''}`;
  } else {
    queueLine = 'Finding queue position...';
  }

  const label = HORDE_MODELS[modelKey] ? HORDE_MODELS[modelKey].label : modelKey;
  const header = `Generating image... (AI Horde, model: \`${label}\`, size: \`${sizeKey}\`)`;
  const elapsed = typeof info.elapsedSec === 'number' ? `\nElapsed: ${formatElapsed(info.elapsedSec)}` : '';
  const promptLine = `\nPrompt: \`${prompt.slice(0, 200)}\``;
  try {
    await statusMsg.edit(`${header}\n${queueLine}${elapsed}${promptLine}`);
  } catch (_) {
    // Status message already deleted / cannot be edited — ignore
  }
}

function detectImageContentType(buffer) {
  if (!buffer || buffer.length < 12) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  return 'image/jpeg';
}

function getImageExtension(contentType) {
  if (!contentType) return 'jpg';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}

/**
 * Generate an image via AI Horde (free community GPU network, NSFW-friendly).
 * Anonymous (empty hordeApiKey / key "0000000000") is given lowest priority
 * and queue can take 5-15+ minutes. Polls status until completed.
 * onStatus(info) is called on each poll: { queuePosition, processing, waitTimeSec, elapsedSec }.
 * Returns { buffer, contentType, modelId }.
 */
async function generateImageHorde(config, prompt, modelKey = HORDE_DEFAULT_MODEL, sizeInput = HORDE_DEFAULT_SIZE, onStatus = null, steps = HORDE_DEFAULT_STEPS, retriesLeft = 1) {
  const model = HORDE_MODELS[modelKey] || HORDE_MODELS[HORDE_DEFAULT_MODEL];
  const baseSize = (typeof sizeInput === 'object' && sizeInput && sizeInput.width && sizeInput.height)
    ? sizeInput
    : (HORDE_SIZES[sizeInput] || HORDE_SIZES[HORDE_DEFAULT_SIZE]);
  const size = scaleHordeSize(baseSize.width, baseSize.height, model.res === 'xl' ? 1.5 : 1);
  const stepCount = Math.min(HORDE_MAX_STEPS, Math.max(HORDE_MIN_STEPS, Number(steps) || HORDE_DEFAULT_STEPS));
  const kudosCost = estimateHordeKudos(size.width, size.height, stepCount);
  const apiKey = config.hordeApiKey || '0000000000';
  const timeoutMs = config.hordeTimeoutMs || 600000;
  const authHeaders = { apikey: apiKey, 'Content-Type': 'application/json' };

  // 1) Submit job to queue
  const payload = {
    prompt,
    params: { width: size.width, height: size.height, steps: stepCount, sampler_name: 'k_euler', cfg_scale: 7 },
    models: [model.id],
    nsfw: true,
    censor_nsfw: false,
  };
  const submit = await httpsRequestRaw(HORDE_HOST, '/api/v2/generate/async', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(payload),
    timeoutMs: 30000,
  });
  if (submit.statusCode !== 202) throw buildHordeError(submit, 'submit');

  let submitData;
  try {
    submitData = JSON.parse(submit.buffer.toString());
  } catch (_) {
    throw new Error('Horde: invalid submit response.');
  }
  const jobId = submitData.id;
  if (!jobId) throw new Error('Horde: no job id in submit response.');

  // 2) Polling status sampai done
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const pollEveryMs = 20000;
  while (Date.now() < deadline) {
    await sleep(pollEveryMs);

    const status = await httpsRequestRaw(HORDE_HOST, `/api/v2/generate/status/${jobId}`, {
      headers: authHeaders,
      timeoutMs: 30000,
    });
    if (status.statusCode === 404) throw new Error('Horde: job not found (404). Try again.');

    let statusData = null;
    try {
      statusData = JSON.parse(status.buffer.toString());
    } catch (_) {}

    if (statusData) {
      if (statusData.faulted) throw new Error('Horde: job failed to process. Try again later.');
      if (statusData.done) {
        const gen = statusData.generations && statusData.generations[0];
        if (!gen || !gen.img) throw new Error('Horde: completed but no image in result.');

        let isCensored = Boolean(gen.censored);
        let buffer;
        if (typeof gen.img === 'string' && (gen.img.startsWith('http://') || gen.img.startsWith('https://'))) {
          const imgUrl = new URL(gen.img);
          const dlRes = await httpsRequestRaw(imgUrl.host, imgUrl.pathname + imgUrl.search, { timeoutMs: 30000 });
          if (dlRes.statusCode !== 200) {
            throw new Error(`Horde: failed to download image from storage (${dlRes.statusCode}).`);
          }
          buffer = dlRes.buffer;
        } else {
          buffer = Buffer.from(gen.img, 'base64');
        }

        // Worker censor check: a black placeholder image is tiny (< 2KB)
        if (buffer.length < 2000) {
          isCensored = true;
        }

        if (isCensored) {
          if (retriesLeft > 0) {
            console.warn(`Horde worker returned black/censored image for ${modelKey}. Retrying with another worker...`);
            return generateImageHorde(config, prompt, modelKey, sizeInput, onStatus, steps, retriesLeft - 1);
          }
          throw new Error('Horde: Worker node replaced the image with a black screen (safety filter triggered by worker). Please re-run or try another model.');
        }

        const contentType = detectImageContentType(buffer);
        return { buffer, contentType, modelId: model.id, kudos: kudosCost, width: size.width, height: size.height };
      }
      if (typeof onStatus === 'function') {
        try {
          await onStatus({
            queuePosition: statusData.queue_position,
            processing: statusData.processing,
            waitTimeSec: Math.round(statusData.wait_time || 0),
            elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          });
        } catch (_) {}
      }
    }
  }

  throw new Error(`Horde: timeout waiting for result (${Math.round(timeoutMs / 60000)} minutes). Free queue can be long — try again later.`);
}

async function handleGenCommand(message, args, config) {
  // Parse flags: --provider <pollinations|horde> | --horde, --model <name>, --size <name>, --steps <n>
  let provider = null;
  const argsCopy = [...args];

  const providerFlagIdx = argsCopy.indexOf('--provider');
  if (providerFlagIdx !== -1 && argsCopy[providerFlagIdx + 1]) {
    provider = argsCopy[providerFlagIdx + 1].toLowerCase();
    argsCopy.splice(providerFlagIdx, 2);
  }
  const hordeFlagIdx = argsCopy.indexOf('--horde');
  if (hordeFlagIdx !== -1) {
    provider = 'horde';
    argsCopy.splice(hordeFlagIdx, 1);
  }

  let modelKey = null;
  const modelFlagIdx = argsCopy.indexOf('--model');
  if (modelFlagIdx !== -1 && argsCopy[modelFlagIdx + 1]) {
    modelKey = argsCopy[modelFlagIdx + 1].toLowerCase();
    argsCopy.splice(modelFlagIdx, 2);
  }

  // Auto-detect provider from model if not explicitly specified
  if (!provider) {
    if (modelKey && HORDE_MODELS[modelKey]) {
      provider = 'horde';
    } else if (modelKey && POLLINATION_MODELS[modelKey]) {
      provider = 'pollinations';
    } else {
      provider = 'pollinations'; // default
    }
  }

  const isHorde = provider === 'horde';
  if (provider !== 'pollinations' && provider !== 'horde') {
    await safeReply(message, `Provider not recognized: \`${provider}\`\nAvailable: pollinations (default, instant) | horde (NSFW free, queue).\nContoh: \`b.gen maid seductive --provider horde\``);
    return;
  }

  const MODELS = isHorde ? HORDE_MODELS : POLLINATION_MODELS;
  const DEFAULT_MODEL = isHorde ? HORDE_DEFAULT_MODEL : POLLINATION_DEFAULT_MODEL;
  const SIZES = isHorde ? HORDE_SIZES : POLLINATION_SIZES;
  const DEFAULT_SIZE = isHorde ? HORDE_DEFAULT_SIZE : POLLINATION_DEFAULT_SIZE;

  let sizeKey = DEFAULT_SIZE;
  let steps = HORDE_DEFAULT_STEPS;

  if (!modelKey) {
    modelKey = DEFAULT_MODEL;
  } else if (!MODELS[modelKey]) {
    const otherProvider = isHorde ? 'pollinations' : 'horde';
    const otherModels = isHorde ? POLLINATION_MODELS : HORDE_MODELS;
    let hint = '';
    if (otherModels[modelKey]) {
      hint = `\n\n*Note: Model \`${modelKey}\` is available on provider **${otherProvider}**. Use \`--provider ${otherProvider}\` or omit the flag to auto-select.*`;
    }
    const validKeys = isHorde ? formatHordeModelList() : Object.keys(MODELS).join(', ');
    await safeReply(message, `Model not recognized: \`${modelKey}\`\nAvailable models (${provider}):\n    ${validKeys}${hint}`);
    return;
  }

  const sizeFlagIdx = argsCopy.indexOf('--size');
  let customSize = null;
  if (sizeFlagIdx !== -1 && argsCopy[sizeFlagIdx + 1]) {
    const rawSize = argsCopy[sizeFlagIdx + 1].toLowerCase();
    argsCopy.splice(sizeFlagIdx, 2);

    const dimMatch = rawSize.match(/^(\d{2,4})x(\d{2,4})$/);
    if (dimMatch) {
      let w = Math.min(2048, Math.max(128, Number(dimMatch[1])));
      let h = Math.min(2048, Math.max(128, Number(dimMatch[2])));
      if (isHorde) {
        w = Math.max(64, Math.round(w / 64) * 64);
        h = Math.max(64, Math.round(h / 64) * 64);
      }
      customSize = { width: w, height: h };
      sizeKey = `${w}x${h}`;
    } else if (SIZES[rawSize]) {
      sizeKey = rawSize;
      customSize = SIZES[rawSize];
    } else {
      const validSizes = 'square (1:1), portrait (3:4), landscape/wide (16:9), tall/phone (9:16), or custom <width>x<height>';
      await safeReply(message, `Size not recognized: \`${rawSize}\`\nAvailable sizes: ${validSizes}`);
      return;
    }
  } else {
    customSize = SIZES[DEFAULT_SIZE];
  }

  // --steps (horde only) — Fewer steps = less kudos used
  const stepsFlagIdx = argsCopy.indexOf('--steps');
  if (stepsFlagIdx !== -1 && argsCopy[stepsFlagIdx + 1]) {
    const rawSteps = Number(argsCopy[stepsFlagIdx + 1]);
    argsCopy.splice(stepsFlagIdx, 2);
    if (!Number.isFinite(rawSteps) || rawSteps < HORDE_MIN_STEPS || rawSteps > HORDE_MAX_STEPS) {
      await safeReply(message, `The --steps value must be a number between ${HORDE_MIN_STEPS} and ${HORDE_MAX_STEPS} (default ${HORDE_DEFAULT_STEPS}).\nFewer steps = less kudos used, slightly lower quality.`);
      return;
    }
    steps = Math.round(rawSteps);
  }

  const prompt = argsCopy.join(' ').trim();
  if (!prompt) {
    await safeReply(message, `Please provide a prompt to generate an image.\nExample: \`b.gen a beautiful anime girl\``);
    return;
  }

  const providerLabel = isHorde ? 'AI Horde' : 'Pollinations';
  const modelDef = isHorde ? (HORDE_MODELS[modelKey] || {}) : {};
  // Calculate first so user knows how many kudos will be used
  const effSize = isHorde ? scaleHordeSize(customSize.width, customSize.height, modelDef.res === 'xl' ? 1.5 : 1) : customSize;
  const kudosInfo = isHorde ? ` | ~${estimateHordeKudos(effSize.width, effSize.height, steps)} kudos | steps: ${steps}` : '';
  const resInfo = `\nResolution: ${effSize.width}×${effSize.height}${isHorde && modelDef.res === 'xl' ? ' (XL auto-upscale)' : ''}`;

  // If channel not Age Restricted, Discord auto-scans & blocks NSFW media
  // (image becomes a 97-byte placeholder, attachment dropped). Warn upfront.
  const ageRestricted = !message.channel || typeof message.channel.nsfw !== 'boolean' || message.channel.nsfw;
  const ageWarn = isHorde && !ageRestricted
    ? '\nThis channel is not **Age Restricted** — Discord will likely block NSFW images. Run `b.nsfw` (requires `Manage Channels`).'
    : '';

  // Status "generating..."
  let statusMsg;
  try {
    statusMsg = await message.reply(`Generating image... (${providerLabel}, model: \`${modelKey}\`, size: \`${sizeKey}\`${kudosInfo})\nPrompt: \`${prompt.slice(0, 200)}\`${resInfo}${isHorde ? '\nAI Horde is free with a public queue — may take 5-15 minutes.' : ''}${ageWarn}`);
  } catch (_) {}

  try {
    logInteraction('gen_request', {
      user: { id: message.author.id, username: message.author.username },
      prompt,
      provider,
      model: modelKey,
      size: sizeKey,
      steps: isHorde ? steps : undefined,
    });

    const result = isHorde
      ? await generateImageHorde(config, prompt, modelKey, customSize, (info) => updateHordeStatus(statusMsg, info, prompt, modelKey, sizeKey), steps)
      : await generateImagePollinations(config, prompt, modelKey, customSize);
    const { buffer, contentType, modelId } = result;

    const ext = getImageExtension(contentType);
    const filename = `generated.${ext}`;

    const embed = new EmbedBuilder()
      .setTitle('Generated Image')
      .setDescription(`**Prompt:** ${prompt.slice(0, 1024)}`)
      .addFields(
        { name: 'Provider', value: providerLabel, inline: true },
        { name: 'Model', value: `\`${modelId}\``, inline: true },
        { name: 'Requested by', value: `<@${message.author.id}>`, inline: true }
      )
      .setImage(`attachment://${filename}`)
      .setFooter({ text: (isHorde && !ageRestricted)
        ? 'Channel not Age Restricted — Discord may block the image'
        : (isHorde ? 'Generated via AI Horde (free)' : 'Generated via Pollinations (free)') });

    try {
      await message.reply({
        embeds: [embed],
        files: [{ attachment: buffer, name: filename }],
      });
    } catch (sendError) {
      if (sendError && sendError.code === 50013) {
        console.warn(`Cannot send image in channel ${message.channelId}: Missing Permissions`);
        // Do not silently fail: inform the user why the image cannot be delivered
        logInteraction('gen_result', { prompt, provider, model: modelKey, result: 'send_denied', message: 'Missing Permissions (50013)' });
        await safeReply(message, 'Image generated, but the bot cannot send it — missing `Attach Files` / `Send Messages` permissions in this channel.\n   Ask an admin to grant permissions, then try again.');
        return;
      }
      throw sendError;
    }

    logInteraction('gen_result', { prompt, provider, model: modelKey, result: 'success' });
  } catch (error) {
    logInteraction('gen_result', { prompt, provider, model: modelKey, result: 'error', message: error.message });
    console.error('Image generation error:', error);
    let userMsg = error.message;
    if (userMsg.includes('community_model_rate_limit') || userMsg.includes('429')) {
      userMsg = 'Model is currently rate-limited upstream. Please try again in a moment or use another model (e.g. `flux`).';
    }
    await safeReply(message, `Failed to generate image: ${userMsg}`);
  } finally {
    if (statusMsg) {
      try { await statusMsg.delete(); } catch (_) {}
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function buildHelp(prefix, botUser = null) {
  const hordeModelsFormatted = HORDE_MODEL_GROUPS.map((g) => {
    const keys = Object.keys(HORDE_MODELS).filter((k) => HORDE_MODELS[k].group === g.key);
    return `- **${g.name}:** ${keys.map((k) => `\`${k}\``).join(', ')}`;
  }).join('\n');

  const pollinationsModels = Object.keys(POLLINATION_MODELS).map((k) => `\`${k}\``).join(', ');
  const pollinationsSizes = Object.keys(POLLINATION_SIZES).map((k) => `\`${k}\``).join(', ');
  const hordeSizes = Object.keys(HORDE_SIZES).map((k) => `\`${k}\``).join(', ');

  const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('Bandar Bot — Commands & Guide')
    .setDescription(
      `Discord bot for NSFW Gacha & AI Image Generation.\n` +
      `Use prefix \`${prefix}\` before every command (e.g. \`${prefix}help\`).`
    )
    .addFields(
      {
        name: 'Channel Authorization',
        value:
          `\`${prefix}nsfw\`\n` +
          `Toggle bot access in this channel and sync Discord Age-Restricted status *(requires **Manage Channels** permission)*.`,
      },
      {
        name: 'Gacha Commands',
        value:
          `- \`${prefix}gacha [query]\` — Random gacha across all platforms\n` +
          `- \`${prefix}34gacha\` / \`${prefix}34g [tags...]\` — Random post from **Rule34**\n` +
          `- \`${prefix}nhgacha\` / \`${prefix}nh [query] [--sort <popular|recent>]\` — Doujin from **nHentai**\n` +
          `- \`${prefix}poigacha\` / \`${prefix}poi [query]\` — Video/hentai from **Nekopoi**`,
      },
      {
        name: 'Rule34 Tags & Filters',
        value:
          `- **Tag combination:** \`${prefix}34g 2girls blue_hair\`\n` +
          `- **Exclude tag:** \`${prefix}34g -ai_generated\`\n` +
          `- **Sort by score:** \`${prefix}34g sort:score\` or \`sort:favcount\`\n` +
          `- **Rating filter:** \`rating:safe\` | \`rating:questionable\` | \`rating:explicit\`\n` +
          `*(Other Rule34 search operators are supported directly)*`,
      },
      {
        name: 'AI Image Generator (`b.gen`)',
        value:
          `**Syntax:** \`${prefix}gen <prompt> [options...]\` *(alias: \`${prefix}generate\`)*\n\n` +
          `**Providers:**\n` +
          `- **\`pollinations\`** *(Default)*: Fast, free & instant (SFW filter active).\n` +
          `- **\`horde\`**: AI Horde, **unfiltered NSFW**, public community queue (~5-15 min).`,
      },
      {
        name: 'Parameters for `b.gen`',
        value:
          `- \`--provider <pollinations|horde>\` — Select AI provider *(auto-detected from model)*\n` +
          `- \`--model <model>\` — Select generator model *(see list below)*\n` +
          `- \`--size <size>\` — Preset ratios: \`square\` (1:1), \`portrait\` (3:4), \`landscape\` / \`wide\` (16:9), \`tall\` (9:16), or custom \`<width>x<height>\` (e.g. \`1920x1080\`)\n` +
          `- \`--steps <${HORDE_MIN_STEPS}-${HORDE_MAX_STEPS}>\` — Horde sampling steps *(default: ${HORDE_DEFAULT_STEPS})*`,
      },
      {
        name: 'Available AI Models',
        value:
          `**Pollinations:** ${pollinationsModels}\n\n` +
          `**AI Horde (Uncensored):**\n` +
          `${hordeModelsFormatted}`,
      },
      {
        name: 'Usage Examples',
        value:
          `\`\`\`bash\n` +
          `${prefix}34g 2girls blue_hair sort:score\n` +
          `${prefix}nh overflow --sort popular\n` +
          `${prefix}poi isekai\n` +
          `${prefix}gen anime maid --provider horde --model abyss --size portrait\n` +
          `${prefix}gen 1girl, cyberpunk --model wai --size portrait\n` +
          `\`\`\``,
      }
    )
    .setFooter({
      text: `Bandar Bot • Type ${prefix}help at any time to open this guide`,
    })
    .setTimestamp();

  if (botUser && typeof botUser.displayAvatarURL === 'function') {
    embed.setThumbnail(botUser.displayAvatarURL());
  }

  return { embeds: [embed] };
}

async function safeReply(message, content) {
  try {
    let payload = content;
    if (content instanceof EmbedBuilder || (content && typeof content === 'object' && content.data && !content.embeds)) {
      payload = { embeds: [content] };
    }
    await message.reply(payload);
  } catch (error) {
    const detail = error && error.code === 50013
      ? 'Missing Permissions (50013) — bot lacks Send Messages/Embed Links permission in this channel.'
      : (error && error.message ? error.message : String(error));
    console.warn(`Cannot reply to message in channel ${message.channelId}: ${detail}`);
    try {
      logInteraction('error', { context: 'safe_reply', channelId: message.channelId, message: detail });
    } catch (_) {}
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
      logInteraction('error', { context: 'queue_processing', message: error.message });
      if (item.message && !item.message.deleted) {
        await safeReply(item.message, 'Command failed. Check bot logs and config.');
      }
    }
  }

  isProcessingQueue = false;
}

async function handleGachaCommand(message, tags, config) {
  return new Promise((resolve, reject) => {
    const processFn = async (queueConfig) => {
      try {
        const usedConfig = queueConfig || config;
        const post = await getRandomRule34Post(usedConfig, tags);

        if (post === 'FILTERED_AI') {
          logInteraction('gacha_result', { type: 'rule34', tags, result: 'filtered_ai' });
          await safeReply(message, 'All results found have been filtered as they were identified as AI-generated content. We do not provide non-authentic works.');
          resolve();
          return;
        }

        if (!post) {
          logInteraction('gacha_result', { type: 'rule34', tags, result: 'not_found' });
          await safeReply(message, tags.length > 0
            ? `No Rule34 post found for tags: ${tags.join(', ')}`
            : 'No Rule34 post found right now.');
          resolve();
          return;
        }

        logInteraction('gacha_result', { type: 'rule34', tags, result: 'success', postId: post.id });
        await sendRule34Embed(message, post);
        resolve();
      } catch (error) {
        reject(error);
      }
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

// ─── Self-Destruct Server (Nuke) ─────────────────────────────────────────────
// Step-by-step flow:
//   1. Owner/Admin runs `b.nuke`                 → bot requests nuclear code via DM.
//   2. Owner sends nuclear code to bot DM        → message deleted, code verified.
//   3. Bot asks confirmation                     → owner runs `b.nuke confirm`.
//   4. Countdown 10 seconds (cancelable via `b.nuke abort`) → all channels deleted.
//
// Nuclear code is SECRET: stored in config.json ("nukePassword") or
// environment variable NUKE_PASSWORD. Never shown in help/README.
const NUKE_SESSION_TTL_MS = 120000;      // session expiration (password / confirmation)
const NUKE_COUNTDOWN_SECONDS = 10;       // countdown duration
const NUKE_MAX_PASSWORD_ATTEMPTS = 3;    // max incorrect password attempts

let discordClient = null;                // populated in main(), used for channel broadcasts
const nukeSessions = new Map();          // userId -> session

function getNukePassword(config) {
  return process.env.NUKE_PASSWORD || (config && config.nukePassword) || '';
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function clearNukeSession(session) {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  if (session.countdownInterval) clearInterval(session.countdownInterval);
  nukeSessions.delete(session.userId);
}

function scheduleNukeExpiry(session, ms) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => clearNukeSession(session), ms);
  if (typeof session.timer.unref === 'function') session.timer.unref();
}

async function notifyNukeSession(session, text) {
  if (!discordClient) return;
  try {
    const channel = await discordClient.channels.fetch(session.channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(text);
    }
  } catch (_) {
    // Channel no longer exists / not accessible — abaikan.
  }
}

// Step 1: `b.nuke [seconds]` — request nuclear code via DM.
async function handleNukeStart(message, args, config) {
  const guild = message.guild;

  const isGuildOwner = guild.ownerId === message.author.id;
  const isAdmin = Boolean(
    message.member && message.member.permissions.has(PermissionFlagsBits.Administrator)
  );
  if (!isGuildOwner && !isAdmin) {
    await safeReply(
      message,
      '**Access denied.** This command is restricted to **Server Owner** or members with **Administrator** permission.'
    );
    return;
  }

  if (!getNukePassword(config)) {
    await safeReply(
      message,
      'Self-destruct is not configured. Set a secret code via `nukePassword` in config.json or `NUKE_PASSWORD` env.'
    );
    return;
  }

  let countdownSeconds = Number.isFinite(Number(config.nukeCountdownSeconds)) && Number(config.nukeCountdownSeconds) >= 0 ? Number(config.nukeCountdownSeconds) : NUKE_COUNTDOWN_SECONDS;
  if (args && args.length > 0) {
    const rawSec = parseInt(args[0], 10);
    if (!isNaN(rawSec) && rawSec >= 0 && rawSec <= 300) {
      countdownSeconds = rawSec;
    } else {
      await safeReply(message, 'Countdown must be between 0 and 300 seconds (0 = instant / no countdown). Example: `b.nuke 0`');
      return;
    }
  }

  const existing = nukeSessions.get(message.author.id);
  if (existing) clearNukeSession(existing);

  const session = {
    userId: message.author.id,
    guildId: guild.id,
    guildName: guild.name,
    channelId: message.channelId,
    countdownSeconds,
    stage: 'awaiting_password',
    attempts: 0,
    timer: null,
    countdownInterval: null,
  };
  nukeSessions.set(session.userId, session);
  scheduleNukeExpiry(session, NUKE_SESSION_TTL_MS);

  logInteraction('nuke_init', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: guild.id, name: guild.name },
    countdownSeconds,
  });

  const countdownText = countdownSeconds === 0 ? 'no countdown (instant)' : `countdown: ${countdownSeconds}s`;

  await safeReply(
    message,
    `**Self-destruct initiated (${countdownText}).**\n` +
      'For verification, send the **nuclear code** to this **bot\'s DM**.\n' +
      'Session expires in 2 minutes.'
  );

  try {
    await message.author.send(
      `Enter your **nuclear code** to confirm self-destruct (${countdownText}).\n` +
        'This message will be deleted automatically for security.'
    );
  } catch (error) {
    logInteraction('error', {
      context: 'nuke_dm_send',
      userId: message.author.id,
      message: error && error.message ? error.message : String(error),
    });
    await safeReply(
      message,
      'Bot cannot send you a DM (your DMs might be closed).\n   Please open bot DMs and send the nuclear code there.'
    );
  }
}

// Step 2: DM message containing nuclear code.
async function handleNukeDm(message, config) {
  const session = nukeSessions.get(message.author.id);
  if (!session || session.stage !== 'awaiting_password') {
    return; // not part of nuke session — ignore.
  }

  const candidate = message.content.trim();

  // Delete message containing code from DM so it's not stored.
  try {
    await message.delete();
  } catch (_) {}

  const password = getNukePassword(config);
  if (!password || !timingSafeEqualStr(candidate, password)) {
    session.attempts += 1;

    if (session.attempts >= NUKE_MAX_PASSWORD_ATTEMPTS) {
      clearNukeSession(session);
      await message.author.send('Incorrect nuclear code 3 times. Self-destruct cancelled.').catch(() => {});
      await notifyNukeSession(
        session,
        `<@${message.author.id}> — nuclear code **INCORRECT** ${NUKE_MAX_PASSWORD_ATTEMPTS}x. Self-destruct cancelled.`
      );
      return;
    }

    const remaining = NUKE_MAX_PASSWORD_ATTEMPTS - session.attempts;

    await message.author
      .send(
        `Nuclear code **INCORRECT** (attempt ${session.attempts}/${NUKE_MAX_PASSWORD_ATTEMPTS}, ${remaining} left). Try again.`
      )
      .catch(() => {});

    await notifyNukeSession(
      session,
      `<@${message.author.id}> — nuclear code **INCORRECT** (attempt ${session.attempts}/${NUKE_MAX_PASSWORD_ATTEMPTS}, ${remaining} left). Self-destruct paused.`
    );
    return;
  }

  // Correct password -> confirmation stage.
  session.stage = 'awaiting_confirm';
  scheduleNukeExpiry(session, NUKE_SESSION_TTL_MS);

  const countdown = typeof session.countdownSeconds === 'number' ? session.countdownSeconds : NUKE_COUNTDOWN_SECONDS;
  const startDesc = countdown === 0 ? 'instantly execute self-destruct' : `start the ${countdown}-second countdown`;

  logInteraction('nuke_password_ok', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: session.guildId, name: session.guildName },
  });

  await message.author
    .send(
      '**Nuclear code CORRECT.**\n' +
        'Return to the server and confirm: **Are you sure you want to destroy this server?**\n' +
        `Run \`b.nuke confirm\` within 2 minutes to ${startDesc}.`
    )
    .catch(() => {});

  await notifyNukeSession(
    session,
    `<@${message.author.id}> — nuclear code **CORRECT**.\n**Are you sure you want to destroy this server?**\nRun \`b.nuke confirm\` within 2 minutes to ${startDesc}.`
  );
}

// Step 3 + 4: `b.nuke confirm` — password verified, starting countdown / instant.
async function handleNukeConfirm(message, config) {
  const session = nukeSessions.get(message.author.id);
  if (!session || session.stage !== 'awaiting_confirm') {
    await safeReply(message, 'No pending self-destruct awaiting confirmation. Run `b.nuke` first.');
    return;
  }

  if (session.guildId !== message.guildId || session.channelId !== message.channelId) {
    await safeReply(message, 'Confirmation must be run in the channel where `b.nuke` was started.');
    return;
  }

  const isGuildOwner = message.guild.ownerId === message.author.id;
  const isAdmin = Boolean(
    message.member && message.member.permissions.has(PermissionFlagsBits.Administrator)
  );
  if (!isGuildOwner && !isAdmin) {
    await safeReply(message, 'Access denied. Requires **Server Owner** or **Administrator** permission.');
    return;
  }

  if (session.countdownInterval) {
    await safeReply(message, 'Countdown is already running.');
    return;
  }

  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  session.stage = 'countdown';

  logInteraction('nuke_countdown', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: session.guildId, name: session.guildName },
  });

  let remaining = typeof session.countdownSeconds === 'number'
    ? session.countdownSeconds
    : (typeof config.nukeCountdownSeconds === 'number' ? config.nukeCountdownSeconds : NUKE_COUNTDOWN_SECONDS);

  // If 0 seconds (no countdown / instant) -> execute immediately!
  if (remaining <= 0) {
    nukeSessions.delete(session.userId);
    await safeReply(message, '**INITIATE-HUMAN-INSTRUMENTALITY** — Deleting all channels and roles immediately...');
    await executeNuke(message.guild, message.channelId, { user: message.author });
    return;
  }

  const statusMsg = await message.reply(
    `**Self-destruct starting in ${remaining} seconds.**\nCancel with \`b.nuke abort\`.`
  );
  session.countdownMessage = statusMsg;

  session.countdownInterval = setInterval(async () => {
    // Cancelled / session replaced?
    if (nukeSessions.get(session.userId) !== session || session.stage !== 'countdown') {
      clearInterval(session.countdownInterval);
      session.countdownInterval = null;
      return;
    }

    remaining -= 1;

    if (remaining > 0) {
      try {
        await statusMsg.edit(
          `Self-destruct in **${remaining}** seconds...\nCancel with \`b.nuke abort\`.`
        );
      } catch (_) {}
      return;
    }

    clearInterval(session.countdownInterval);
    session.countdownInterval = null;

    // Re-check: owner might have pressed abort during the await above.
    if (nukeSessions.get(session.userId) !== session) {
      return;
    }

    try {
      await statusMsg.edit('**INITIATE-HUMAN-INSTRUMENTALITY** — Deleting all channels and roles now...');
    } catch (_) {}

    // Double-check before final execution (abort can trigger during edit).
    if (nukeSessions.get(session.userId) !== session) {
      return;
    }

    nukeSessions.delete(session.userId);
    await executeNuke(message.guild, message.channelId, { user: message.author });
  }, 1000);
}

// `b.nuke abort` — cancel countdown / session.
async function handleNukeAbort(message) {
  const session = nukeSessions.get(message.author.id);
  if (!session) {
    await safeReply(message, 'No active self-destruct process.');
    return;
  }

  const wasCountingDown = session.stage === 'countdown';
  clearNukeSession(session);

  logInteraction('nuke_abort', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: session.guildId, name: session.guildName },
    stage: wasCountingDown ? 'countdown' : session.stage,
  });

  await safeReply(
    message,
    wasCountingDown
      ? '**Countdown cancelled.** Self-destruct not continued.'
      : 'Self-destruct process cancelled.'
  );
}

// Final execution: delete all channels (messages deleted as well) then all roles.
async function executeNuke(guild, invokeChannelId, meta = {}) {
  let channelsDeleted = 0;
  let channelsFailed = 0;
  let rolesDeleted = 0;
  let rolesFailed = 0;
  let rolesSkipped = 0;

  logInteraction('nuke_start', {
    user: meta.user ? { id: meta.user.id, username: meta.user.username } : undefined,
    guild: { id: guild.id, name: guild.name },
  });

  // 1) Delete all channels (messages inside them also deleted).
  try {
    const channels = await guild.channels.fetch();

    // The channel where the command was invoked is deleted last.
    const ordered = [...channels.values()].sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      if (a.id === invokeChannelId) return 1;
      if (b.id === invokeChannelId) return -1;
      return 0;
    });

    for (const channel of ordered) {
      if (!channel) continue;
      try {
        await channel.delete('Self-destruct (INITIATE-HUMAN-INSTRUMENTALITY)');
        channelsDeleted += 1;
      } catch (error) {
        channelsFailed += 1;
        console.warn(`Nuke: failed to delete channel ${channel.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Nuke (channels) error:', error);
  }

  // 2) Delete all deletable roles.
  //    - @everyone cannot be deleted.
  //    - Role "managed" (bot/integration) cannot be deleted.
  //    - Role with position >= bot's highest role cannot be deleted.
  try {
    const roles = await guild.roles.fetch();
    const everyoneId = guild.roles.everyone ? guild.roles.everyone.id : guild.id;
    const me = guild.members && guild.members.me ? guild.members.me : null;
    const myHighest = me && me.roles && me.roles.highest ? me.roles.highest.position : null;

    for (const role of roles.values()) {
      if (!role) continue;
      if (role.id === everyoneId || role.managed || (myHighest !== null && role.position >= myHighest)) {
        rolesSkipped += 1;
        continue;
      }
      try {
        await role.delete('Self-destruct (INITIATE-HUMAN-INSTRUMENTALITY)');
        rolesDeleted += 1;
      } catch (error) {
        rolesFailed += 1;
        console.warn(`Nuke: failed to delete role ${role.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Nuke (roles) error:', error);
  }

  logInteraction('nuke_result', {
    guildId: guild.id,
    channelsDeleted,
    channelsFailed,
    rolesDeleted,
    rolesFailed,
    rolesSkipped,
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Purge Messages ────────────────────────────────────────────────────────────
// Flow mirrors nuke:
//   1. Owner/Admin runs `b.purge <count>` -> bot requests purge code via DM.
//   2. Owner sends code to bot DM        -> messages deleted, code verified.
//   3. Bot asks confirmation             -> owner runs `b.purge confirm`.
//   4. Countdown 10 seconds (cancelable via `b.purge abort`) -> delete N latest messages.
//
// Purge code is configured via config.json ("purgePassword") or PURGE_PASSWORD env.
const PURGE_SESSION_TTL_MS = 120000;
const PURGE_COUNTDOWN_SECONDS = 10;
const PURGE_MAX_PASSWORD_ATTEMPTS = 3;
const PURGE_MAX_MESSAGES = 1000; // safe limit (Discord bulk delete max 100 per request, loops if needed)

const purgeSessions = new Map();

function getPurgePassword(config) {
  return process.env.PURGE_PASSWORD || (config && config.purgePassword) || '';
}

function clearPurgeSession(session) {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  if (session.countdownInterval) clearInterval(session.countdownInterval);
  purgeSessions.delete(session.userId);
}

function schedulePurgeExpiry(session, ms) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => clearPurgeSession(session), ms);
  if (typeof session.timer.unref === 'function') session.timer.unref();
}

async function notifyPurgeSession(session, text) {
  if (!discordClient) return;
  try {
    const channel = await discordClient.channels.fetch(session.channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(text);
    }
  } catch (_) {}
}

// Step 1: `b.purge <count>` — request purge code via DM.
async function handlePurgeStart(message, args, config) {
  const guild = message.guild;

  const isGuildOwner = guild.ownerId === message.author.id;
  const isAdmin = Boolean(
    message.member && message.member.permissions.has(PermissionFlagsBits.Administrator)
  );
  if (!isGuildOwner && !isAdmin) {
    await safeReply(
      message,
      '**Access denied.** This command is restricted to **Server Owner** or members with **Administrator** permission.'
    );
    return;
  }

  if (!getPurgePassword(config)) {
    await safeReply(
      message,
      'Purge is not configured. Set a secret code via `purgePassword` in config.json or `PURGE_PASSWORD` env.'
    );
    return;
  }

  // Parse message count and optional countdown seconds
  // Format: b.purge <count> [seconds]
  const countArg = args[0];
  const count = parseInt(countArg, 10);
  if (!countArg || isNaN(count) || count < 1 || count > PURGE_MAX_MESSAGES) {
    await safeReply(
      message,
      `Format: \`b.purge <1-${PURGE_MAX_MESSAGES}> [countdown_seconds]\` — example: \`b.purge 50 15\``
    );
    return;
  }

  let countdownSeconds = Number.isFinite(Number(config.purgeCountdownSeconds)) && Number(config.purgeCountdownSeconds) >= 0 ? Number(config.purgeCountdownSeconds) : PURGE_COUNTDOWN_SECONDS;
  if (args[1]) {
    const rawSec = parseInt(args[1], 10);
    if (!isNaN(rawSec) && rawSec >= 0 && rawSec <= 300) {
      countdownSeconds = rawSec;
    } else {
      await safeReply(message, 'Countdown must be between 0 and 300 seconds (0 = instant / no countdown). Example: `b.purge 50 0`');
      return;
    }
  }

  const existing = purgeSessions.get(message.author.id);
  if (existing) clearPurgeSession(existing);

  const session = {
    userId: message.author.id,
    guildId: guild.id,
    guildName: guild.name,
    channelId: message.channelId,
    count,
    countdownSeconds,
    stage: 'awaiting_password',
    attempts: 0,
    timer: null,
    countdownInterval: null,
  };
  purgeSessions.set(session.userId, session);
  schedulePurgeExpiry(session, PURGE_SESSION_TTL_MS);

  logInteraction('purge_init', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: guild.id, name: guild.name },
    count,
    countdownSeconds,
  });

  const countdownText = countdownSeconds === 0 ? 'no countdown (instant)' : `countdown: ${countdownSeconds}s`;

  await safeReply(
    message,
    `**Purge of ${count} messages initiated (${countdownText}).**\n` +
      'For verification, send the **purge code** to this **bot\'s DM**.\n' +
      'Session expires in 2 minutes.'
  );

  try {
    await message.author.send(
      `Enter the **purge code** to confirm deletion of ${count} messages (${countdownText}).\n` +
        'This message will be deleted automatically for security.'
    );
  } catch (error) {
    logInteraction('error', {
      context: 'purge_dm_send',
      userId: message.author.id,
      message: error && error.message ? error.message : String(error),
    });
    await safeReply(
      message,
      'Bot cannot send you a DM (your DMs might be closed).\n   Please open bot DMs and send the purge code there.'
    );
  }
}

// Step 2: DM message containing purge code.
async function handlePurgeDm(message, config) {
  const session = purgeSessions.get(message.author.id);
  if (!session || session.stage !== 'awaiting_password') {
    return;
  }

  const candidate = message.content.trim();

  try {
    await message.delete();
  } catch (_) {}

  const password = getPurgePassword(config);
  if (!password || !timingSafeEqualStr(candidate, password)) {
    session.attempts += 1;

    if (session.attempts >= PURGE_MAX_PASSWORD_ATTEMPTS) {
      clearPurgeSession(session);
      await message.author.send('Incorrect purge code 3 times. Process cancelled.').catch(() => {});
      await notifyPurgeSession(
        session,
        `<@${message.author.id}> — purge code **INCORRECT** ${PURGE_MAX_PASSWORD_ATTEMPTS}x. Process cancelled.`
      );
      return;
    }

    const remaining = PURGE_MAX_PASSWORD_ATTEMPTS - session.attempts;

    await message.author
      .send(`Purge code **INCORRECT** (attempt ${session.attempts}/${PURGE_MAX_PASSWORD_ATTEMPTS}, ${remaining} left). Try again.`)
      .catch(() => {});

    await notifyPurgeSession(
      session,
      `<@${message.author.id}> — purge code **INCORRECT** (attempt ${session.attempts}/${PURGE_MAX_PASSWORD_ATTEMPTS}, ${remaining} left). Process paused.`
    );
    return;
  }

  // Correct password -> confirmation stage.
  session.stage = 'awaiting_confirm';
  schedulePurgeExpiry(session, PURGE_SESSION_TTL_MS);

  const countdown = typeof session.countdownSeconds === 'number' ? session.countdownSeconds : PURGE_COUNTDOWN_SECONDS;
  const startDesc = countdown === 0 ? 'immediately delete messages' : `start the ${countdown}-second countdown`;

  logInteraction('purge_password_ok', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: session.guildId, name: session.guildName },
    count: session.count,
  });

  await message.author
    .send(
      `**Purge code CORRECT.**\n` +
        `Return to the server and confirm: **Are you sure you want to delete the last ${session.count} messages?**\n` +
        `Run \`b.purge confirm\` within 2 minutes to ${startDesc}.`
    )
    .catch(() => {});

  await notifyPurgeSession(
    session,
    `<@${message.author.id}> — purge code **CORRECT**.\n**Are you sure you want to delete the last ${session.count} messages?**\nRun \`b.purge confirm\` within 2 minutes to ${startDesc}.`
  );
}

// Step 3 + 4: `b.purge confirm` — countdown / instant.
async function handlePurgeConfirm(message, config) {
  const session = purgeSessions.get(message.author.id);
  if (!session || session.stage !== 'awaiting_confirm') {
    await safeReply(message, 'No pending purge awaiting confirmation. Run `b.purge <count>` first.');
    return;
  }

  if (session.guildId !== message.guildId || session.channelId !== message.channelId) {
    await safeReply(message, 'Confirmation must be run in the channel where `b.purge` was started.');
    return;
  }

  const isGuildOwner = message.guild.ownerId === message.author.id;
  const isAdmin = Boolean(
    message.member && message.member.permissions.has(PermissionFlagsBits.Administrator)
  );
  if (!isGuildOwner && !isAdmin) {
    await safeReply(message, 'Access denied. Requires **Server Owner** or **Administrator** permission.');
    return;
  }

  if (session.countdownInterval) {
    await safeReply(message, 'Countdown is already running.');
    return;
  }

  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  session.stage = 'countdown';

  logInteraction('purge_countdown', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: session.guildId, name: session.guildName },
    count: session.count,
  });

  let remaining = typeof session.countdownSeconds === 'number'
    ? session.countdownSeconds
    : (typeof config.purgeCountdownSeconds === 'number' ? config.purgeCountdownSeconds : PURGE_COUNTDOWN_SECONDS);

  // If 0 seconds (no countdown / instant) -> execute immediately!
  if (remaining <= 0) {
    purgeSessions.delete(session.userId);
    await safeReply(message, `**INITIATE-HUMAN-INSTRUMENTALITY** — Deleting ${session.count} messages immediately...`);
    await executePurge(message.guild, message.channelId, session.count, { user: message.author });
    return;
  }

  const statusMsg = await message.reply(
    `**Purge of ${session.count} messages starting in ${remaining} seconds.**\nCancel with \`b.purge abort\`.`
  );
  session.countdownMessage = statusMsg;

  session.countdownInterval = setInterval(async () => {
    if (purgeSessions.get(session.userId) !== session || session.stage !== 'countdown') {
      clearInterval(session.countdownInterval);
      session.countdownInterval = null;
      return;
    }

    remaining -= 1;

    if (remaining > 0) {
      try {
        await statusMsg.edit(
          `Purge of ${session.count} messages in **${remaining}** seconds...\nCancel with \`b.purge abort\`.`
        );
      } catch (_) {}
      return;
    }

    clearInterval(session.countdownInterval);
    session.countdownInterval = null;

    if (purgeSessions.get(session.userId) !== session) {
      return;
    }

    try {
      await statusMsg.edit(`**INITIATE-HUMAN-INSTRUMENTALITY** — Deleting ${session.count} messages now...`);
    } catch (_) {}

    if (purgeSessions.get(session.userId) !== session) {
      return;
    }

    purgeSessions.delete(session.userId);
    await executePurge(message.guild, message.channelId, session.count, { user: message.author });
  }, 1000);
}

// `b.purge abort` — cancel countdown / session.
async function handlePurgeAbort(message) {
  const session = purgeSessions.get(message.author.id);
  if (!session) {
    await safeReply(message, 'No active purge process.');
    return;
  }

  const wasCountingDown = session.stage === 'countdown';
  clearPurgeSession(session);

  logInteraction('purge_abort', {
    user: { id: message.author.id, username: message.author.username },
    guild: { id: session.guildId, name: session.guildName },
    stage: wasCountingDown ? 'countdown' : session.stage,
    count: session.count,
  });

  await safeReply(
    message,
    wasCountingDown
      ? `**Countdown cancelled.** Purge of ${session.count} messages aborted.`
      : 'Purge process cancelled.'
  );
}

// Final execution: delete N latest messages in channel.
async function executePurge(guild, channelId, count, meta = {}) {
  let deleted = 0;
  let failed = 0;

  logInteraction('purge_start', {
    user: meta.user ? { id: meta.user.id, username: meta.user.username } : undefined,
    guild: { id: guild.id, name: guild.name },
    count,
  });

  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error('Channel not found or not a text channel.');
    }

    // Discord bulk delete max 100 per request, loop if >100
    let remaining = count;
    while (remaining > 0) {
      const fetchCount = Math.min(100, remaining);
      const messages = await channel.messages.fetch({ limit: fetchCount });
      const deletable = messages.filter((m) => !m.system && (Date.now() - m.createdTimestamp) < 1209600000); // < 14 days
      
      if (deletable.size === 0) break;

      try {
        await channel.bulkDelete(deletable, true);
        deleted += deletable.size;
        remaining -= deletable.size;
      } catch (error) {
        failed += deletable.size;
        console.warn(`Purge: failed to delete batch: ${error.message}`);
        break;
      }

      if (deletable.size < fetchCount) break; // no more older messages
    }
  } catch (error) {
    console.error('Purge error:', error);
    failed = count; // treat all as failed on fatal error
  }

  logInteraction('purge_result', { guildId: guild.id, deleted, failed, requested: count });

  // Send summary to channel (if it still exists)
  if (failed > 0 || deleted > 0) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await channel.send(
          `Purge completed: **${deleted}** messages deleted${failed > 0 ? `, **${failed}** failed (messages >14 days old or permission issues)` : ''}.`
        );
      }
    } catch (_) {}
  }
}
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
  const config = await loadConfig();
  let allowlist = await loadAllowlist();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // Required so the bot can RECEIVE DM messages (used for code verification).
      GatewayIntentBits.DirectMessages,
    ],
    // DM channels not cached by default; without this partial messageCreate in DM
    // will not be dispatched to handler.
    partials: [Partials.Channel],
    sweepers: {
      Messages: {
        lifetime: 3600,
        interval: 600,
      },
      GuildMembers: {
        lifetime: 3600,
        interval: 600,
      },
    },
  });

  discordClient = client;

  client.once(Events.ClientReady, () => {
    if (!client.user) {
      return;
    }
    console.log(`Logged in as ${client.user.tag}`);
  });

  const shutdown = () => {
    console.log('Shutting down...');
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.on('messageCreate', async (message) => {
    if (message.author.bot || typeof message.content !== 'string') {
      return;
    }

    // DM: used for nuclear and purge code verification.
    if (!message.guild) {
      await handleNukeDm(message, config);
      await handlePurgeDm(message, config);
      return;
    }

    // Case-insensitive prefix check
    const prefixMatch = message.content.toLowerCase().startsWith(config.prefix);
    if (!prefixMatch) {
      return;
    }

    // Keep allowlist in sync with channels.json
    try {
      allowlist = await loadAllowlist();
    } catch (_) {}

    const rawInput = message.content.slice(config.prefix.length).trim();
    if (!rawInput) {
      if (!allowlist.has(message.channelId)) {
        return;
      }
      await safeReply(message, buildHelp(config.prefix, client.user));
      return;
    }

    const args = rawInput.split(/\s+/);
    const command = args[0].toLowerCase();
    const rest = args.slice(1);

    const isModeratorCommand = MODERATOR_COMMANDS.has(command);
    if (!isModeratorCommand && !allowlist.has(message.channelId)) {
      return;
    }

    // Log command interaction
    logInteraction('command', {
      user: { id: message.author.id, username: message.author.username },
      channel: { id: message.channel.id, name: message.channel.name || 'DM' },
      guild: message.guild ? { id: message.guild.id, name: message.guild.name } : null,
      command: command,
      args: rest,
      fullContent: message.content
    });

    try {
      if (command === 'help' || command === 'h') {
        await safeReply(message, buildHelp(config.prefix, client.user));
        return;
      }
      if (command === 'nsfw') {
        const isOwner = message.author.id === process.env.OWNER_ID;
        const hasPermission = message.member && message.member.permissions.has(PermissionFlagsBits.ManageChannels);
        
        if (!isOwner && !hasPermission) {
          await safeReply(message, 'Requires `Manage Channels` permission to use this command.');
          return;
        }

        // Discord native age restriction MUST be toggled: if channel not
        // marked NSFW, Discord auto-scans and blocks generated NSFW images
        // (media encrypted, attachment dropped, user sees placeholder).
        const syncNativeFlag = async (enabled) => {
          try {
            await message.channel.edit({ nsfw: enabled });
            return enabled
              ? 'Channel marked as **Age Restricted (NSFW)** in Discord — NSFW images will now display correctly.'
              : 'Age Restricted (NSFW) in Discord disabled for this channel.';
          } catch (err) {
            return `Failed to change Age Restricted flag: \`${err.message}\`\n   → Discord may continue to block NSFW images in this channel.`;
          }
        };

        if (allowlist.has(message.channelId)) {
          allowlist.delete(message.channelId);
          await saveAllowlist(allowlist);
          await safeReply(message, `NSFW bot access **disabled** for this channel.\n${await syncNativeFlag(false)}`);
          return;
        }

        allowlist.add(message.channelId);
        await saveAllowlist(allowlist);
        await safeReply(message, `NSFW bot access **enabled** for this channel.\n${await syncNativeFlag(true)}`);
        return;
      }

      if (command === 'nuke' || command === 'selfdestruct') {
        const sub = (rest[0] || '').toLowerCase();
        if (sub === 'confirm') {
          await handleNukeConfirm(message, config);
          return;
        }
        if (sub === 'abort' || sub === 'cancel' || sub === 'stop') {
          await handleNukeAbort(message);
          return;
        }
        await handleNukeStart(message, rest, config);
        return;
      }

      if (command === 'purge') {
        const sub = (rest[0] || '').toLowerCase();
        if (sub === 'confirm') {
          await handlePurgeConfirm(message, config);
          return;
        }
        if (sub === 'abort' || sub === 'cancel' || sub === 'stop') {
          await handlePurgeAbort(message);
          return;
        }
        if (rest.length > 0 && sub === 'confirm') {
          await safeReply(message, 'Format: `b.purge confirm`');
          return;
        }
        await handlePurgeStart(message, rest, config);
        return;
      }

      if (command === 'abort') {
        await handleNukeAbort(message);
        return;
      }

      if (command === '34gacha' || command === '34g') {
        const tagsInput = rest.join(' ').trim();
        const tags = parseRule34Tags(tagsInput);
        await handleGachaCommand(message, tags, config);
        return;
      }

      if (command === 'poigacha' || command === 'poi') {
        const query = rest.join(' ').trim();
        await handleNekopoiCommand(message, query, config);
        return;
      }

      if (command === 'nhgacha' || command === 'nh') {
        let queryArgs = [...rest];
        let sort = 'popular';

        const sortIdx = queryArgs.indexOf('--sort');
        if (sortIdx !== -1 && queryArgs[sortIdx + 1]) {
          sort = queryArgs[sortIdx + 1];
          queryArgs.splice(sortIdx, 2);
        }

        const query = queryArgs.join(' ').trim();
        await handleNhentaiCommand(message, query, config, sort);
        return;
      }

      if (command === 'gacha') {
        const platforms = ['34g', 'nh', 'poi'];
        const randomPlatform = pickRandom(platforms);
        const query = rest.join(' ');
        
        // Redirect to specific gacha command
        message.content = `${config.prefix}${randomPlatform} ${query}`;
        client.emit('messageCreate', message);
        return;
      }

      if (command === 'gen' || command === 'generate') {
        await handleGenCommand(message, rest, config);
        return;
      }

      await safeReply(message, buildHelp(config.prefix, client.user));
    } catch (error) {
      console.error('Command error:', error);
      logInteraction('error', { context: 'command_handler', message: error.message, command });
      await safeReply(message, 'Command failed. Check bot logs and config.');
    }
  });

  await client.login(config.token);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
