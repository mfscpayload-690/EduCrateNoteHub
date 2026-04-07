const admin = require('firebase-admin');

let firebaseApp = null;
let adminAuth = null;
let adminDb = null;

function normalizePrivateKey(value) {
    if (!value || typeof value !== 'string') {
        return '';
    }
    const trimmed = value.trim();
    const unwrapped =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
            ? trimmed.slice(1, -1)
            : trimmed;
    return unwrapped.replace(/\\n/g, '\n');
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
        (typeof process.env.FIREBASE_PROJECT_ID === 'string' ? process.env.FIREBASE_PROJECT_ID.trim() : '') ||
        (typeof parsed.project_id === 'string' ? parsed.project_id.trim() : '');

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing required service-account fields');
    }

    return {
        projectId,
        clientEmail,
        privateKey
    };
}

function getFirebaseCredentials() {
    const fromJson = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (fromJson) {
        return fromJson;
    }

    const projectId = typeof process.env.FIREBASE_PROJECT_ID === 'string' ? process.env.FIREBASE_PROJECT_ID.trim() : '';
    const clientEmail = typeof process.env.FIREBASE_CLIENT_EMAIL === 'string' ? process.env.FIREBASE_CLIENT_EMAIL.trim() : '';
    const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (or GOOGLE_SERVICE_ACCOUNT_JSON)');
    }

    return {
        projectId,
        clientEmail,
        privateKey
    };
}

function getFirebaseApp() {
    if (firebaseApp) {
        return firebaseApp;
    }

    if (!admin.apps.length) {
        const credentials = getFirebaseCredentials();
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: credentials.projectId,
                clientEmail: credentials.clientEmail,
                privateKey: credentials.privateKey
            })
        });
    } else {
        firebaseApp = admin.app();
    }

    return firebaseApp;
}

function getAdminAuth() {
    if (adminAuth) {
        return adminAuth;
    }
    const app = getFirebaseApp();
    adminAuth = admin.auth(app);
    return adminAuth;
}

function getAdminDb() {
    if (adminDb) {
        return adminDb;
    }
    const app = getFirebaseApp();
    adminDb = admin.firestore(app);
    return adminDb;
}

module.exports = {
    admin,
    getAdminAuth,
    getAdminDb
};
