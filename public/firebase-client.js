(function (global) {
    const state = {
        initPromise: null,
        app: null,
        auth: null,
        googleProvider: null,
        redirectHandled: false
    };

    function mapAuthError(error) {
        const code = error && error.code ? error.code : 'auth/unknown';
        const host = (global.location && global.location.hostname) || 'this host';

        const map = {
            'auth/invalid-email': 'Please enter a valid email address.',
            'auth/email-already-in-use': 'That email is already registered. Try signing in.',
            'auth/weak-password': 'Password should be at least 6 characters.',
            'auth/user-not-found': 'No account found for that email.',
            'auth/wrong-password': 'Incorrect password.',
            'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
            'auth/popup-blocked': 'Popup blocked. Redirecting to Google sign-in.',
            'auth/operation-not-supported-in-this-environment': 'Using secure redirect sign-in on this device.',
            'auth/unauthorized-domain': `Google sign-in is blocked for ${host}. Add this domain in Firebase Auth -> Settings -> Authorized domains.`,
            'auth/operation-not-allowed': 'Google sign-in provider is disabled in Firebase console. Enable Google in Authentication -> Sign-in method.',
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
            state.googleProvider.setCustomParameters({ prompt: 'select_account' });

            if (!state.redirectHandled) {
                state.redirectHandled = true;
                try {
                    await state.auth.getRedirectResult();
                } catch (error) {
                    console.warn('Google redirect result error:', error && error.code ? error.code : error);
                }
            }

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

        const useRedirect = isLikelyMobileDevice();

        if (useRedirect) {
            try {
                await state.auth.signInWithRedirect(state.googleProvider);
                return null;
            } catch (error) {
                error.userMessage = mapAuthError(error);
                throw error;
            }
        }

        try {
            const result = await state.auth.signInWithPopup(state.googleProvider);
            return result.user;
        } catch (error) {
            if (error && (error.code === 'auth/popup-blocked' || error.code === 'auth/operation-not-supported-in-this-environment')) {
                await state.auth.signInWithRedirect(state.googleProvider);
                return null;
            }
            error.userMessage = mapAuthError(error);
            throw error;
        }
    }

    function isLikelyMobileDevice() {
        const userAgent = (global.navigator && global.navigator.userAgent) || '';
        const isSmallViewport = global.matchMedia && global.matchMedia('(max-width: 768px)').matches;
        return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || Boolean(isSmallViewport);
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
