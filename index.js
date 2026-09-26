'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns');
const https = require('node:https');
const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(['1.1.1.1', '8.8.8.8', '8.8.4.4']);
const vm = require('node:vm');

const dnsCache = {};
const originalLookup = dns.lookup;

async function resolveDoH(host) {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`);
    const data = await res.json();
    const aRecord = data.Answer?.find(ans => ans.type === 1);
    if (aRecord?.data) return aRecord.data;
  } catch (e) {
    try {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
        headers: { 'Accept': 'application/dns-json' }
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
} = require('discord.js');

const { logInteraction } = require('./logger');

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
  resolved.imageGenTimeoutMs = Number(resolved.imageGenTimeoutMs) > 0 ? Number(resolved.imageGenTimeoutMs) : 120000;
  resolved.rule34MaxAttempts = Number(resolved.rule34MaxAttempts) > 0 ? Number(resolved.rule34MaxAttempts) : 4;
  resolved.rule34PagePool = Number(resolved.rule34PagePool) > 0 ? Number(resolved.rule34PagePool) : 150;
  resolved.userAgent = resolved.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  resolved.pollinationsApiKey = resolved.pollinationsApiKey || '';
  resolved.hordeApiKey = resolved.hordeApiKey || '';
  resolved.hordeTimeoutMs = Number(resolved.hordeTimeoutMs) > 0 ? Number(resolved.hordeTimeoutMs) : 600000;

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

async function scrapeNekopoiDetails(pageUrl, userAgent) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
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
          }
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
        console.error("Error unpacking streampoi:", err.message);
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
        name: '📺 Streaming Links',
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
            name: `📥 Download Links Part ${chunkIdx}`,
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
          name: chunkIdx > 1 ? `📥 Download Links Part ${chunkIdx}` : '📥 Download Links',
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
    const scraped = await scrapeNekopoiDetails(post.link, config?.userAgent);
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


// ─── Pollinations Image Generation (gratis) ──────────────────────────────────

const POLLINATIONS_HOST = 'gen.pollinations.ai';

const POLLINATION_MODELS = {
  'flux': { id: 'flux', label: 'FLUX' },
  'flux-schnell': { id: 'black-forest-labs/flux.1-schnell', label: 'FLUX.1 schnell' },
  'sana': { id: 'sana', label: 'SANA' },
};

const POLLINATION_DEFAULT_MODEL = 'flux';

const POLLINATION_SIZES = {
  'square': { width: 1024, height: 1024 },
  'portrait': { width: 832, height: 1216 },
  'landscape': { width: 1216, height: 832 },
  'wide': { width: 1344, height: 768 },
  'tall': { width: 768, height: 1344 },
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
 *   GET https://gen.pollinations.ai/image/{prompt}?model=..&width=..&height=..
 * Optional API key (config.pollinationsApiKey) untuk prioritas & model berbayar,
 * tapi API ini JALAN GRATIS tanpa key.
 * Returns { buffer, contentType, modelId }.
 */
async function generateImagePollinations(config, prompt, modelKey = POLLINATION_DEFAULT_MODEL, sizeKey = POLLINATION_DEFAULT_SIZE) {
  const model = POLLINATION_MODELS[modelKey] || POLLINATION_MODELS[POLLINATION_DEFAULT_MODEL];
  const size = POLLINATION_SIZES[sizeKey] || POLLINATION_SIZES[POLLINATION_DEFAULT_SIZE];

  const params = new URLSearchParams({
    model: model.id,
    width: String(size.width),
    height: String(size.height),
  });
  if (config.pollinationsApiKey) params.set('key', config.pollinationsApiKey);

  const path = `/image/${encodeURIComponent(prompt)}?${params.toString()}`;
  const res = await httpsRequestRaw(POLLINATIONS_HOST, path, { timeoutMs: config.imageGenTimeoutMs });

  if (res.statusCode !== 200) {
    let msg = '';
    try {
      const parsed = JSON.parse(res.buffer.toString());
      msg = (parsed.error && (parsed.error.message || parsed.error.detail)) || parsed.detail || parsed.message || '';
    } catch (_) {}
    if (!msg) msg = res.buffer.toString().slice(0, 200);
    throw new Error(`Pollinations error ${res.statusCode}: ${msg}`);
  }

  const contentType = res.headers['content-type'] || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    // Pollinations kadang membalas teks/JSON walau HTTP 200 (mis. prompt ditolak filter konten)
    throw new Error(`Pollinations tidak mengembalikan gambar (${contentType}): ${res.buffer.toString().slice(0, 200)}`);
  }

  return { buffer: res.buffer, contentType, modelId: model.id };
}

// ─── AI Horde Image Generation (gratis, NSFW, antre) ──────────────────────────

const HORDE_HOST = 'stablehorde.net';

// Model terkurasi dari 177 model aktif di horde — hanya yang worker-nya ada
// dan reputasinya bagus. res: 'xl' → butuh resolusi lebih besar (kudos lebih mahal).
const HORDE_MODELS = {
  // ── Anime SD1.5 — murah & cepat (~6 kudos/gambar di 512²) ──
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

  // ── Anime XL / Pony / Illustrious — kualitas terbaik, lebih mahal ──
  'wai':         { id: 'WAI-NSFW-illustrious-SDXL', group: 'animexl', res: 'xl', label: 'WAI NSFW Illustrious SDXL' },
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

  // ── Realistis ──
  'real':        { id: 'AbsoluteReality', group: 'real', label: 'AbsoluteReality' },
  'rv':          { id: 'Realistic Vision', group: 'real', label: 'Realistic Vision' },
  'juggernaut':  { id: 'Juggernaut XL', group: 'real', res: 'xl', label: 'Juggernaut XL' },
  'icbinp':      { id: "ICBINP - I Can't Believe It's Not Photography", group: 'real', label: 'ICBINP (foto realistis)' },
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

  // ── Eksperimental / cepat ──
  'flux':        { id: 'Flux.1-Schnell fp8 (Compact)', group: 'exp', label: 'FLUX.1 Schnell fp8' },
  'krea':        { id: 'Krea2-Turbo_fp8', group: 'exp', label: 'Krea2 Turbo fp8' },
  'zturbo':      { id: 'Z-Image-Turbo', group: 'exp', label: 'Z-Image Turbo' },
  'sdbase':      { id: 'stable_diffusion', group: 'exp', label: 'Stable Diffusion 1.5 (base)' },
};

const HORDE_MODEL_GROUPS = [
  { key: 'anime',   name: 'Anime (murah, cepat)' },
  { key: 'animexl', name: 'Anime XL/Pony (kualitas, mahal)' },
  { key: 'real',    name: 'Realistis' },
  { key: 'furry',   name: 'Furry' },
  { key: 'exp',     name: 'Eksperimental / cepat' },
];

const HORDE_DEFAULT_MODEL = 'abyss';

const HORDE_SIZES = {
  'square': { width: 512, height: 512 },
  'landscape': { width: 768, height: 512 },
  'portrait': { width: 512, height: 768 },
};

const HORDE_DEFAULT_SIZE = 'square';
const HORDE_DEFAULT_STEPS = 20;
const HORDE_MIN_STEPS = 8;
const HORDE_MAX_STEPS = 40;

// Perkiraan biaya kudos horde ≈ (lebar * tinggi * steps) / 1e6
function estimateHordeKudos(width, height, steps) {
  return Math.max(1, Math.ceil((width * height * steps) / 1000000));
}

// Model XL pecah kalau resolusi kecil — skala 1.5x, bulatkan ke kelipatan 64
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
      return new Error(`Horde: API key ditolak (401) — cek hordeApiKey di config.json.`);
    case 429:
      return new Error('Horde: rate limit / kudos tidak cukup (429). Coba lagi nanti.');
    default:
      return new Error(`Horde error ${res.statusCode} saat ${stage}: ${msg}`);
  }
}

function formatHordeEta(sec) {
  if (!sec || sec <= 0) return null;
  if (sec < 60) return `${Math.max(1, Math.round(sec))} detik`;
  return `${Math.ceil(sec / 60)} menit`;
}

function formatElapsed(sec) {
  if (!sec || sec < 0) return '0 detik';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} detik`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m} menit ${s} detik` : `${m} menit`;
}

async function updateHordeStatus(statusMsg, info, prompt, modelKey, sizeKey) {
  if (!statusMsg) return;
  const eta = formatHordeEta(info.waitTimeSec);
  const pos = typeof info.queuePosition === 'number' ? info.queuePosition : null;

  let queueLine;
  if (pos !== null && pos > 0) {
    queueLine = `⏳ Antrean: **${pos} di depan**`;
    if (typeof info.processing === 'number' && info.processing > 0) queueLine += ` (${info.processing} diproses)`;
    queueLine += ` | Estimasi: **~${eta || 'beberapa menit'}**`;
  } else if (pos === 0) {
    queueLine = `⚡ Sedang diproses worker...${eta ? ` (sekitar **~${eta}**)` : ''}`;
  } else {
    queueLine = '⏳ Mencari posisi antrean...';
  }

  const label = HORDE_MODELS[modelKey] ? HORDE_MODELS[modelKey].label : modelKey;
  const header = `🎨 Generating gambar... (AI Horde, model: \`${label}\`, size: \`${sizeKey}\`)`;
  const elapsed = typeof info.elapsedSec === 'number' ? `\n📈 Sudah menunggu: ${formatElapsed(info.elapsedSec)}` : '';
  const promptLine = `\nPrompt: \`${prompt.slice(0, 200)}\``;
  try {
    await statusMsg.edit(`${header}\n${queueLine}${elapsed}${promptLine}`);
  } catch (_) {
    // Pesan status sudah terhapus / tidak bisa diedit — abaikan
  }
}

