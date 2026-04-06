(function (global) {
    const state = {
        initPromise: null,
        app: null,
        auth: null,
        googleProvider: null
    };

    function mapAuthError(error) {
        const code = error && error.code ? error.code : 'auth/unknown';

        const map = {
            'auth/invalid-email': 'Please enter a valid email address.',
            'auth/email-already-in-use': 'That email is already registered. Try signing in.',
            'auth/weak-password': 'Password should be at least 6 characters.',
            'auth/user-not-found': 'No account found for that email.',
            'auth/wrong-password': 'Incorrect password.',
            'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
            'auth/network-request-failed': 'Network error. Please check your connection.',
            'auth/too-many-requests': 'Too many attempts. Please try again later.'
        };

        return map[code] || 'Authentication failed. Please try again.';
    }

    async function fetchFirebaseConfig() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        try {
            const response = await fetch('/api/config/firebase', {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                credentials: 'omit'
            });

            if (!response.ok) {
                throw new Error('Unable to load Firebase config');
            }

            const payload = await response.json();
            if (!payload.success || !payload.data) {
                throw new Error('Invalid Firebase config response');
            }

            return payload.data;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function init() {
        if (state.initPromise) {
            return state.initPromise;
        }

        state.initPromise = (async () => {
            if (!global.firebase) {
                throw new Error('Firebase SDK not loaded');
            }

            const config = await fetchFirebaseConfig();
            state.app = firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
            state.auth = firebase.auth();
            state.googleProvider = new firebase.auth.GoogleAuthProvider();

            return {
                app: state.app,
                auth: state.auth
            };
        })();

        return state.initPromise;
    }

    async function signUpWithEmail(email, password) {
        await init();

        try {
            const result = await state.auth.createUserWithEmailAndPassword(email, password);
            return result.user;
        } catch (error) {
            error.userMessage = mapAuthError(error);
            throw error;
        }
    }

    async function signInWithEmail(email, password) {
        await init();

        try {
            const result = await state.auth.signInWithEmailAndPassword(email, password);
            return result.user;
        } catch (error) {
            error.userMessage = mapAuthError(error);
            throw error;
        }
    }

    async function signInWithGoogle() {
        await init();

        try {
            const result = await state.auth.signInWithPopup(state.googleProvider);
            return result.user;
        } catch (error) {
            error.userMessage = mapAuthError(error);
            throw error;
        }
    }

    async function signOut() {
        await init();
        await state.auth.signOut();
    }

    async function getCurrentUser() {
        await init();
        return state.auth.currentUser;
    }

    async function getIdToken(forceRefresh) {
        await init();
        const user = state.auth.currentUser;
        if (!user) {
            return null;
        }
        return user.getIdToken(Boolean(forceRefresh));
    }

    async function onAuthStateChanged(listener) {
        await init();
        return state.auth.onAuthStateChanged(listener);
    }

    global.firebaseClient = {
        init,
        signUpWithEmail,
        signInWithEmail,
        signInWithGoogle,
        signOut,
        getCurrentUser,
        getIdToken,
        onAuthStateChanged,
        mapAuthError
    };
})(window);
