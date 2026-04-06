(function (global) {
    const API_BASE = '/api';
    const SEND_DEBOUNCE_MS = 250;
    const ASSISTANT_STREAM_STEP_MS = 14;
    const ASSISTANT_STREAM_CHUNK_SIZE = 6;
    const CHAT_PANEL_MIN_WIDTH = 320;
    const CHAT_PANEL_MAX_WIDTH = 560;
    const CHAT_PANEL_WIDTH_STORAGE_KEY = 'educrate-chat-panel-width';
    const AUTH_PROMPT_STORAGE_KEY = 'educrate-auth-prompted';

    const state = {
        currentUser: null,
        currentPdf: null,
        currentConversationId: null,
        conversations: [],
        conversationCursor: null,
        messagesCursor: null,
        isSending: false,
        pendingSendTimer: null,
        pendingRetryContent: null,
        activeConversationMenuId: null,
        isResizingChat: false
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

    function isNearBottom(threshold) {
        if (!elements.chatMessages) return true;
        const distance = elements.chatMessages.scrollHeight - elements.chatMessages.scrollTop - elements.chatMessages.clientHeight;
        return distance <= (Number.isFinite(threshold) ? threshold : 96);
    }

    function scrollToBottom(force) {
        if (!elements.chatMessages) return;
        if (!force && !isNearBottom(180)) return;
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function createMessageNode(message, isOptimistic, options) {
        const opts = options || {};
        const wrapper = document.createElement('div');
        const isUser = message.role === 'user';

        wrapper.className = [
            'max-w-[90%] rounded-2xl px-3 py-2.5 text-sm leading-relaxed shadow-sm border',
            isUser
                ? 'ml-auto bg-primary-600 text-white border-primary-500'
                : 'mr-auto bg-slate-100/95 dark:bg-slate-800/95 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100'
        ].join(' ');

        if (isOptimistic) {
            wrapper.classList.add('opacity-70');
        }

        const text = document.createElement('p');
        text.className = 'whitespace-pre-wrap break-words leading-6';
        text.dataset.messageContent = 'true';
        text.textContent = opts.placeholder ? 'Thinking...' : normalizeMessageText(message);
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
            .replace(/^\s*\d+\.\s+/gm, '• ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    async function streamAssistantText(node, fullText) {
        if (!node) return;

        const textEl = node.querySelector('[data-message-content]');
        if (!textEl) return;

        const cleanText = String(fullText || '').trim();
        if (!cleanText) {
            textEl.textContent = '';
            return;
        }

        const prefersReducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (prefersReducedMotion || cleanText.length < 40) {
            textEl.textContent = cleanText;
            scrollToBottom(true);
            return;
        }

        let index = 0;
        while (index < cleanText.length) {
            index = Math.min(cleanText.length, index + ASSISTANT_STREAM_CHUNK_SIZE);
            textEl.textContent = cleanText.slice(0, index);
            scrollToBottom(isNearBottom(220));
            await wait(ASSISTANT_STREAM_STEP_MS);
        }
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
        scrollToBottom(true);
    }

    function appendMessage(message, isOptimistic, options) {
        if (!elements.chatMessages) return;
        const shouldStick = isNearBottom(220);
        const empty = elements.chatMessages.querySelector('p.text-xs.text-slate-500');
        if (empty) {
            empty.remove();
        }

        const node = createMessageNode(message, Boolean(isOptimistic), options);
        elements.chatMessages.appendChild(node);
        scrollToBottom(shouldStick);
        return node;
    }

    function setComposerDisabled(disabled) {
        if (!elements.chatInput || !elements.chatSendBtn) return;
        elements.chatInput.disabled = disabled;
        elements.chatSendBtn.disabled = disabled;
        elements.chatSendBtn.classList.toggle('opacity-60', disabled);
        elements.chatSendBtn.classList.toggle('cursor-not-allowed', disabled);
        elements.chatSendBtn.textContent = disabled && state.isSending ? 'Sending...' : 'Send';
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
            state.activeConversationMenuId = null;
            renderConversations();
            return;
        }

        const data = await apiFetch('/chat/conversations?limit=20');
        state.conversations = Array.isArray(data.items) ? data.items : [];
        state.conversationCursor = data.nextCursor || null;
        state.activeConversationMenuId = null;
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
                'relative rounded-2xl border p-2.5',
                state.currentConversationId === conversation.id
                    ? 'bg-primary-50/90 dark:bg-primary-900/25 border-primary-300/70 dark:border-primary-700'
                    : 'bg-white/70 dark:bg-black/45 border-slate-200 dark:border-slate-700'
            ].join(' ');

            const topRow = document.createElement('div');
            topRow.className = 'flex items-start gap-2';

            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'text-left flex-1 min-w-0';
            openBtn.dataset.conversationId = conversation.id;

            const title = document.createElement('p');
            title.className = 'text-xs font-semibold text-slate-900 dark:text-slate-100 truncate';
            title.textContent = conversation.title || conversation.pdfName || 'Untitled chat';

            const preview = document.createElement('p');
            preview.className = 'chat-line-clamp-2 text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-4';
            preview.textContent = conversation.lastMessagePreview || conversation.pdfName || 'No preview yet';

            const stamp = document.createElement('time');
            stamp.className = 'text-[10px] text-slate-400 dark:text-slate-500 mt-1 block';
            stamp.textContent = formatTimestamp(conversation.updatedAt);

            openBtn.appendChild(title);
            openBtn.appendChild(preview);
            openBtn.appendChild(stamp);
            topRow.appendChild(openBtn);

            const actionWrap = document.createElement('div');
            actionWrap.className = 'relative flex-shrink-0';

            const actionBtn = document.createElement('button');
            actionBtn.type = 'button';
            actionBtn.dataset.convMenuToggle = conversation.id;
            actionBtn.className = 'h-7 w-7 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800';
            actionBtn.setAttribute('aria-label', 'Conversation actions');
            actionBtn.textContent = '⋯';

            const menu = document.createElement('div');
            menu.dataset.convMenu = conversation.id;
            menu.className = [
                'hidden absolute right-0 top-8 z-20 w-28 rounded-xl border border-slate-200 dark:border-slate-700',
                'bg-white dark:bg-slate-900 shadow-xl overflow-hidden'
            ].join(' ');

            const renameBtn = document.createElement('button');
            renameBtn.type = 'button';
            renameBtn.dataset.renameConversationId = conversation.id;
            renameBtn.className = 'w-full text-left px-3 py-2 text-[11px] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800';
            renameBtn.textContent = 'Rename';

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.dataset.deleteConversationId = conversation.id;
            deleteBtn.className = 'w-full text-left px-3 py-2 text-[11px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30';
            deleteBtn.textContent = 'Delete';

            menu.appendChild(renameBtn);
            menu.appendChild(deleteBtn);
            actionWrap.appendChild(actionBtn);
            actionWrap.appendChild(menu);
            topRow.appendChild(actionWrap);

            item.appendChild(topRow);
            frag.appendChild(item);
        });

        elements.chatConversationList.appendChild(frag);
        syncConversationMenuState();
    }

    function closeConversationMenus() {
        state.activeConversationMenuId = null;
        syncConversationMenuState();
    }

    function syncConversationMenuState() {
        if (!elements.chatConversationList) return;
        const menus = elements.chatConversationList.querySelectorAll('[data-conv-menu]');
        menus.forEach((menu) => {
            const menuId = menu.dataset.convMenu;
            menu.classList.toggle('hidden', menuId !== state.activeConversationMenuId);
        });
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
        const thinkingNode = appendMessage({ role: 'assistant', content: '', createdAt: Date.now() }, false, { placeholder: true });
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

            if (thinkingNode && thinkingNode.parentNode) {
                thinkingNode.parentNode.removeChild(thinkingNode);
            }

            appendMessage(data.userMessage, false);
            const streamedAssistantNode = appendMessage(
                Object.assign({}, data.assistantMessage || {}, { content: '' }),
                false
            );
            await streamAssistantText(
                streamedAssistantNode,
                normalizeMessageText(data.assistantMessage || { role: 'assistant', content: '' })
            );
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
            if (thinkingNode && thinkingNode.parentNode) {
                thinkingNode.parentNode.removeChild(thinkingNode);
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
        const email = authed ? (user.email || 'Signed in') : 'Not signed in';

        if (elements.accountMenuEmail) {
            elements.accountMenuEmail.textContent = email;
        }

        if (elements.accountSignInBtn) {
            elements.accountSignInBtn.classList.toggle('hidden', authed);
        }

        if (elements.accountSignOutBtn) {
            elements.accountSignOutBtn.classList.toggle('hidden', !authed);
        }

        if (elements.accountMenuBtn) {
            elements.accountMenuBtn.classList.toggle('text-primary-500', authed);
            elements.accountMenuBtn.classList.toggle('border-primary-300', authed);
            elements.accountMenuBtn.classList.toggle('dark:border-primary-700', authed);
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
        toggleAccountMenu(false);
        elements.authMode.value = mode || 'signin';
        elements.authTitle.textContent = mode === 'signup' ? 'Create your account' : 'Sign in to continue';
        elements.authSubmitBtn.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
        elements.authSwitchModeBtn.textContent = mode === 'signup' ? 'Already have an account? Sign in' : 'Need an account? Sign up';
        elements.authError.textContent = '';
        elements.authModal.classList.remove('hidden');
        global.requestAnimationFrame(() => {
            elements.authEmail?.focus();
        });
    }

    function closeAuthModal() {
        if (!elements.authModal) return;
        elements.authModal.classList.add('hidden');
    }

    function toggleAccountMenu(forceOpen) {
        if (!elements.accountMenuDropdown) return;
        const shouldOpen = typeof forceOpen === 'boolean'
            ? forceOpen
            : elements.accountMenuDropdown.classList.contains('hidden');
        elements.accountMenuDropdown.classList.toggle('hidden', !shouldOpen);
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
            const user = await global.firebaseClient.signInWithGoogle();
            if (user) {
                closeAuthModal();
            } else {
                setStatus('Redirecting to Google sign-in...', 'neutral');
            }
        } catch (error) {
            const code = error && error.code ? ` (${error.code})` : '';
            elements.authError.textContent = (error.userMessage || 'Google sign-in failed.') + code;
        }
    }

    function bindUiEvents() {
        elements.accountMenuBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleAccountMenu();
        });

        elements.accountSignInBtn?.addEventListener('click', () => {
            toggleAccountMenu(false);
            openAuthModal('signin');
        });

        elements.accountSignOutBtn?.addEventListener('click', async () => {
            toggleAccountMenu(false);
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
            const toggleMenuButton = event.target.closest('[data-conv-menu-toggle]');
            if (toggleMenuButton) {
                const menuId = toggleMenuButton.dataset.convMenuToggle;
                state.activeConversationMenuId = state.activeConversationMenuId === menuId ? null : menuId;
                syncConversationMenuState();
                return;
            }

            const openButton = event.target.closest('[data-conversation-id]');
            if (openButton) {
                closeConversationMenus();
                await loadConversation(openButton.dataset.conversationId);
                return;
            }

            const renameButton = event.target.closest('[data-rename-conversation-id]');
            if (renameButton) {
                closeConversationMenus();
                await renameConversationById(renameButton.dataset.renameConversationId);
                return;
            }

            const deleteButton = event.target.closest('[data-delete-conversation-id]');
            if (deleteButton) {
                closeConversationMenus();
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

        document.addEventListener('click', (event) => {
            if (elements.accountMenu && !elements.accountMenu.contains(event.target)) {
                toggleAccountMenu(false);
            }

            if (elements.chatConversationList && !elements.chatConversationList.contains(event.target)) {
                closeConversationMenus();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            toggleAccountMenu(false);
            closeConversationMenus();
            if (!elements.authModal.classList.contains('hidden')) {
                closeAuthModal();
            }
        });
    }

    function applySavedChatPanelWidth() {
        let raw = '';
        try {
            raw = localStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY) || '';
        } catch (_) {
            raw = '';
        }
        const saved = Number.parseInt(raw, 10);
        if (!Number.isFinite(saved)) return;
        const maxWidth = Math.min(CHAT_PANEL_MAX_WIDTH, Math.floor(global.innerWidth * 0.62));
        const width = Math.min(maxWidth, Math.max(CHAT_PANEL_MIN_WIDTH, saved));
        document.documentElement.style.setProperty('--chat-panel-width', `${width}px`);
    }

    function initChatResize() {
        if (!elements.chatResizeHandle) return;

        applySavedChatPanelWidth();

        let pointerId = null;
        let pendingWidth = null;
        let rafId = null;

        const flushWidth = () => {
            rafId = null;
            if (!Number.isFinite(pendingWidth)) return;
            document.documentElement.style.setProperty('--chat-panel-width', `${pendingWidth}px`);
        };

        const onPointerMove = (event) => {
            if (!state.isResizingChat || event.pointerId !== pointerId) return;
            const rawWidth = global.innerWidth - event.clientX;
            const maxWidth = Math.min(CHAT_PANEL_MAX_WIDTH, Math.floor(global.innerWidth * 0.62));
            const width = Math.min(maxWidth, Math.max(CHAT_PANEL_MIN_WIDTH, rawWidth));
            pendingWidth = width;
            if (!rafId) {
                rafId = global.requestAnimationFrame(flushWidth);
            }
        };

        const onPointerUp = (event) => {
            if (!state.isResizingChat || event.pointerId !== pointerId) return;
            state.isResizingChat = false;
            pointerId = null;
            document.body.classList.remove('chat-resizing');
            if (Number.isFinite(pendingWidth)) {
                try {
                    localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, String(Math.round(pendingWidth)));
                } catch (_) {
                    // ignore storage failures
                }
            }
        };

        elements.chatResizeHandle.addEventListener('pointerdown', (event) => {
            if (global.innerWidth < 768) return;
            state.isResizingChat = true;
            pointerId = event.pointerId;
            elements.chatResizeHandle.setPointerCapture(pointerId);
            document.body.classList.add('chat-resizing');
            event.preventDefault();
        });

        global.addEventListener('pointermove', onPointerMove);
        global.addEventListener('pointerup', onPointerUp);
        global.addEventListener('pointercancel', onPointerUp);
        global.addEventListener('resize', applySavedChatPanelWidth);
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
            let prompted = false;
            try {
                prompted = sessionStorage.getItem(AUTH_PROMPT_STORAGE_KEY) === '1';
            } catch (_) {
                prompted = false;
            }
            if (!prompted) {
                try {
                    sessionStorage.setItem(AUTH_PROMPT_STORAGE_KEY, '1');
                } catch (_) {
                    // ignore storage failures
                }
                openAuthModal('signup');
            }
            return;
        }

        try {
            closeAuthModal();
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
            accountMenu: document.getElementById('accountMenu'),
            accountMenuBtn: document.getElementById('accountMenuBtn'),
            accountMenuDropdown: document.getElementById('accountMenuDropdown'),
            accountMenuEmail: document.getElementById('accountMenuEmail'),
            accountSignInBtn: document.getElementById('accountSignInBtn'),
            accountSignOutBtn: document.getElementById('accountSignOutBtn'),
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
            chatResizeHandle: document.getElementById('chatResizeHandle'),
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
        initChatResize();
        await global.firebaseClient.init();

        await global.firebaseClient.onAuthStateChanged((user) => {
            refreshAuthAndConversations(user);
        });
    }

    async function ensureAuthenticated() {
        const user = await global.firebaseClient.getCurrentUser();
        if (user) return true;
        openAuthModal('signup');
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

        if (global.innerWidth >= 768) {
            elements.chatPanel.classList.remove('translate-x-full');
            elements.chatPanelOverlay.classList.add('hidden');
        } else {
            elements.chatPanel.classList.add('translate-x-full');
            elements.chatPanelOverlay.classList.add('hidden');
        }

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
        state.activeConversationMenuId = null;
        setComposerDisabled(true);
        if (elements.chatCurrentPdfLabel) {
            elements.chatCurrentPdfLabel.textContent = 'No active PDF';
        }
        renderConversations();
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
