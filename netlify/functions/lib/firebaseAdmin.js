const admin = require('firebase-admin');

let firebaseApp = null;

function getPrivateKey() {
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!rawKey || typeof rawKey !== 'string') {
        throw new Error('FIREBASE_PRIVATE_KEY is required');
    }

    return rawKey.replace(/\\n/g, '\n');
}

function getFirebaseApp() {
    if (firebaseApp) {
        return firebaseApp;
    }

    if (!admin.apps.length) {
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: getPrivateKey()
            })
        });
    } else {
        firebaseApp = admin.app();
    }

    return firebaseApp;
}

const app = getFirebaseApp();
const adminAuth = admin.auth(app);
const adminDb = admin.firestore(app);

module.exports = {
    admin,
    adminAuth,
    adminDb
};
