const { PDFParse } = require('pdf-parse');

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 40;

const contextCache = new Map();

function normalizeText(text) {
    if (typeof text !== 'string') {
        return '';
    }

    return text
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function trimText(text, maxChars) {
    if (typeof text !== 'string') return '';
    if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 3)}...`;
}

function pruneCache() {
    const now = Date.now();

    for (const [key, value] of contextCache.entries()) {
        if (!value || now - value.createdAt > CACHE_TTL_MS) {
            contextCache.delete(key);
        }
    }

    while (contextCache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = contextCache.keys().next().value;
        contextCache.delete(oldestKey);
    }
}

async function readDriveFileToBuffer(drive, fileId) {
    const response = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    const chunks = [];
    for await (const chunk of response.data) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function extractPdfText({ drive, fileId, maxChars = 16000 }) {
    const buffer = await readDriveFileToBuffer(drive, fileId);
    const parser = new PDFParse({ data: buffer });
    let parsed;
    try {
        parsed = await parser.getText();
    } finally {
        await parser.destroy().catch(() => {});
    }

    const normalized = normalizeText(parsed && parsed.text ? parsed.text : '');
    return trimText(normalized, maxChars);
}

async function getPdfContext({ drive, fileId, maxChars = 16000 }) {
    pruneCache();

    const cached = contextCache.get(fileId);
    if (cached && Date.now() - cached.createdAt <= CACHE_TTL_MS) {
        return {
            text: trimText(cached.text, maxChars),
            source: 'cache'
        };
    }

    const text = await extractPdfText({ drive, fileId, maxChars });
    contextCache.set(fileId, {
        text,
        createdAt: Date.now()
    });

    return {
        text,
        source: 'fresh'
    };
}

async function prewarmPdfContext({ drive, fileId }) {
    try {
        await getPdfContext({ drive, fileId, maxChars: 16000 });
    } catch (error) {
        console.warn('PDF context prewarm failed:', error.message);
    }
}

module.exports = {
    getPdfContext,
    prewarmPdfContext
};
