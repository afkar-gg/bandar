const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getLogFilePath(ext = 'jsonl') {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(LOGS_DIR, `log-${date}.${ext}`);
}

/**
 * Logs an interaction to both a JSONL file and a human-readable text file.
 * @param {string} type - The type of interaction
 * @param {object} data - The data to log
 */
function logInteraction(type, data) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, type, ...data };

  // 1. Save as JSONL (Machine readable)
  try {
    fs.appendFileSync(getLogFilePath('jsonl'), JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error('Failed to write JSON log:', error);
  }

  // 2. Save as Readable Text (Human readable)
  try {
    const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    let readableMsg = `[${timeStr}] [${type.toUpperCase()}] `;

    switch (type) {
      case 'command':
        readableMsg += `${data.user.username} (${data.user.id}) in #${data.channel.name}: ${data.fullContent}`;
        break;
      case 'gacha_result':
        readableMsg += `Gacha (${data.type}): ${data.result} ${data.postId ? `| ID: ${data.postId}` : ''} ${data.query || data.tags || ''}`;
        break;
      case 'error':
        readableMsg += `ERROR in ${data.context}: ${data.message}`;
        break;
      case 'system':
        readableMsg += `SYSTEM: ${data.event} - ${data.user || ''}`;
        break;
      default:
        readableMsg += JSON.stringify(data);
    }

    fs.appendFileSync(getLogFilePath('log'), readableMsg + '\n');
  } catch (error) {
    console.error('Failed to write text log:', error);
  }
}

module.exports = { logInteraction };
