const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const { drive } = require('@googleapis/drive');
const cors = require('cors');
const serverless = require('serverless-http');
const helmet = require('helmet');
const { pipeline } = require('stream');

function requireEnv(name) {
    const value = process.env[name];
    if (!value || !String(value).trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return String(value).trim();
}

function normalizePrivateKey(value) {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim();
    const unwrapped =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
            ? trimmed.slice(1, -1)
            : trimmed;
    return unwrapped.replace(/\\n/g, '\n');
}

function getFirstEnv(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

function deriveProjectIdFromAuthDomain(authDomain) {
    if (typeof authDomain !== 'string') {
        return '';
    }
    const match = authDomain.trim().match(/^([a-z0-9-]+)\.firebaseapp\.com$/i);
    return match ? match[1] : '';
}

function parseServiceAccountJson(rawValue) {
    const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!raw) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON');
    }

    const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
    const privateKey = normalizePrivateKey(parsed.private_key);
    const projectId =
        (typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '') ||
        (typeof process.env.FIREBASE_PROJECT_ID === 'string' ? process.env.FIREBASE_PROJECT_ID.trim() : '');

    if (!clientEmail || !privateKey || !projectId) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing required service-account fields');
    }

    return {
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey
    };
}

function getServiceAccountCredentials() {
    const fromJson = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (fromJson) {
        return fromJson;
    }

    return {
        project_id: requireEnv('FIREBASE_PROJECT_ID'),
        client_email: requireEnv('FIREBASE_CLIENT_EMAIL'),
        private_key: normalizePrivateKey(requireEnv('FIREBASE_PRIVATE_KEY'))
    };
}

function validateEnvironment() {
    // Keep startup tolerant: route handlers validate their own required config.
    // This prevents all /api routes from failing with 502 if one optional
    // environment variable is missing.
}

validateEnvironment();

const { getAdminAuth } = require('./lib/firebaseAdmin');
const {
    createPreview,
    getConversation,
    openOrResumeConversationByPdf,
    listConversations,
    listMessages,
    appendMessage,
    loadRecentMessages,
    updateConversationAfterTurn,
    closeConversation,
    renameConversation,
    softDeleteConversation
} = require('./lib/chatStore');
const { createChatCompletion, DEFAULT_MODEL } = require('./lib/openrouter');

const app = express();

const DEFAULT_ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:8888',
    'http://127.0.0.1:8888'
];

function parseUrlSafe(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    try {
        return new URL(value.trim());
    } catch (_) {
        return null;
    }
}

function normalizeOrigin(value) {
    const parsed = parseUrlSafe(value);
    return parsed ? parsed.origin : '';
}

function toNetlifyBaseHost(hostname) {
    if (typeof hostname !== 'string' || !hostname.endsWith('.netlify.app')) {
        return '';
    }

    const marker = '--';
    const markerIndex = hostname.lastIndexOf(marker);
    if (markerIndex === -1) {
        return hostname;
    }

    const candidate = hostname.slice(markerIndex + marker.length);
    return candidate.endsWith('.netlify.app') ? candidate : hostname;
}

const configuredOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;

const runtimeOriginCandidates = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL];
const runtimeOrigins = runtimeOriginCandidates
    .map(normalizeOrigin)
    .filter(Boolean);

const allowedOrigins = new Set([...configuredOrigins, ...runtimeOrigins].map(normalizeOrigin).filter(Boolean));
const siteName = typeof process.env.SITE_NAME === 'string' ? process.env.SITE_NAME.trim() : '';
const netlifyBaseHosts = new Set(
    [
        ...runtimeOriginCandidates.map((origin) => {
            const parsed = parseUrlSafe(origin);
            return parsed ? toNetlifyBaseHost(parsed.hostname) : '';
        }),
        siteName ? `${siteName}.netlify.app` : ''
    ].filter(Boolean)
);

function isAllowedNetlifySiteOrigin(origin) {
    const parsed = parseUrlSafe(origin);
    if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.netlify.app')) {
        return false;
    }

    for (const baseHost of netlifyBaseHosts) {
        if (parsed.hostname === baseHost || parsed.hostname.endsWith(`--${baseHost}`)) {
            return true;
        }
    }

    return false;
}

