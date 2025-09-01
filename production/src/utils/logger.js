const util = require('util');
const fetchSafe = require('./fetchSafe');
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const DISABLE_WEBHOOK = process.env.DISABLE_WEBHOOK === 'true';

function fmt(level, args) {
  const ts = new Date().toISOString();
  const line = util.format.apply(null, args);
  return `[${level}] ${ts} ${line}`;
}

async function sendWebhook(level, args) {
  try {
    if (!WEBHOOK_URL || DISABLE_WEBHOOK) return;
    const content = '`' + level + '` ' + util.format.apply(null, args).slice(0, 1900);
    await fetchSafe(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    // best-effort
  }
}

const loggerObj = {
  info: function() {
    const line = fmt('INFO ', arguments);
    console.log(line);
    sendWebhook('INFO', arguments);
  },
  warn: function() {
    const line = fmt('WARN ', arguments);
    console.warn(line);
    sendWebhook('WARN', arguments);
  },
  error: function() {
    const line = fmt('ERROR', arguments);
    console.error(line);
    sendWebhook('ERROR', arguments);
  },
  debug: function() {
    const line = fmt('DEBUG', arguments);
    if (process.env.DEBUG) console.debug(line);
  }
};

// Export in a way that works with both CJS `require()` and ESM `import`.
// Consumers might do: `const logger = require(...); logger.info(...)`
// or: `import logger from '...'; logger.info(...)`
module.exports = loggerObj;
module.exports.default = loggerObj;
module.exports.info = loggerObj.info;
module.exports.warn = loggerObj.warn;
module.exports.error = loggerObj.error;
module.exports.debug = loggerObj.debug;
