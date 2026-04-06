(function (global) {
    const API_BASE = '/api';
    const SEND_DEBOUNCE_MS = 250;

    const state = {
        currentUser: null,
        currentPdf: null,
        currentConversationId: null,
        conversations: [],
        conversationCursor: null,
        messagesCursor: null,
        isSending: false,
        pendingSendTimer: null,
        pendingRetryContent: null
    };

    const elements = {};

    function formatTimestamp(ms) {
        if (!ms) return '';
        try {
            return new Date(ms).toLocaleString();
        } catch (_) {
            return '';
        }
    }

    function setStatus(text, type) {
        if (!elements.chatStatus) return;
        elements.chatStatus.textContent = text || '';
        elements.chatStatus.classList.remove('text-red-500', 'text-green-500', 'text-slate-500', 'dark:text-slate-400');

        if (type === 'error') {
            elements.chatStatus.classList.add('text-red-500');
        } else if (type === 'success') {
            elements.chatStatus.classList.add('text-green-500');
        } else {
            elements.chatStatus.classList.add('text-slate-500', 'dark:text-slate-400');
        }
    }

    function createMessageNode(message, isOptimistic) {
        const wrapper = document.createElement('div');
        const isUser = message.role === 'user';

        wrapper.className = [
            'max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed shadow-sm',
            isUser
                ? 'ml-auto bg-primary-600 text-white'
                : 'mr-auto bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
        ].join(' ');

        if (isOptimistic) {
            wrapper.classList.add('opacity-70');
        }

        const text = document.createElement('p');
        text.className = 'whitespace-pre-wrap break-words';
        text.textContent = normalizeMessageText(message);
        wrapper.appendChild(text);

        if (message.error) {
            const errorText = document.createElement('p');
            errorText.className = 'mt-2 text-xs text-red-400';
            errorText.textContent = 'Response failed. Retry available.';
            wrapper.appendChild(errorText);
        }

        if (message.createdAt) {
            const ts = document.createElement('time');
            ts.className = 'mt-1 block text-[10px] opacity-70';
            ts.textContent = formatTimestamp(message.createdAt);
            wrapper.appendChild(ts);
        }

        return wrapper;
    }

    function normalizeMessageText(message) {
        const raw = typeof message.content === 'string' ? message.content : '';
        if (message.role !== 'assistant') {
            return raw;
        }

        return raw
            .replace(/\r\n/g, '\n')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/__(.*?)__/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^\s*[-*]\s+/gm, '• ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function renderMessages(messages) {
        if (!elements.chatMessages) return;
        elements.chatMessages.innerHTML = '';

        if (!messages.length) {
            const empty = document.createElement('p');
            empty.className = 'text-xs text-slate-500 dark:text-slate-400';
            empty.textContent = 'No messages yet. Ask your first question about this PDF context.';
            elements.chatMessages.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();
        messages.forEach((message) => frag.appendChild(createMessageNode(message, false)));
        elements.chatMessages.appendChild(frag);
        scrollToBottom();
    }

    function appendMessage(message, isOptimistic) {
        if (!elements.chatMessages) return;
        const empty = elements.chatMessages.querySelector('p.text-xs.text-slate-500');
        if (empty) {
            empty.remove();
        }

        const node = createMessageNode(message, Boolean(isOptimistic));
        elements.chatMessages.appendChild(node);
        scrollToBottom();
        return node;
    }

    function scrollToBottom() {
        if (!elements.chatMessages) return;
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    }

    function setComposerDisabled(disabled) {
        if (!elements.chatInput || !elements.chatSendBtn) return;
        elements.chatInput.disabled = disabled;
        elements.chatSendBtn.disabled = disabled;
        elements.chatSendBtn.classList.toggle('opacity-60', disabled);
        elements.chatSendBtn.classList.toggle('cursor-not-allowed', disabled);
    }

    async function apiFetch(path, options) {
        const token = await global.firebaseClient.getIdToken();
        if (!token) {
            const err = new Error('Not authenticated');
            err.status = 401;
            throw err;
        }

        const controller = new AbortController();
        const timeoutMs = Number.isFinite(options && options.timeoutMs) ? options.timeoutMs : 20000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${API_BASE}${path}`, {
                method: (options && options.method) || 'GET',
                headers: Object.assign(
                    {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    options && options.headers ? options.headers : {}
                ),
                body: options && options.body ? JSON.stringify(options.body) : undefined,
                signal: controller.signal,
                credentials: 'omit'
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.success) {
                const err = new Error(payload.error || 'Request failed');
                err.status = response.status;
                err.payload = payload;
                throw err;
            }

            return payload.data;
        } catch (error) {
            if (error && error.name === 'AbortError') {
                const timeoutError = new Error('Request timed out. Please retry.');
                timeoutError.status = 408;
                throw timeoutError;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function refreshConversations() {
        if (!state.currentUser) {
            state.conversations = [];
            renderConversations();
            return;
        }

        const data = await apiFetch('/chat/conversations?limit=20');
        state.conversations = Array.isArray(data.items) ? data.items : [];
        state.conversationCursor = data.nextCursor || null;
        renderConversations();
    }

    function renderConversations() {
        if (!elements.chatConversationList) return;
        elements.chatConversationList.innerHTML = '';

        if (!state.conversations.length) {
            const empty = document.createElement('p');
            empty.className = 'text-xs text-slate-500 dark:text-slate-400';
            empty.textContent = 'No conversations yet.';
            elements.chatConversationList.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();

        state.conversations.forEach((conversation) => {
            const item = document.createElement('div');
            item.className = [
                'rounded-xl border border-slate-200 dark:border-slate-700 p-2',
                state.currentConversationId === conversation.id ? 'bg-primary-50 dark:bg-primary-900/20' : 'bg-white/70 dark:bg-black/40'
            ].join(' ');

            const topRow = document.createElement('div');
            topRow.className = 'flex items-start justify-between gap-2';

            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'text-left flex-1';
            openBtn.dataset.conversationId = conversation.id;

            const title = document.createElement('p');
            title.className = 'text-xs font-semibold text-slate-900 dark:text-slate-100 truncate';
            title.textContent = conversation.title || conversation.pdfName || 'Untitled chat';

            const preview = document.createElement('p');
            preview.className = 'text-[11px] text-slate-500 dark:text-slate-400 truncate mt-1';
            preview.textContent = conversation.lastMessagePreview || conversation.pdfName || 'No preview yet';

            const stamp = document.createElement('time');
            stamp.className = 'text-[10px] text-slate-400 dark:text-slate-500 mt-1 block';
            stamp.textContent = formatTimestamp(conversation.updatedAt);

            openBtn.appendChild(title);
            openBtn.appendChild(preview);
            openBtn.appendChild(stamp);
            topRow.appendChild(openBtn);

            const actionWrap = document.createElement('div');
            actionWrap.className = 'flex items-center gap-1';

            const renameBtn = document.createElement('button');
            renameBtn.type = 'button';
            renameBtn.dataset.renameConversationId = conversation.id;
            renameBtn.className = 'px-2 py-1 rounded border border-slate-300 dark:border-slate-600 text-[10px]';
            renameBtn.textContent = 'Rename';

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.dataset.deleteConversationId = conversation.id;
            deleteBtn.className = 'px-2 py-1 rounded border border-red-300 text-red-500 text-[10px]';
            deleteBtn.textContent = 'Delete';

            actionWrap.appendChild(renameBtn);
            actionWrap.appendChild(deleteBtn);
            topRow.appendChild(actionWrap);

            item.appendChild(topRow);
            frag.appendChild(item);
        });

        elements.chatConversationList.appendChild(frag);
    }

    async function loadConversation(conversationId) {
        const data = await apiFetch(`/chat/conversations/${encodeURIComponent(conversationId)}/messages?limit=40`);
        state.currentConversationId = conversationId;
        state.messagesCursor = data.nextCursor || null;
        renderMessages(Array.isArray(data.items) ? data.items : []);
        renderConversations();
        setComposerDisabled(false);

        if (data.conversation && elements.chatCurrentPdfLabel) {
            elements.chatCurrentPdfLabel.textContent = data.conversation.pdfName || 'Active PDF chat';
        }
    }

    async function openConversationForPdf(pdfFileId, pdfName) {
        const data = await apiFetch('/chat/by-pdf/open', {
            method: 'POST',
            body: { pdfFileId, pdfName }
        });

        state.currentConversationId = data.id;
        if (elements.chatCurrentPdfLabel) {
            elements.chatCurrentPdfLabel.textContent = data.pdfName || pdfName;
        }

        await Promise.all([refreshConversations(), loadConversation(data.id)]);
        setStatus('Connected to chat session', 'success');
        setTimeout(() => setStatus('', 'neutral'), 1200);
    }

    async function closeActiveConversation() {
        if (!state.currentConversationId || !state.currentUser) return;

        try {
            await apiFetch(`/chat/conversations/${encodeURIComponent(state.currentConversationId)}/close`, {
                method: 'POST',
                body: {}
            });
        } catch (_) {
            // best-effort close
        }
    }

    async function renameConversationById(conversationId) {
        const current = state.conversations.find((item) => item.id === conversationId);
        if (!current) return;

        const nextTitle = window.prompt('Rename conversation', current.title || current.pdfName || 'Untitled chat');
        if (!nextTitle || !nextTitle.trim()) {
            return;
        }

        await apiFetch(`/chat/conversations/${encodeURIComponent(conversationId)}`, {
            method: 'PATCH',
            body: { title: nextTitle.trim() }
        });

        await refreshConversations();
    }

    async function deleteConversationById(conversationId) {
        const confirmed = window.confirm('Delete this conversation? This action hides it from your sidebar.');
        if (!confirmed) return;

        await apiFetch(`/chat/conversations/${encodeURIComponent(conversationId)}`, {
            method: 'DELETE'
        });

        if (state.currentConversationId === conversationId) {
            state.currentConversationId = null;
            renderMessages([]);
        }

        await refreshConversations();
    }

    async function sendMessageNow(content) {
        if (state.isSending || !state.currentConversationId) {
            return;
        }

        state.isSending = true;
        elements.chatRetryBtn?.classList.add('hidden');
        setComposerDisabled(true);
        setStatus('Thinking...', 'neutral');

        const optimisticNode = appendMessage({ role: 'user', content, createdAt: Date.now() }, true);
        elements.chatInput.value = '';

        try {
            const data = await apiFetch(`/chat/conversations/${encodeURIComponent(state.currentConversationId)}/message`, {
                method: 'POST',
                body: { content },
                timeoutMs: 60000
            });

            if (optimisticNode && optimisticNode.parentNode) {
                optimisticNode.parentNode.removeChild(optimisticNode);
            }

            appendMessage(data.userMessage, false);
            appendMessage(data.assistantMessage, false);
            state.pendingRetryContent = null;
            elements.chatRetryBtn?.classList.add('hidden');
            setStatus('', 'neutral');
            try {
                await refreshConversations();
            } catch (refreshError) {
                console.warn('Conversation list refresh failed:', refreshError.message);
            }
        } catch (error) {
            if (optimisticNode && optimisticNode.parentNode) {
                optimisticNode.classList.remove('opacity-70');
            }

            state.pendingRetryContent = content;
            const retryable = error && error.payload && error.payload.retryable;
            if (retryable && elements.chatRetryBtn) {
                elements.chatRetryBtn.classList.remove('hidden');
            } else {
                elements.chatRetryBtn?.classList.add('hidden');
            }

            const failedAssistant = error && error.payload && error.payload.data && error.payload.data.assistantMessage;
            if (failedAssistant) {
                appendMessage(failedAssistant, false);
            }

            const friendlyMessage =
                error && error.message && error.message.toLowerCase().includes('aborted')
                    ? 'Request timed out. Please retry.'
                    : (error.message || 'Message failed');
            setStatus(friendlyMessage, 'error');
        } finally {
            state.isSending = false;
            setComposerDisabled(false);
        }
    }

    function queueSendMessage() {
        const content = elements.chatInput.value.trim();
        if (!content) return;

        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
        }

        state.pendingSendTimer = setTimeout(() => {
            state.pendingSendTimer = null;
            sendMessageNow(content);
        }, SEND_DEBOUNCE_MS);
    }

    function setAuthUi(user) {
        const authed = Boolean(user);

        if (elements.authOpenBtn) {
            elements.authOpenBtn.classList.toggle('hidden', authed);
        }

        if (elements.authLogoutBtn) {
            elements.authLogoutBtn.classList.toggle('hidden', !authed);
        }

        if (elements.authUserLabel) {
            elements.authUserLabel.classList.toggle('hidden', !authed);
            elements.authUserLabel.textContent = authed ? (user.email || 'Signed in') : '';
        }

        if (!authed) {
            elements.chatAuthHint?.classList.remove('hidden');
            setComposerDisabled(true);
        } else {
            elements.chatAuthHint?.classList.add('hidden');
            setComposerDisabled(!state.currentConversationId);
        }
    }

    function openAuthModal(mode) {
        if (!elements.authModal) return;
        elements.authMode.value = mode || 'signin';
        elements.authTitle.textContent = mode === 'signup' ? 'Create your account' : 'Sign in to continue';
        elements.authSubmitBtn.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
        elements.authSwitchModeBtn.textContent = mode === 'signup' ? 'Already have an account? Sign in' : 'Need an account? Sign up';
        elements.authError.textContent = '';
        elements.authModal.classList.remove('hidden');
    }

    function closeAuthModal() {
        if (!elements.authModal) return;
        elements.authModal.classList.add('hidden');
    }

    async function handleAuthSubmit(event) {
        event.preventDefault();

        const email = elements.authEmail.value.trim();
        const password = elements.authPassword.value;
        const mode = elements.authMode.value;

        elements.authError.textContent = '';
        elements.authSubmitBtn.disabled = true;

        try {
            if (mode === 'signup') {
                await global.firebaseClient.signUpWithEmail(email, password);
            } else {
                await global.firebaseClient.signInWithEmail(email, password);
            }

            closeAuthModal();
        } catch (error) {
            elements.authError.textContent = error.userMessage || 'Authentication failed.';
        } finally {
            elements.authSubmitBtn.disabled = false;
        }
    }

    async function handleGoogleSignIn() {
        elements.authError.textContent = '';

        try {
            await global.firebaseClient.signInWithGoogle();
            closeAuthModal();
        } catch (error) {
            elements.authError.textContent = error.userMessage || 'Google sign-in failed.';
        }
    }

    function bindUiEvents() {
        elements.authOpenBtn?.addEventListener('click', () => openAuthModal('signin'));
        elements.authLogoutBtn?.addEventListener('click', async () => {
            await global.firebaseClient.signOut();
        });

        elements.authCloseBtn?.addEventListener('click', closeAuthModal);
        elements.authBackdrop?.addEventListener('click', closeAuthModal);
        elements.authForm?.addEventListener('submit', handleAuthSubmit);
        elements.authGoogleBtn?.addEventListener('click', handleGoogleSignIn);
        elements.authSwitchModeBtn?.addEventListener('click', () => {
            const nextMode = elements.authMode.value === 'signup' ? 'signin' : 'signup';
            openAuthModal(nextMode);
        });

        elements.chatSendBtn?.addEventListener('click', queueSendMessage);
        elements.chatInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                queueSendMessage();
            }
        });

        elements.chatRetryBtn?.addEventListener('click', () => {
            if (state.pendingRetryContent) {
                elements.chatRetryBtn.classList.add('hidden');
                sendMessageNow(state.pendingRetryContent);
            }
        });

        elements.chatConversationList?.addEventListener('click', async (event) => {
            const openButton = event.target.closest('[data-conversation-id]');
            if (openButton) {
                await loadConversation(openButton.dataset.conversationId);
                return;
            }

            const renameButton = event.target.closest('[data-rename-conversation-id]');
            if (renameButton) {
                await renameConversationById(renameButton.dataset.renameConversationId);
                return;
            }

            const deleteButton = event.target.closest('[data-delete-conversation-id]');
            if (deleteButton) {
                await deleteConversationById(deleteButton.dataset.deleteConversationId);
            }
        });

        elements.chatMobileToggleBtn?.addEventListener('click', () => {
            elements.chatPanel.classList.remove('translate-x-full');
            elements.chatPanelOverlay.classList.remove('hidden');
        });

        elements.chatPanelCloseBtn?.addEventListener('click', () => {
            elements.chatPanel.classList.add('translate-x-full');
            elements.chatPanelOverlay.classList.add('hidden');
        });

        elements.chatPanelOverlay?.addEventListener('click', () => {
            elements.chatPanel.classList.add('translate-x-full');
            elements.chatPanelOverlay.classList.add('hidden');
        });
    }

    async function refreshAuthAndConversations(user) {
        state.currentUser = user || null;
        setAuthUi(user || null);

        if (!user) {
            state.currentConversationId = null;
            state.conversations = [];
            renderConversations();
            renderMessages([]);
            setComposerDisabled(true);
            return;
        }

        try {
            await refreshConversations();
            if (state.currentPdf) {
                await openConversationForPdf(state.currentPdf.id, state.currentPdf.name);
            }
        } catch (error) {
            setStatus(error.message || 'Failed to load conversations', 'error');
        }
    }

    async function init() {
        Object.assign(elements, {
            authOpenBtn: document.getElementById('authOpenBtn'),
            authLogoutBtn: document.getElementById('authLogoutBtn'),
            authUserLabel: document.getElementById('authUserLabel'),
            authModal: document.getElementById('authModal'),
            authBackdrop: document.getElementById('authBackdrop'),
            authCloseBtn: document.getElementById('authCloseBtn'),
            authTitle: document.getElementById('authTitle'),
            authForm: document.getElementById('authForm'),
            authMode: document.getElementById('authMode'),
            authEmail: document.getElementById('authEmail'),
            authPassword: document.getElementById('authPassword'),
            authSubmitBtn: document.getElementById('authSubmitBtn'),
            authGoogleBtn: document.getElementById('authGoogleBtn'),
            authSwitchModeBtn: document.getElementById('authSwitchModeBtn'),
            authError: document.getElementById('authError'),
            chatPanel: document.getElementById('chatPanel'),
            chatPanelOverlay: document.getElementById('chatPanelOverlay'),
            chatMobileToggleBtn: document.getElementById('chatMobileToggleBtn'),
            chatPanelCloseBtn: document.getElementById('chatPanelCloseBtn'),
            chatCurrentPdfLabel: document.getElementById('chatCurrentPdfLabel'),
            chatConversationList: document.getElementById('chatConversationList'),
            chatMessages: document.getElementById('chatMessages'),
            chatInput: document.getElementById('chatInput'),
            chatSendBtn: document.getElementById('chatSendBtn'),
            chatRetryBtn: document.getElementById('chatRetryBtn'),
            chatStatus: document.getElementById('chatStatus'),
            chatAuthHint: document.getElementById('chatAuthHint')
        });

        bindUiEvents();
        await global.firebaseClient.init();

        await global.firebaseClient.onAuthStateChanged((user) => {
            refreshAuthAndConversations(user);
        });
    }

    async function ensureAuthenticated() {
        const user = await global.firebaseClient.getCurrentUser();
        if (user) return true;
        openAuthModal('signin');
        setStatus('Sign in to use chat', 'error');
        return false;
    }

    async function onPdfOpened(file) {
        state.currentPdf = file;

        const isAuthed = await ensureAuthenticated();
        if (!isAuthed) {
            renderMessages([]);
            return;
        }

        elements.chatPanel.classList.remove('translate-x-full');
        elements.chatPanelOverlay.classList.add('hidden');

        try {
            await openConversationForPdf(file.id, file.name);
        } catch (error) {
            setStatus(error.message || 'Failed to bind chat to PDF', 'error');
        }
    }

    async function onPdfClosed() {
        await closeActiveConversation();
        state.currentPdf = null;
        state.currentConversationId = null;
        setComposerDisabled(true);
        elements.chatPanel.classList.add('translate-x-full');
        elements.chatPanelOverlay.classList.add('hidden');
    }

    global.chatApp = {
        init,
        onPdfOpened,
        onPdfClosed,
        ensureAuthenticated,
        refreshConversations
    };
})(window);