app.use(cors({
    origin(origin, callback) {
        if (!origin) {
            callback(null, true);
            return;
        }

        const normalizedOrigin = normalizeOrigin(origin);
        if (allowedOrigins.has(normalizedOrigin) || isAllowedNetlifySiteOrigin(normalizedOrigin)) {
            callback(null, true);
            return;
        }

        callback(new Error('Origin not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 86400
}));

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://www.gstatic.com'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https://*.googleapis.com', 'https://securetoken.googleapis.com'],
            frameSrc: ['https://drive.google.com', 'https://accounts.google.com'],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: []
        }
    },
    crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '1mb' }));

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

function createRateLimiter({ windowMs, maxRequests, keyBuilder, message }) {
    const store = new Map();

    setInterval(() => {
        const now = Date.now();
        for (const [key, value] of store.entries()) {
            if (now > value.resetAt) {
                store.delete(key);
            }
        }
    }, 300000);

    return (req, res, next) => {
        const key = keyBuilder(req);
        const now = Date.now();
        const entry = store.get(key);

        if (!entry || now > entry.resetAt) {
            store.set(key, { count: 1, resetAt: now + windowMs });
            next();
            return;
        }

        if (entry.count >= maxRequests) {
            res.status(429).json({ success: false, error: message });
            return;
        }

        entry.count += 1;
        next();
    };
}

const generalRateLimiter = createRateLimiter({
    windowMs: 60000,
    maxRequests: 100,
    keyBuilder: (req) => `general:${getClientIp(req)}`,
    message: 'Too many requests. Please try again later.'
});

const chatIpRateLimiter = createRateLimiter({
    windowMs: 60000,
    maxRequests: 60,
    keyBuilder: (req) => `chat-ip:${getClientIp(req)}`,
    message: 'Chat request limit reached for this network. Please wait a moment.'
});

const chatUidRateLimiter = createRateLimiter({
    windowMs: 60000,
    maxRequests: 40,
    keyBuilder: (req) => `chat-uid:${req.user?.uid || 'anonymous'}`,
    message: 'Chat request limit reached for this user. Please wait a moment.'
});

app.use(generalRateLimiter);

function requireAuth(req, res, next) {
    let adminAuth;
    try {
        adminAuth = getAdminAuth();
    } catch (error) {
        console.error('Auth initialization failed:', error.message);
        res.status(503).json({ success: false, error: 'Authentication service is not configured' });
        return;
    }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
        return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
        res.status(401).json({ success: false, error: 'Missing ID token' });
        return;
    }

    adminAuth
        .verifyIdToken(token)
        .then((decoded) => {
            req.user = {
                uid: decoded.uid,
                email: decoded.email || null
            };
            next();
        })
        .catch(() => {
            res.status(401).json({ success: false, error: 'Unauthorized' });
        });
}

function applyChatRateLimits(req, res, next) {
    chatIpRateLimiter(req, res, (ipErr) => {
        if (ipErr) {
            next(ipErr);
            return;
        }

        chatUidRateLimiter(req, res, next);
    });
}

const DRIVE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,200}$/;
const DOC_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const APPROVED_MODELS = new Set(
    (process.env.OPENROUTER_MODEL_ALLOWLIST || DEFAULT_MODEL)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
);
APPROVED_MODELS.add(DEFAULT_MODEL);

function ensureString(input, { min = 1, max = 255, field = 'value' } = {}) {
    if (typeof input !== 'string') {
        return `${field} must be a string`;
    }

    const trimmed = input.trim();
    if (trimmed.length < min) {
        return `${field} is too short`;
    }

    if (trimmed.length > max) {
        return `${field} is too long`;
    }

    return null;
}

function isValidDriveId(value) {
    return typeof value === 'string' && DRIVE_ID_PATTERN.test(value);
}

function extractDriveId(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }

    if (isValidDriveId(trimmed)) {
        return trimmed;
    }

    const folderPathMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{8,200})/);
    if (folderPathMatch && isValidDriveId(folderPathMatch[1])) {
        return folderPathMatch[1];
    }

    const filePathMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]{8,200})/);
    if (filePathMatch && isValidDriveId(filePathMatch[1])) {
        return filePathMatch[1];
    }

    const parsed = parseUrlSafe(trimmed);
    const idFromQuery = parsed ? parsed.searchParams.get('id') : '';
    if (isValidDriveId(idFromQuery)) {
        return idFromQuery;
    }

    return '';
}

function isValidDocId(value) {
    return typeof value === 'string' && DOC_ID_PATTERN.test(value);
}

function parseLimit(limit, defaultValue, maxValue) {
    const parsed = Number.parseInt(limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return defaultValue;
    }
    return Math.min(parsed, maxValue);
}

