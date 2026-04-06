const { adminDb, admin } = require('./firebaseAdmin');

const USERS_COLLECTION = 'users';
const CONVERSATIONS_COLLECTION = 'conversations';
const MESSAGES_COLLECTION = 'messages';

function assertUid(uid) {
    if (!uid || typeof uid !== 'string') {
        throw new Error('uid is required');
    }
}

function clampLimit(limit, defaultValue = 20, maxValue = 50) {
    const parsed = Number.parseInt(limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return defaultValue;
    }
    return Math.min(parsed, maxValue);
}

function toMillis(timestampValue) {
    if (!timestampValue) return null;
    if (typeof timestampValue.toMillis === 'function') return timestampValue.toMillis();
    return null;
}

function createPreview(text, maxLength = 180) {
    if (!text || typeof text !== 'string') return '';
    const compact = text
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/__(.*?)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*[-*]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, maxLength - 3)}...`;
}

function userRef(uid) {
    assertUid(uid);
    return adminDb.collection(USERS_COLLECTION).doc(uid);
}

function conversationsRef(uid) {
    return userRef(uid).collection(CONVERSATIONS_COLLECTION);
}

function conversationRef(uid, conversationId) {
    return conversationsRef(uid).doc(conversationId);
}

function messagesRef(uid, conversationId) {
    return conversationRef(uid, conversationId).collection(MESSAGES_COLLECTION);
}

function conversationFromSnapshot(snapshot) {
    const data = snapshot.data();
    if (!data) return null;

    return {
        id: snapshot.id,
        title: data.title || 'Untitled chat',
        pdfFileId: data.pdfFileId || null,
        pdfName: data.pdfName || null,
        model: data.model || null,
        status: data.status || 'active',
        createdAt: toMillis(data.createdAt),
        updatedAt: toMillis(data.updatedAt),
        closedAt: toMillis(data.closedAt),
        lastMessagePreview: data.lastMessagePreview || '',
        isDeleted: Boolean(data.isDeleted)
    };
}

function messageFromSnapshot(snapshot) {
    const data = snapshot.data();
    if (!data) return null;

    return {
        id: snapshot.id,
        role: data.role,
        content: data.content,
        createdAt: toMillis(data.createdAt),
        tokenUsage: data.tokenUsage || null,
        error: data.error || null
    };
}

async function ensureUserDoc(uid, email) {
    const now = admin.firestore.FieldValue.serverTimestamp();
    await userRef(uid).set(
        {
            email: email || null,
            updatedAt: now,
            createdAt: now
        },
        { merge: true }
    );
}

async function getConversation(uid, conversationId) {
    const snapshot = await conversationRef(uid, conversationId).get();
    if (!snapshot.exists) {
        return null;
    }

    const conversation = conversationFromSnapshot(snapshot);
    if (!conversation || conversation.isDeleted) {
        return null;
    }

    return conversation;
}

async function openOrResumeConversationByPdf({ uid, email, pdfFileId, pdfName, model }) {
    await ensureUserDoc(uid, email);

    const now = admin.firestore.FieldValue.serverTimestamp();
    const convQuery = await conversationsRef(uid)
        .where('pdfFileId', '==', pdfFileId)
        .limit(25)
        .get();

    const resumeCandidate = convQuery.docs
        .map((doc) => ({
            doc,
            data: doc.data()
        }))
        .filter((item) => item.data && item.data.isDeleted !== true)
        .sort((a, b) => {
            const aUpdated = toMillis(a.data.updatedAt) || toMillis(a.data.createdAt) || 0;
            const bUpdated = toMillis(b.data.updatedAt) || toMillis(b.data.createdAt) || 0;
            return bUpdated - aUpdated;
        })[0];

    if (resumeCandidate) {
        const doc = resumeCandidate.doc;
        await doc.ref.set(
            {
                status: 'active',
                closedAt: null,
                updatedAt: now,
                pdfName,
                model: model || null
            },
            { merge: true }
        );

        const refreshed = await doc.ref.get();
        return conversationFromSnapshot(refreshed);
    }

    const docRef = conversationsRef(uid).doc();
    await docRef.set({
        title: pdfName || 'New chat',
        pdfFileId,
        pdfName,
        model: model || null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        lastMessagePreview: '',
        isDeleted: false,
        deletedAt: null
    });

    const created = await docRef.get();
    return conversationFromSnapshot(created);
}

async function listConversations({ uid, limit, cursor }) {
    let query = conversationsRef(uid)
        .orderBy('updatedAt', 'desc')
        .limit(clampLimit(limit, 20, 50));

    if (cursor) {
        const cursorDoc = await conversationRef(uid, cursor).get();
        if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
        }
    }

    const snapshot = await query.get();
    const items = snapshot.docs
        .map((doc) => conversationFromSnapshot(doc))
        .filter((item) => item && !item.isDeleted);

    const nextCursor = snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1].id : null;
    return {
        items,
        nextCursor
    };
}

async function listMessages({ uid, conversationId, limit, cursor }) {
    const conversation = await getConversation(uid, conversationId);
    if (!conversation) {
        return null;
    }

    let query = messagesRef(uid, conversationId)
        .orderBy('createdAt', 'desc')
        .limit(clampLimit(limit, 30, 50));

    if (cursor) {
        const cursorDoc = await messagesRef(uid, conversationId).doc(cursor).get();
        if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
        }
    }

    const snapshot = await query.get();
    const items = snapshot.docs
        .map((doc) => messageFromSnapshot(doc))
        .filter(Boolean)
        .reverse();

    const nextCursor = snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1].id : null;

    return {
        conversation,
        items,
        nextCursor
    };
}

async function appendMessage({ uid, conversationId, role, content, tokenUsage = null, error = null }) {
    const conversation = await getConversation(uid, conversationId);
    if (!conversation) {
        return null;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const docRef = messagesRef(uid, conversationId).doc();

    await docRef.set({
        role,
        content,
        createdAt: now,
        tokenUsage,
        error
    });

    const saved = await docRef.get();
    return messageFromSnapshot(saved);
}

async function loadRecentMessages({ uid, conversationId, limit = 20 }) {
    const conversation = await getConversation(uid, conversationId);
    if (!conversation) {
        return null;
    }

    const snapshot = await messagesRef(uid, conversationId)
        .orderBy('createdAt', 'desc')
        .limit(clampLimit(limit, 20, 40))
        .get();

    return snapshot.docs
        .map((doc) => messageFromSnapshot(doc))
        .filter(Boolean)
        .reverse();
}

async function updateConversationAfterTurn({ uid, conversationId, model, preview }) {
    const conversation = await getConversation(uid, conversationId);
    if (!conversation) {
        return false;
    }

    await conversationRef(uid, conversationId).set(
        {
            model: model || conversation.model || null,
            status: 'active',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastMessagePreview: createPreview(preview)
        },
        { merge: true }
    );

    return true;
}

async function closeConversation({ uid, conversationId }) {
    const conversation = await getConversation(uid, conversationId);
    if (!conversation) {
        return false;
    }

    await conversationRef(uid, conversationId).set(
        {
            status: 'closed',
            closedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
    );

    return true;
}

async function renameConversation({ uid, conversationId, title }) {
    const conversation = await getConversation(uid, conversationId);
    if (!conversation) {
        return null;
    }

    await conversationRef(uid, conversationId).set(
        {
            title,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
    );

    const updated = await conversationRef(uid, conversationId).get();
    return conversationFromSnapshot(updated);
}

async function softDeleteConversation({ uid, conversationId }) {
    const conversation = await getConversation(uid, conversationId);
    if (!conversation) {
        return false;
    }

    await conversationRef(uid, conversationId).set(
        {
            isDeleted: true,
            deletedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'deleted',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
    );

    return true;
}

module.exports = {
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
};