/**
 * Generate an image via AI Horde (free community GPU network, NSFW-friendly).
 * Anonymous (hordeApiKey kosong / key "0000000000") diprioritaskan paling
 * belakang — antrean bisa 5-15+ menit. Polling status sampai done.
 * onStatus(info) dipanggil tiap poll: { queuePosition, processing, waitTimeSec, elapsedSec }.
 * Returns { buffer, contentType, modelId }.
 */
async function generateImageHorde(config, prompt, modelKey = HORDE_DEFAULT_MODEL, sizeKey = HORDE_DEFAULT_SIZE, onStatus = null, steps = HORDE_DEFAULT_STEPS) {
  const model = HORDE_MODELS[modelKey] || HORDE_MODELS[HORDE_DEFAULT_MODEL];
  const baseSize = HORDE_SIZES[sizeKey] || HORDE_SIZES[HORDE_DEFAULT_SIZE];
  const size = scaleHordeSize(baseSize.width, baseSize.height, model.res === 'xl' ? 1.5 : 1);
  const stepCount = Math.min(HORDE_MAX_STEPS, Math.max(HORDE_MIN_STEPS, Number(steps) || HORDE_DEFAULT_STEPS));
  const kudosCost = estimateHordeKudos(size.width, size.height, stepCount);
  const apiKey = config.hordeApiKey || '0000000000';
  const timeoutMs = config.hordeTimeoutMs || 600000;
  const authHeaders = { apikey: apiKey, 'Content-Type': 'application/json' };

  // 1) Submit job ke antrean
  const payload = {
    prompt,
    params: { width: size.width, height: size.height, steps: stepCount, sampler_name: 'k_euler', cfg_scale: 7 },
    models: [model.id],
    nsfw: true,
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
    throw new Error('Horde: respons submit tidak valid.');
  }
  const jobId = submitData.id;
  if (!jobId) throw new Error('Horde: tidak ada job id pada respons submit.');

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
    if (status.statusCode === 404) throw new Error('Horde: job tidak ditemukan (404). Coba lagi.');

    let statusData = null;
    try {
      statusData = JSON.parse(status.buffer.toString());
    } catch (_) {}

    if (statusData) {
      if (statusData.faulted) throw new Error('Horde: job gagal diproses worker. Coba lagi nanti.');
      if (statusData.done) {
        const gen = statusData.generations && statusData.generations[0];
        if (!gen || !gen.img) throw new Error('Horde: selesai tapi tidak ada gambar di hasil.');
        const buffer = Buffer.from(gen.img, 'base64');
        return { buffer, contentType: 'image/jpeg', modelId: model.id, kudos: kudosCost, width: size.width, height: size.height };
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

  throw new Error(`Horde: timeout menunggu hasil (${Math.round(timeoutMs / 60000)} menit). Antrean gratis bisa panjang — coba lagi nanti.`);
}

async function handleGenCommand(message, args, config) {
  // Parse flags: --provider <pollinations|horde> | --horde, --model <name>, --size <name>, --steps <n>
  let provider = 'pollinations';
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

  const isHorde = provider === 'horde';
  if (provider !== 'pollinations' && provider !== 'horde') {
    await safeReply(message, `❌ Provider tidak dikenal: \`${provider}\`\nTersedia: pollinations (default, instan) | horde (NSFW gratis, antre).\nContoh: \`b.gen maid seductive --provider horde\``);
    return;
  }

  const MODELS = isHorde ? HORDE_MODELS : POLLINATION_MODELS;
  const DEFAULT_MODEL = isHorde ? HORDE_DEFAULT_MODEL : POLLINATION_DEFAULT_MODEL;
  const SIZES = isHorde ? HORDE_SIZES : POLLINATION_SIZES;
  const DEFAULT_SIZE = isHorde ? HORDE_DEFAULT_SIZE : POLLINATION_DEFAULT_SIZE;

  let modelKey = DEFAULT_MODEL;
  let sizeKey = DEFAULT_SIZE;
  let steps = HORDE_DEFAULT_STEPS;

  const modelFlagIdx = argsCopy.indexOf('--model');
  if (modelFlagIdx !== -1 && argsCopy[modelFlagIdx + 1]) {
    modelKey = argsCopy[modelFlagIdx + 1].toLowerCase();
    argsCopy.splice(modelFlagIdx, 2);
    if (!MODELS[modelKey]) {
      const validKeys = isHorde ? formatHordeModelList() : Object.keys(MODELS).join(', ');
      await safeReply(message, `❌ Model tidak dikenal: \`${modelKey}\`\nModel yang tersedia (${provider}):\n    ${validKeys}`);
      return;
    }
  }

  const sizeFlagIdx = argsCopy.indexOf('--size');
  if (sizeFlagIdx !== -1 && argsCopy[sizeFlagIdx + 1]) {
    sizeKey = argsCopy[sizeFlagIdx + 1].toLowerCase();
    argsCopy.splice(sizeFlagIdx, 2);
    if (!SIZES[sizeKey]) {
      const validSizes = Object.keys(SIZES).join(', ');
      await safeReply(message, `❌ Ukuran tidak dikenal: \`${sizeKey}\`\nUkuran yang tersedia (${provider}): ${validSizes}`);
      return;
    }
  }

  // --steps (khusus horde) — Fewer steps = kudos lebih hemat
  const stepsFlagIdx = argsCopy.indexOf('--steps');
  if (stepsFlagIdx !== -1 && argsCopy[stepsFlagIdx + 1]) {
    const rawSteps = Number(argsCopy[stepsFlagIdx + 1]);
    argsCopy.splice(stepsFlagIdx, 2);
    if (!Number.isFinite(rawSteps) || rawSteps < HORDE_MIN_STEPS || rawSteps > HORDE_MAX_STEPS) {
      await safeReply(message, `❌ Nilai --steps harus angka ${HORDE_MIN_STEPS}-${HORDE_MAX_STEPS} (default ${HORDE_DEFAULT_STEPS}).\nLebih sedikit steps = kudos lebih hemat, kualitas turun sedikit.`);
      return;
    }
    steps = Math.round(rawSteps);
  }

  const prompt = argsCopy.join(' ').trim();
  if (!prompt) {
    await safeReply(message, `❌ Berikan prompt untuk generate gambar.\nContoh: \`b.gen a beautiful anime girl\``);
    return;
  }

  const providerLabel = isHorde ? 'AI Horde' : 'Pollinations';
  const modelDef = isHorde ? (HORDE_MODELS[modelKey] || {}) : {};
  // Hitung dulu biar user tahu berapa kudos yang bakal terpakai
  const effSize = isHorde ? scaleHordeSize(HORDE_SIZES[sizeKey].width, HORDE_SIZES[sizeKey].height, modelDef.res === 'xl' ? 1.5 : 1) : null;
  const kudosInfo = isHorde ? ` | ~${estimateHordeKudos(effSize.width, effSize.height, steps)} kudos | steps: ${steps}` : '';
  const resInfo = isHorde && effSize ? `\n🖼️ Resolusi: ${effSize.width}×${effSize.height}${modelDef.res === 'xl' ? ' (XL auto-upscale)' : ''}` : '';

  // Status "generating..."
  let statusMsg;
  try {
    statusMsg = await message.reply(`🎨 Generating gambar... (${providerLabel}, model: \`${modelKey}\`, size: \`${sizeKey}\`${kudosInfo})\nPrompt: \`${prompt.slice(0, 200)}\`${resInfo}${isHorde ? '\n⏳ Horde gratis pakai antrean — bisa 5-15 menit.' : ''}`);
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
      ? await generateImageHorde(config, prompt, modelKey, sizeKey, (info) => updateHordeStatus(statusMsg, info, prompt, modelKey, sizeKey), steps)
      : await generateImagePollinations(config, prompt, modelKey, sizeKey);
    const { buffer, contentType, modelId } = result;

    const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
    const filename = `generated.${ext}`;

    const embed = new EmbedBuilder()
      .setTitle('🎨 Generated Image')
      .setDescription(`**Prompt:** ${prompt.slice(0, 1024)}`)
      .addFields(
        { name: 'Provider', value: providerLabel, inline: true },
        { name: 'Model', value: `\`${modelId}\``, inline: true },
        { name: 'Requested by', value: `<@${message.author.id}>`, inline: true }
      )
      .setImage(`attachment://${filename}`)
      .setFooter({ text: isHorde ? 'Generated via AI Horde (gratis)' : 'Generated via Pollinations (gratis)' });

    try {
      await message.reply({
        embeds: [embed],
        files: [{ attachment: buffer, name: filename }],
      });
    } catch (sendError) {
      if (sendError && sendError.code === 50013) {
        console.warn(`Cannot send image in channel ${message.channelId}: Missing Permissions`);
      } else {
        throw sendError;
      }
    }

    logInteraction('gen_result', { prompt, provider, model: modelKey, result: 'success' });
  } catch (error) {
    logInteraction('gen_result', { prompt, provider, model: modelKey, result: 'error', message: error.message });
    console.error('Image generation error:', error);
    await safeReply(message, `❌ Gagal generate gambar: ${error.message}`);
  } finally {
    if (statusMsg) {
      try { await statusMsg.delete(); } catch (_) {}
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function buildHelp(prefix) {
  return [
    `Commands (${prefix}):`,
    `${prefix}nsfw - toggle this channel authorization (Manage Channels required)`,
    `${prefix}34gacha or ${prefix}34g [tags...] - random Rule34 post (no tags = fully random)`,
    `  examples: ${prefix}34gacha 2girls blue_hair`,
    `${prefix}poigacha or ${prefix}poi [query] - random Nekopoi post (no query = random)`,
    `  examples: ${prefix}poigacha overflow`,
    `${prefix}nhgacha or ${prefix}nh [query] [--sort <popular|recent>] - random nhentai post (no query = random)`,
    `  examples: ${prefix}nhgacha doujinshi --sort popular`,
    `${prefix}gacha [query] - random gacha from any platform`,
    `${prefix}gen <prompt> [--provider <pollinations|horde>] [--model <model>] [--size <size>] [--steps <n>] - generate AI image (gratis)`,
    `  provider pollinations (default, instan, ada filter) | horde (NSFW bebas, antre ~5-15 mnt)`,
    `  pollinations models: ${Object.keys(POLLINATION_MODELS).join(', ')} | sizes: ${Object.keys(POLLINATION_SIZES).join(', ')}`,
    `  horde sizes: ${Object.keys(HORDE_SIZES).join(', ')} | steps: ${HORDE_MIN_STEPS}-${HORDE_MAX_STEPS} (default ${HORDE_DEFAULT_STEPS}, makin kecil makin hemat kudos)`,
    `  horde models (${Object.keys(HORDE_MODELS).length} pilihan, semua ada worker aktif):`,
    `    ${formatHordeModelList()}`,
    `  examples: ${prefix}gen maid --provider horde --model abyss --size portrait`,
    `  contoh XL (otomatis 768px, ~12 kudos): ${prefix}gen 1girl, cyberpunk --model wai --size portrait`,
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

  client.once('ready', () => {
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

    const args = rawInput.split(/\s+/);
    const command = args[0].toLowerCase();
    const rest = args.slice(1);

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
      if (command === 'nsfw') {
        const isOwner = message.author.id === process.env.OWNER_ID;
        const hasPermission = message.member && message.member.permissions.has(PermissionFlagsBits.ManageChannels);
        
        if (!isOwner && !hasPermission) {
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

      await safeReply(message, buildHelp(config.prefix));
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