function trimMessageContent(content, maxChars = 600) {
    if (typeof content !== 'string') return '';
    const compact = content.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxChars) {
        return compact;
    }
    return `${compact.slice(0, maxChars - 3)}...`;
}

function tokenizeQuery(query) {
    if (typeof query !== 'string') return [];
    const stopwords = new Set([
        'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'what', 'when', 'where', 'which',
        'about', 'please', 'could', 'would', 'should', 'into', 'your', 'there', 'tell', 'explain'
    ]);

    return query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 3 && !stopwords.has(token))
        .slice(0, 12);
}

function buildPdfContextSnippet(pdfText, userQuery, maxChars = 2600) {
    if (typeof pdfText !== 'string' || !pdfText.trim()) {
        return '';
    }

    const chunks = pdfText
        .split(/\n{2,}/)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .slice(0, 160);

    if (!chunks.length) {
        return trimMessageContent(pdfText, maxChars);
    }

    const terms = tokenizeQuery(userQuery);

    if (!terms.length) {
        return trimMessageContent(chunks.slice(0, 8).join('\n\n'), maxChars);
    }

    const scored = chunks.map((chunk, index) => {
        const lower = chunk.toLowerCase();
        let score = 0;

        for (const term of terms) {
            if (lower.includes(term)) {
                score += 3;
            }
        }

        if (index < 8) {
            score += 1;
        }

        return { chunk, score };
    });

    const selected = scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((item) => item.chunk);

    if (!selected.length) {
        return trimMessageContent(chunks.slice(0, 8).join('\n\n'), maxChars);
    }

    return trimMessageContent(selected.join('\n\n'), maxChars);
}

function buildModelMessages(systemPrompt, recentMessages) {
    const safeRecent = Array.isArray(recentMessages) ? recentMessages.slice(-5) : [];
    return [{ role: 'system', content: systemPrompt }].concat(
        safeRecent.map((message) => ({
            role: message.role,
            content: trimMessageContent(message.content, 600)
        }))
    );
}

const DEFAULT_ROOT_FOLDER_ID = '1bB6-3-q62cn2mfRZ9pfMl72M75_yZMp1';
const configuredRootFolderRaw = (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim();
const configuredRootFolderId = extractDriveId(configuredRootFolderRaw);
if (configuredRootFolderRaw && !configuredRootFolderId) {
    console.warn('Invalid GOOGLE_DRIVE_ROOT_FOLDER_ID format. Falling back to default root folder ID.');
}
const ROOT_FOLDER_ID = configuredRootFolderId || DEFAULT_ROOT_FOLDER_ID;
const PDF_OR_SHORTCUT_QUERY =
    "(mimeType = 'application/pdf' or (mimeType = 'application/vnd.google-apps.shortcut' and shortcutDetails.targetMimeType = 'application/pdf'))";
const NETLIFY_FUNCTION_MAX_RESPONSE_BYTES = 6000000;
const DRIVE_LIST_PAGE_SIZE = 1000;
const DRIVE_PARENT_QUERY_BATCH_SIZE = 20;
const MAX_RECURSIVE_FOLDER_SCAN = 500;

let cachedDriveClient = null;
let cachedAuth = null;
let cachedPdfContextHelpers;

function getDriveCredentials() {
    return getServiceAccountCredentials();
}

function getPdfContextHelpers() {
    if (cachedPdfContextHelpers !== undefined) {
        return cachedPdfContextHelpers;
    }

    try {
        const module = require('./lib/pdfContext');
        const hasGet = module && typeof module.getPdfContext === 'function';
        const hasPrewarm = module && typeof module.prewarmPdfContext === 'function';

        if (!hasGet || !hasPrewarm) {
            console.warn('PDF context module loaded but exports are incomplete');
            cachedPdfContextHelpers = null;
            return null;
        }

        cachedPdfContextHelpers = module;
        return cachedPdfContextHelpers;
    } catch (error) {
        console.warn('PDF context module unavailable:', error.message);
        cachedPdfContextHelpers = null;
        return null;
    }
}

const initDriveClient = () => {
    if (cachedDriveClient) return cachedDriveClient;

    try {
        const credentials = getDriveCredentials();
        cachedAuth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });
        cachedDriveClient = drive({ version: 'v3', auth: cachedAuth });
        return cachedDriveClient;
    } catch (error) {
        console.error('Drive initialization failed:', error.message);
        return null;
    }
};

const getAccessToken = async () => {
    if (!cachedAuth) initDriveClient();
    const client = await cachedAuth.getClient();
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token;
};

function naturalSort(a, b) {
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function formatFileSize(sizeValue) {
    const parsedSize = Number.parseInt(sizeValue, 10);
    if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
        return 'Unknown size';
    }
    return (parsedSize / 1024 / 1024).toFixed(1) + ' MB';
}

function resolvePdfFileId(file) {
    if (file?.mimeType === 'application/vnd.google-apps.shortcut') {
        return file?.shortcutDetails?.targetId || '';
    }
    return file?.id || '';
}

function mapDriveFileToApiFile(file) {
    const resolvedId = resolvePdfFileId(file);
    if (!isValidDriveId(resolvedId)) {
        return null;
    }

    return {
        id: resolvedId,
        name: file.name,
        size: formatFileSize(file.size),
        viewUrl: `/api/view/${resolvedId}`,
        downloadUrl: `/api/download/${resolvedId}`,
        thumbnailUrl: `/api/thumbnail/${resolvedId}`
    };
}

function chunkArray(items, chunkSize) {
    const chunks = [];
    for (let index = 0; index < items.length; index += chunkSize) {
        chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
}

async function listDriveFilesPaginated(drive, options) {
    const files = [];
    let pageToken = undefined;

    do {
        const response = await drive.files.list({
            ...options,
            pageSize: DRIVE_LIST_PAGE_SIZE,
            corpora: 'allDrives',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            pageToken
        });

        files.push(...(response.data.files || []));
        pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    return files;
}

async function listPdfFilesAcrossParents(drive, parentIds) {
    const validParentIds = parentIds.filter(isValidDriveId);
    if (!validParentIds.length) {
        return [];
    }

    const allFiles = [];
    const parentChunks = chunkArray(validParentIds, DRIVE_PARENT_QUERY_BATCH_SIZE);

    for (const parentChunk of parentChunks) {
        const parentQuery = parentChunk.map((id) => `'${id}' in parents`).join(' or ');
        const files = await listDriveFilesPaginated(drive, {
            q: `(${parentQuery}) and ${PDF_OR_SHORTCUT_QUERY} and trashed = false`,
            fields: 'nextPageToken, files(id, name, size, mimeType, shortcutDetails(targetId,targetMimeType))',
            orderBy: 'name'
        });
        allFiles.push(...files);
    }

    return allFiles;
}

async function listSubfoldersAcrossParents(drive, parentIds) {
    const validParentIds = parentIds.filter(isValidDriveId);
    if (!validParentIds.length) {
        return [];
    }

    const allFolders = [];
    const parentChunks = chunkArray(validParentIds, DRIVE_PARENT_QUERY_BATCH_SIZE);

    for (const parentChunk of parentChunks) {
        const parentQuery = parentChunk.map((id) => `'${id}' in parents`).join(' or ');
        const folders = await listDriveFilesPaginated(drive, {
            q: `(${parentQuery}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'nextPageToken, files(id, name)',
            orderBy: 'name'
        });
        allFolders.push(...folders);
    }

    return allFolders;
}

async function listPdfFilesRecursively(drive, folderId) {
    const queue = [folderId];
    const visited = new Set();
    const filesById = new Map();

    while (queue.length > 0 && visited.size < MAX_RECURSIVE_FOLDER_SCAN) {
        const currentBatch = [];
        while (queue.length > 0 && currentBatch.length < DRIVE_PARENT_QUERY_BATCH_SIZE) {
            const nextFolderId = queue.shift();
            if (!isValidDriveId(nextFolderId) || visited.has(nextFolderId)) {
                continue;
            }
            visited.add(nextFolderId);
            currentBatch.push(nextFolderId);
        }

        if (!currentBatch.length) {
            continue;
        }

        const [pdfFiles, subfolders] = await Promise.all([
            listPdfFilesAcrossParents(drive, currentBatch),
            listSubfoldersAcrossParents(drive, currentBatch)
        ]);

        for (const file of pdfFiles) {
            const resolvedId = resolvePdfFileId(file);
            if (isValidDriveId(resolvedId) && !filesById.has(resolvedId)) {
                filesById.set(resolvedId, file);
            }
        }

        for (const folder of subfolders) {
            if (isValidDriveId(folder.id) && !visited.has(folder.id)) {
                queue.push(folder.id);
            }
        }
    }

    if (queue.length > 0) {
        console.warn(
            `Folder traversal reached limit (${MAX_RECURSIVE_FOLDER_SCAN}) for root folder ${folderId}. Some PDFs may be omitted.`
        );
    }

    return Array.from(filesById.values());
}

app.get('/api/config/firebase', (req, res) => {
    const apiKey = getFirstEnv('FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_API_KEY', 'VITE_FIREBASE_API_KEY');
    const authDomain = getFirstEnv('FIREBASE_AUTH_DOMAIN', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_AUTH_DOMAIN');
    const projectId =
        getFirstEnv('FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_PROJECT_ID') ||
        deriveProjectIdFromAuthDomain(authDomain);
    const appId = getFirstEnv('FIREBASE_APP_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID', 'VITE_FIREBASE_APP_ID');
    const messagingSenderId = getFirstEnv(
        'FIREBASE_MESSAGING_SENDER_ID',
        'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
        'VITE_FIREBASE_MESSAGING_SENDER_ID'
    );
    const storageBucket =
        getFirstEnv('FIREBASE_STORAGE_BUCKET', 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_STORAGE_BUCKET') ||
        (projectId ? `${projectId}.appspot.com` : '');

    // For Firebase Auth flow, apiKey + authDomain are mandatory.
    if (!apiKey || !authDomain) {
        res.status(500).json({
            success: false,
            error: 'Firebase client config missing required values (FIREBASE_API_KEY and FIREBASE_AUTH_DOMAIN)'
        });
        return;
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
        success: true,
        data: {
            apiKey,
            authDomain,
            projectId,
            appId,
            messagingSenderId,
            storageBucket
        }
    });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({
        success: true,
        data: {
            uid: req.user.uid,
            email: req.user.email
        }
    });
});

app.post('/api/chat/by-pdf/open', requireAuth, applyChatRateLimits, async (req, res) => {
    try {
        const { pdfFileId, pdfName } = req.body || {};

        if (!isValidDriveId(pdfFileId)) {
            res.status(400).json({ success: false, error: 'Invalid pdfFileId' });
            return;
        }

        const nameError = ensureString(pdfName, { min: 1, max: 180, field: 'pdfName' });
        if (nameError) {
            res.status(400).json({ success: false, error: nameError });
            return;
        }

        const conversation = await openOrResumeConversationByPdf({
            uid: req.user.uid,
            email: req.user.email,
            pdfFileId,
            pdfName: pdfName.trim(),
            model: DEFAULT_MODEL
        });

        const drive = initDriveClient();
        const pdfContextHelpers = getPdfContextHelpers();
        if (drive && pdfContextHelpers) {
            pdfContextHelpers.prewarmPdfContext({ drive, fileId: pdfFileId });
        }

        res.json({ success: true, data: conversation });
    } catch (error) {
        console.error('Open conversation error:', error.message);
        const message = String(error && error.message ? error.message : '');
        const firestoreNotReady =
            message.includes('The database') ||
            message.includes('Cloud Firestore API') ||
            message.includes('Please create a Cloud Firestore database') ||
            message.includes('NOT_FOUND');

        if (firestoreNotReady) {
            res.status(503).json({
                success: false,
                error: 'Firestore is not ready. Create a Firestore database in Firebase Console first.'
            });
            return;
        }

        res.status(500).json({ success: false, error: 'Failed to open conversation' });
    }
});

app.get('/api/chat/conversations', requireAuth, applyChatRateLimits, async (req, res) => {
    try {
        const limit = parseLimit(req.query.limit, 20, 50);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;

        if (cursor && !isValidDocId(cursor)) {
            res.status(400).json({ success: false, error: 'Invalid cursor' });
            return;
        }

        const result = await listConversations({
            uid: req.user.uid,
            limit,
            cursor
        });

        const items = result.items.map((item) => ({
            id: item.id,
            title: item.title,
            pdfFileId: item.pdfFileId,
            pdfName: item.pdfName,
            model: item.model,
            status: item.status,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            closedAt: item.closedAt,
            lastMessagePreview: item.lastMessagePreview
        }));

        res.json({
            success: true,
            data: {
                items,
                nextCursor: result.nextCursor
            }
        });
    } catch (error) {
        console.error('List conversations error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to list conversations' });
    }
});

app.get('/api/chat/conversations/:conversationId/messages', requireAuth, applyChatRateLimits, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const limit = parseLimit(req.query.limit, 30, 50);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;

        if (!isValidDocId(conversationId)) {
            res.status(400).json({ success: false, error: 'Invalid conversationId' });
            return;
        }

        if (cursor && !isValidDocId(cursor)) {
            res.status(400).json({ success: false, error: 'Invalid cursor' });
            return;
        }

        const result = await listMessages({
            uid: req.user.uid,
            conversationId,
            limit,
            cursor
        });

        if (!result) {
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
        }

        res.json({
            success: true,
            data: {
                conversation: result.conversation,
                items: result.items,
                nextCursor: result.nextCursor
            }
        });
    } catch (error) {
        console.error('List messages error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to list messages' });
    }
});

app.post('/api/chat/conversations/:conversationId/message', requireAuth, applyChatRateLimits, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!isValidDocId(conversationId)) {
            res.status(400).json({ success: false, error: 'Invalid conversationId' });
            return;
        }

        const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
        const model = typeof req.body?.model === 'string' ? req.body.model.trim() : DEFAULT_MODEL;

        const contentError = ensureString(content, { min: 1, max: 4000, field: 'content' });
        if (contentError) {
            res.status(400).json({ success: false, error: contentError });
            return;
        }

        if (!APPROVED_MODELS.has(model)) {
            res.status(400).json({ success: false, error: 'Model not allowed' });
            return;
        }

        const conversation = await getConversation(req.user.uid, conversationId);
        if (!conversation) {
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
        }

        const userMessage = await appendMessage({
            uid: req.user.uid,
            conversationId,
            role: 'user',
            content,
            tokenUsage: null,
            error: null
        });

        if (!userMessage) {
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
        }

        await updateConversationAfterTurn({
            uid: req.user.uid,
            conversationId,
            model,
            preview: createPreview(content)
        });

        const recent = await loadRecentMessages({
            uid: req.user.uid,
            conversationId,
            limit: 20
        });

        if (!recent) {
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
        }

        const drive = initDriveClient();
        let pdfContextText = '';
        const pdfContextHelpers = getPdfContextHelpers();

        if (drive && conversation.pdfFileId && pdfContextHelpers) {
            try {
                const pdfContext = await pdfContextHelpers.getPdfContext({
                    drive,
                    fileId: conversation.pdfFileId,
                    maxChars: 12000
                });
                pdfContextText = pdfContext.text || '';
            } catch (contextError) {
                console.warn('PDF context extraction failed:', contextError.message);
            }
        }

        const systemPrompt = pdfContextText
            ? [
                `You are EduCrate Assistant for "${conversation.pdfName || 'Untitled PDF'}".`,
                'Use the extracted PDF text below as your primary source.',
                'Reply in clean plain text only (no markdown symbols like **, ##, or backticks).',
                'Keep default answers concise (<= 90 words) unless the user asks for details.',
                'Prefer 3-5 simple bullet points for explainers.',
                'If information is not present in the extracted text, clearly say that and ask a focused follow-up question.',
                '',
                '--- BEGIN EXTRACTED PDF TEXT ---',
                buildPdfContextSnippet(pdfContextText, content, 2600),
                '--- END EXTRACTED PDF TEXT ---'
            ].join('\n')
            : `You are EduCrate Assistant. The active PDF is "${conversation.pdfName || 'Untitled PDF'}" (id: ${conversation.pdfFileId || 'unknown'}). Answer from conversation context. If PDF text is unavailable, say so briefly and ask the user for a specific section/question.`;

        const modelMessages = buildModelMessages(systemPrompt, recent);

        let completion;
        try {
            completion = await createChatCompletion({
                model,
                messages: modelMessages,
                timeoutMs: 60000
            });
        } catch (error) {
            const fallbackMessage = await appendMessage({
                uid: req.user.uid,
                conversationId,
                role: 'assistant',
                content: 'I could not complete that response right now. Please retry.',
                tokenUsage: null,
                error: {
                    code: 'OPENROUTER_ERROR',
                    message: error.message || 'Model call failed'
                }
            });

            await updateConversationAfterTurn({
                uid: req.user.uid,
                conversationId,
                model,
                preview: fallbackMessage ? fallbackMessage.content : 'Assistant unavailable'
            });

            res.status(502).json({
                success: false,
                error: 'Assistant is temporarily unavailable. Please retry.',
                retryable: true,
                data: {
                    userMessage,
                    assistantMessage: fallbackMessage
                }
            });
            return;
        }

        const assistantMessage = await appendMessage({
            uid: req.user.uid,
            conversationId,
            role: 'assistant',
            content: completion.content,
            tokenUsage: completion.tokenUsage,
            error: null
        });

        await updateConversationAfterTurn({
            uid: req.user.uid,
            conversationId,
            model: completion.model,
            preview: completion.content
        });

        res.json({
            success: true,
            data: {
                userMessage,
                assistantMessage
            }
        });
    } catch (error) {
        console.error('Send message error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to send message' });
    }
});

app.post('/api/chat/conversations/:conversationId/close', requireAuth, applyChatRateLimits, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!isValidDocId(conversationId)) {
            res.status(400).json({ success: false, error: 'Invalid conversationId' });
            return;
        }

        const ok = await closeConversation({ uid: req.user.uid, conversationId });
        if (!ok) {
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Close conversation error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to close conversation' });
    }
});

app.patch('/api/chat/conversations/:conversationId', requireAuth, applyChatRateLimits, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!isValidDocId(conversationId)) {
            res.status(400).json({ success: false, error: 'Invalid conversationId' });
            return;
        }

        const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
        const titleError = ensureString(title, { min: 1, max: 120, field: 'title' });

        if (titleError) {
            res.status(400).json({ success: false, error: titleError });
            return;
        }

        const conversation = await renameConversation({
            uid: req.user.uid,
            conversationId,
            title
        });

        if (!conversation) {
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
        }

        res.json({ success: true, data: conversation });
    } catch (error) {
        console.error('Rename conversation error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to rename conversation' });
    }
});

app.delete('/api/chat/conversations/:conversationId', requireAuth, applyChatRateLimits, async (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!isValidDocId(conversationId)) {
            res.status(400).json({ success: false, error: 'Invalid conversationId' });
            return;
        }

        const ok = await softDeleteConversation({ uid: req.user.uid, conversationId });
        if (!ok) {
            res.status(404).json({ success: false, error: 'Conversation not found' });
            return;
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Delete conversation error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to delete conversation' });
    }
});

app.get('/api/folders', async (req, res) => {
    try {
        const drive = initDriveClient();
        if (!drive) {
            res.status(500).json({ success: false, error: 'Drive client initialization failed' });
            return;
        }

        const response = await drive.files.list({
            q: `'${ROOT_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)',
            orderBy: 'name',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });

        const sortedFolders = response.data.files.sort(naturalSort);
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json({ success: true, data: sortedFolders });
    } catch (error) {
        console.error('Get folders error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to retrieve folders' });
    }
});

app.get('/api/files/:folderId', async (req, res) => {
    try {
        const { folderId } = req.params;
        if (!isValidDriveId(folderId)) {
            res.status(400).json({ success: false, error: 'Invalid folder ID' });
            return;
        }

        const drive = initDriveClient();
        if (!drive) {
            res.status(500).json({ success: false, error: 'Drive client initialization failed' });
            return;
        }

        const driveFiles = await listPdfFilesRecursively(drive, folderId);
        const files = driveFiles
            .map(mapDriveFileToApiFile)
            .filter(Boolean)
            .sort(naturalSort);

        res.setHeader('Cache-Control', 'public, max-age=30');
        res.json({ success: true, data: files });
    } catch (error) {
        console.error('Get files error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to retrieve files' });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const queryInput = req.query.q;
        if (!queryInput || typeof queryInput !== 'string') {
            res.json({ success: true, data: [] });
            return;
        }

        const query = queryInput.trim();
        if (query.length < 2) {
            res.json({ success: true, data: [] });
            return;
        }

        if (query.length > 100) {
            res.status(400).json({ success: false, error: 'Query too long' });
            return;
        }

        const sanitizedQuery = query.replace(/[^a-zA-Z0-9\s\-_.]/g, '');
        if (!sanitizedQuery) {
            res.json({ success: true, data: [] });
            return;
        }

        const drive = initDriveClient();
        if (!drive) {
            res.status(500).json({ success: false, error: 'Drive client initialization failed' });
            return;
        }

        const response = await drive.files.list({
            q: `name contains '${sanitizedQuery}' and ${PDF_OR_SHORTCUT_QUERY} and trashed = false`,
            fields: 'files(id, name, size, mimeType, shortcutDetails(targetId,targetMimeType))',
            pageSize: 10,
            corpora: 'allDrives',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });

        const files = response.data.files
            .map(mapDriveFileToApiFile)
            .filter(Boolean)
            .sort(naturalSort);

        res.setHeader('Cache-Control', 'public, max-age=900');
        res.json({ success: true, data: files });
    } catch (error) {
        console.error('Search API error:', error.message);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

app.get('/api/view/:fileId', (req, res) => {
    const { fileId } = req.params;
    if (!isValidDriveId(fileId)) {
        res.status(400).json({ success: false, error: 'Invalid file ID' });
        return;
    }

    res.redirect(`https://drive.google.com/file/d/${fileId}/preview`);
});

app.get('/api/pdf/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!isValidDriveId(fileId)) {
        res.status(400).json({ success: false, error: 'Invalid file ID' });
        return;
    }

    try {
        const drive = initDriveClient();
        if (!drive) {
            res.status(500).json({ success: false, error: 'Drive client initialization failed' });
            return;
        }

        const meta = await drive.files.get({ fileId, fields: 'mimeType,name,size', supportsAllDrives: true });
        if (meta.data.mimeType !== 'application/pdf') {
            res.status(400).json({ success: false, error: 'File is not a PDF' });
            return;
        }

        const fileSizeBytes = Number.parseInt(meta.data.size, 10);
        // Netlify Functions have a hard response payload cap; large PDFs must be rendered via Drive preview.
        if (Number.isFinite(fileSizeBytes) && fileSizeBytes > NETLIFY_FUNCTION_MAX_RESPONSE_BYTES) {
            res.redirect(302, `https://drive.google.com/file/d/${fileId}/preview`);
            return;
        }

        const response = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.data.name)}"`);
        res.setHeader('Cache-Control', 'public, max-age=86400');

        if (meta.data.size) {
            res.setHeader('Content-Length', meta.data.size);
        }

        pipeline(response.data, res, (streamError) => {
            if (streamError) {
                console.error('PDF stream pipeline error:', streamError.message);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: 'Failed to fetch PDF' });
                }
            }
        });
    } catch (error) {
        console.error('PDF stream error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch PDF' });
    }
});

app.get('/api/thumbnail/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!isValidDriveId(fileId)) {
        res.status(400).json({ success: false, error: 'Invalid file ID' });
        return;
    }

    try {
        const drive = initDriveClient();
        if (!drive) {
            res.status(500).json({ success: false, error: 'Drive client initialization failed' });
            return;
        }

        const meta = await drive.files.get({ fileId, fields: 'thumbnailLink,hasThumbnail', supportsAllDrives: true });
        if (!meta.data.hasThumbnail || !meta.data.thumbnailLink) {
            res.status(404).json({ success: false, error: 'No thumbnail available' });
            return;
        }

        let thumbUrl = meta.data.thumbnailLink;
        thumbUrl = thumbUrl.replace(/=s\d+$/, '=s400');

        const accessToken = await getAccessToken();
        const thumbResponse = await fetch(thumbUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10000)
        });

        if (!thumbResponse.ok) {
            res.status(502).json({ success: false, error: 'Failed to fetch thumbnail from Drive' });
            return;
        }

        const arrayBuffer = await thumbResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Type', thumbResponse.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(buffer);
    } catch (error) {
        console.error('Thumbnail error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch thumbnail' });
    }
});

app.get('/api/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    if (!isValidDriveId(fileId)) {
        res.status(400).json({ success: false, error: 'Invalid file ID' });
        return;
    }

    try {
        const drive = initDriveClient();
        if (!drive) {
            res.status(500).json({ success: false, error: 'Drive client initialization failed' });
            return;
        }

        const meta = await drive.files.get({ fileId, fields: 'mimeType,name,size', supportsAllDrives: true });
        if (meta.data.mimeType !== 'application/pdf') {
            res.status(400).json({ success: false, error: 'File is not a PDF' });
            return;
        }

        const response = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.data.name)}"`);
        res.setHeader('Cache-Control', 'public, max-age=86400');

        if (meta.data.size) {
            res.setHeader('Content-Length', meta.data.size);
        }

        pipeline(response.data, res, (streamError) => {
            if (streamError) {
                console.error('Download stream pipeline error:', streamError.message);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: 'Failed to download PDF' });
                }
            }
        });
    } catch (error) {
        console.error('Download stream error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to download PDF' });
    }
});

app.use((error, req, res, next) => {
    if (error && error.message === 'Origin not allowed by CORS') {
        res.status(403).json({ success: false, error: 'CORS origin denied' });
        return;
    }

    console.error('Unhandled API error:', error?.message || 'Unknown error');
    res.status(500).json({ success: false, error: 'Internal server error' });
});

module.exports = app;
module.exports.handler = serverless(app, {
    binary: [
        'application/pdf',
        'application/octet-stream',
        'image/*',
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif'
    ]
});
