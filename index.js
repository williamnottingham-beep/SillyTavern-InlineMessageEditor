(() => {
    'use strict';

    const MODULE = 'Seamless Message Edit';
    const CHAT_SELECTOR = '#chat';
    const EDITOR_SELECTOR = '.edit_textarea';
    const INTERACTIVE_SELECTOR = [
        'button', 'a', 'input', 'textarea', 'select', 'option', 'details', 'summary',
        '[contenteditable="true"]', '[role="button"]',
        '.mes_buttons', '.mes_edit_buttons', '.mes_reasoning_details',
        '.mes_reasoning_header', '.mes_reasoning_header_title', '.mes_reasoning',
        '.mes_reasoning_actions', '.mes_reasoning_summary', '.mes_reasoning_edit',
        '.mes_reasoning_edit_done', '.mes_reasoning_edit_cancel', '.mes_reasoning_copy',
        '.mes_reasoning_delete', '.mes_edit_add_reasoning', '.reasoning_edit_textarea',
        '.mes_reasoning_edit_buttons', '.mes_reasoning_content', '.mes_reasoning_body',
        '.mes_reasoning_text', '.mes_thoughts', '.mes_img', '.mes_img_container',
        '.mes_img_overlay', '.mesIDDisplay', '.mesIDDisplay_enabled',
        '.avatar', '.ch_name', 'video', 'audio', 'iframe',
        '.sme-edit-toolbar', '.extraMesButtons', '.extraMesButtonsHint',
    ].join(',');

    // Reasoning UI has changed markup across SillyTavern releases and themes.
    // Inspect every ancestor up to the message card, rather than depending on one class.
    function isReasoningArea(target, messageElement) {
        let node = target instanceof Element ? target : null;
        while (node && node !== messageElement) {
            if (node.matches('details, summary, [data-reasoning], [data-thought], [class*="reasoning" i], [class*="thought" i], [class*="chain-of-thought" i]')) {
                return true;
            }
            node = node.parentElement;
        }
        return false;
    }

    let context;
    let chatObserver;
    let settingsObserver;
    let initialized = false;
    let formatterPromise;
    const sessions = new WeakMap();

    function log(...args) {
        console.debug(`[${MODULE}]`, ...args);
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function getMessageIndex(messageElement) {
        const index = Number(messageElement?.getAttribute('mesid'));
        return Number.isInteger(index) && index >= 0 ? index : -1;
    }

    function getRawMessage(messageElement) {
        const index = getMessageIndex(messageElement);
        return index >= 0 ? String(context?.chat?.[index]?.mes ?? '') : '';
    }

    function ensureControlsLayer(messageElement) {
        let layer = Array.from(messageElement.children).find(child => child.classList?.contains('sme-controls-layer'));
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'sme-controls-layer';
            layer.setAttribute('aria-label', 'Message editing controls');
            messageElement.append(layer);
        }
        return layer;
    }

    function moveToolbarToLayer(messageElement, layer, position) {
        const selector = `.sme-edit-toolbar-${position}`;
        let toolbar = layer.querySelector(selector);
        if (!toolbar) {
            toolbar = messageElement.querySelector(selector) || makeToolbar(position);
            layer.append(toolbar);
        }
        return toolbar;
    }

    function positionToolbarLayer(messageElement, messageText) {
        const layer = ensureControlsLayer(messageElement);
        if (!messageElement.isConnected || !messageText?.isConnected) return;
        const messageRect = messageElement.getBoundingClientRect();
        const textRect = messageText.getBoundingClientRect();
        const topOffset = Math.max(0, textRect.top - messageRect.top);
        const bottomOffset = Math.max(0, messageRect.bottom - textRect.bottom);
        layer.style.setProperty('--sme-toolbar-top', `${topOffset}px`);
        layer.style.setProperty('--sme-toolbar-bottom', `${bottomOffset}px`);
    }

    function hideClickToEditSetting() {
        const input = document.querySelector('#click_to_edit');
        if (!input) return;

        let settingRow = input.closest('label')
            || document.querySelector('label[for="click_to_edit"]');

        if (!settingRow) {
            let candidate = input.parentElement;
            for (let depth = 0; candidate && depth < 4; depth++, candidate = candidate.parentElement) {
                const text = (candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim();
                if (/click to edit/i.test(text) && candidate.querySelectorAll('input').length <= 1) {
                    settingRow = candidate;
                    break;
                }
            }
        }

        if (settingRow) settingRow.classList.add('sme-hidden-setting');
        input.classList.add('sme-hidden-setting');

        if (input.checked) {
            input.checked = false;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (context?.power_user?.click_to_edit) {
            context.power_user.click_to_edit = false;
            context.saveSettingsDebounced?.();
        }
    }

    function makeButton(action, label, icon) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `sme-action sme-action-${action}`;
        button.dataset.smeAction = action;
        button.setAttribute('aria-label', label);
        button.title = label;

        const symbol = document.createElement('span');
        symbol.className = 'sme-action-icon';
        symbol.setAttribute('aria-hidden', 'true');
        symbol.textContent = icon;

        const text = document.createElement('span');
        text.className = 'sme-action-label';
        text.textContent = label;
        button.append(symbol, text);
        return button;
    }

    function makeToolbar(position) {
        const toolbar = document.createElement('div');
        toolbar.className = `sme-edit-toolbar sme-edit-toolbar-${position}`;
        toolbar.setAttribute('role', 'group');
        toolbar.setAttribute('aria-label', position === 'top' ? 'Message editing controls' : 'Message editing controls at bottom');

        if (position === 'top') {
            const title = document.createElement('span');
            title.className = 'sme-editing-label';
            title.innerHTML = '<span class="sme-editing-dot" aria-hidden="true"></span><span>Editing message</span>';
            toolbar.append(title);
        } else {
            const hint = document.createElement('span');
            hint.className = 'sme-editing-hint';
            hint.textContent = 'Ctrl + Enter to save';
            toolbar.append(hint);
        }

        const actions = document.createElement('div');
        actions.className = 'sme-edit-actions';
        actions.append(
            makeButton('source', 'Show source', '</>'),
            makeButton('cancel', 'Cancel', '×'),
            makeButton('save', 'Save changes', '✓'),
        );
        toolbar.append(actions);
        return toolbar;
    }

    function getFormatter() {
        if (!formatterPromise) {
            // SillyTavern documents /script.js as the import path for exported core APIs.
            formatterPromise = import('/script.js')
                .then(module => typeof module.messageFormatting === 'function' ? module.messageFormatting : null)
                .catch(error => {
                    console.warn(`[${MODULE}] Could not import SillyTavern's message formatter; using a basic preview.`, error);
                    return null;
                });
        }
        return formatterPromise;
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function basicMarkdownPreview(raw) {
        // Fallback only. The preferred path uses SillyTavern's actual message formatter.
        let html = escapeHtml(raw);
        html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
            .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
            .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
            .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
            .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
            .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
            .replace(/^&gt; ?(.+)$/gm, '<blockquote>$1</blockquote>')
            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/__(.+?)__/g, '<u>$1</u>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');
        return html;
    }

    async function formatSource(raw, messageElement) {
        const formatter = await getFormatter();
        const index = getMessageIndex(messageElement);
        const message = context?.chat?.[index];
        if (!message) return basicMarkdownPreview(raw);
        if (!formatter) return basicMarkdownPreview(raw);
        // The core formatter has a special first-message macro substitution path that may
        // update chat[0].mes as a side effect. Previewing source must not mutate saved chat data.
        const storedText = message.mes;
        try {
            return formatter(raw, message.name || (message.is_user ? context?.name1 : context?.name2) || '',
                !!message.is_system, !!message.is_user, index, {}, false);
        } catch (error) {
            console.warn(`[${MODULE}] Message formatting failed; using a basic preview.`, error);
            return basicMarkdownPreview(raw);
        } finally {
            if (context?.chat?.[index] && context.chat[index].mes !== storedText) {
                context.chat[index].mes = storedText;
            }
        }
    }

    function decorateMessageEditor(messageElement) {
        if (!(messageElement instanceof HTMLElement)) return;
        const editor = messageElement.querySelector(EDITOR_SELECTOR);
        const messageText = messageElement.querySelector('.mes_text');

        if (!editor || !messageText) {
            messageElement.classList.remove('sme-editing', 'sme-source-mode');
            messageElement.querySelectorAll('.sme-controls-layer, .sme-edit-toolbar, .sme-wysiwyg-view').forEach(element => element.remove());
            messageElement.style.removeProperty('--sme-toolbar-top');
            messageElement.style.removeProperty('--sme-toolbar-bottom');
            return;
        }

        messageElement.classList.add('sme-editing');
        let session = sessions.get(messageElement);
        if (!session) {
            session = {
                initialHtml: null,
                clickTextOffset: 0,
                viewDirty: false,
                sourceMode: false,
                initializedView: false,
            };
            sessions.set(messageElement, session);
        }

        // Keep action bars in a separate absolute-positioned layer on the message card,
        // not inside .mes_text. This means the controls never contribute to message height.
        const controlsLayer = ensureControlsLayer(messageElement);
        moveToolbarToLayer(messageElement, controlsLayer, 'top');
        moveToolbarToLayer(messageElement, controlsLayer, 'bottom');

        let view = messageText.querySelector('.sme-wysiwyg-view');
        if (!view) {
            view = document.createElement('div');
            view.className = 'sme-wysiwyg-view';
            view.contentEditable = 'true';
            view.setAttribute('role', 'textbox');
            view.setAttribute('aria-multiline', 'true');
            view.setAttribute('aria-label', 'Formatted message editor');
            view.spellcheck = true;
            if (session.initialHtml !== null) {
                view.innerHTML = session.initialHtml;
                session.initializedView = true;
            }
            editor.insertAdjacentElement('beforebegin', view);
            view.addEventListener('input', () => {
                session.viewDirty = true;
                view.classList.add('sme-has-changes');
                requestAnimationFrame(() => positionToolbarLayer(messageElement, messageText));
            });
            view.addEventListener('keydown', onEditorKeydown);
        }

        // Keep the editing surface in normal document flow. Fixed heights and internal
        // scrolling made messages clip or misalign with custom SillyTavern themes.
        view.style.removeProperty('height');
        view.style.removeProperty('min-height');
        view.style.removeProperty('max-height');
        view.style.removeProperty('overflow-y');
        editor.style.removeProperty('height');
        editor.style.removeProperty('max-height');
        editor.style.removeProperty('resize');
        editor.style.removeProperty('overflow-y');

        editor.classList.toggle('sme-source-hidden', !session.sourceMode);
        view.classList.toggle('sme-view-hidden', session.sourceMode);
        messageElement.classList.toggle('sme-source-mode', session.sourceMode);
        updateSourceButtonLabels(messageElement, session.sourceMode);
        positionToolbarLayer(messageElement, messageText);

        if (!session.initializedView && session.initialHtml === null) {
            session.initializedView = true;
            const raw = editor.value;
            void formatSource(raw, messageElement).then(html => {
                if (!view.isConnected || session.viewDirty || editor.value !== raw) return;
                view.innerHTML = html;
            });
        }
    }

    function updateSourceButtonLabels(messageElement, sourceMode) {
        messageElement.querySelectorAll('.sme-action-source').forEach(button => {
            const label = sourceMode ? 'Show formatted' : 'Show source';
            button.setAttribute('aria-label', label);
            button.title = label;
            const text = button.querySelector('.sme-action-label');
            if (text) text.textContent = label;
        });
    }

    function syncEditorUi() {
        document.querySelectorAll(`${CHAT_SELECTOR} .mes ${EDITOR_SELECTOR}`).forEach(editor => {
            const message = editor.closest('.mes');
            if (message) decorateMessageEditor(message);
        });
        document.querySelectorAll(`${CHAT_SELECTOR} .mes.sme-editing`).forEach(decorateMessageEditor);
    }

    function textOffsetFromClick(messageElement, event) {
        const renderedText = messageElement.querySelector('.mes_text');
        if (!renderedText) return 0;
        let visibleOffset = null;
        try {
            let node = null;
            let offset = 0;
            if (typeof document.caretPositionFromPoint === 'function') {
                const position = document.caretPositionFromPoint(event.clientX, event.clientY);
                node = position?.offsetNode ?? null;
                offset = position?.offset ?? 0;
            } else if (typeof document.caretRangeFromPoint === 'function') {
                const rangeAtPoint = document.caretRangeFromPoint(event.clientX, event.clientY);
                node = rangeAtPoint?.startContainer ?? null;
                offset = rangeAtPoint?.startOffset ?? 0;
            }
            if (node && renderedText.contains(node)) {
                const range = document.createRange();
                range.selectNodeContents(renderedText);
                range.setEnd(node, offset);
                visibleOffset = range.toString().length;
            }
        } catch {
            visibleOffset = null;
        }

        const visibleText = renderedText.innerText || renderedText.textContent || '';
        if (visibleOffset === null) {
            const rect = renderedText.getBoundingClientRect();
            const relativeY = rect.height > 0 ? clamp((event.clientY - rect.top) / rect.height, 0, 1) : 0;
            visibleOffset = Math.round(relativeY * visibleText.length);
        }
        return clamp(visibleOffset, 0, visibleText.length);
    }

    function getTextNodeLength(element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        let length = 0;
        while ((node = walker.nextNode())) length += node.nodeValue?.length ?? 0;
        return length;
    }

    function getCaretTextOffset(element) {
        const selection = window.getSelection();
        if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return 0;
        try {
            const prefix = document.createRange();
            prefix.selectNodeContents(element);
            prefix.setEnd(selection.anchorNode, selection.anchorOffset);
            return prefix.toString().length;
        } catch {
            return 0;
        }
    }

    function setCaretAtTextOffset(element, targetOffset) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node;
        let remaining = Math.max(0, targetOffset);
        let lastTextNode = null;

        while ((node = walker.nextNode())) {
            lastTextNode = node;
            const length = node.nodeValue?.length ?? 0;
            if (remaining <= length) {
                const range = document.createRange();
                range.setStart(node, remaining);
                range.collapse(true);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return;
            }
            remaining -= length;
        }

        const range = document.createRange();
        if (lastTextNode) {
            range.setStart(lastTextNode, lastTextNode.nodeValue.length);
        } else {
            range.selectNodeContents(element);
            range.collapse(false);
        }
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }

    function getScrollSnapshot() {
        const chat = document.querySelector(CHAT_SELECTOR);
        const root = document.scrollingElement || document.documentElement;
        return {
            chat,
            chatScrollTop: chat?.scrollTop ?? 0,
            chatScrollLeft: chat?.scrollLeft ?? 0,
            root,
            rootScrollTop: root?.scrollTop ?? window.scrollY,
            rootScrollLeft: root?.scrollLeft ?? window.scrollX,
            windowX: window.scrollX,
            windowY: window.scrollY,
        };
    }

    function restoreScroll(snapshot) {
        if (!snapshot) return;
        const targets = [document.documentElement, document.body, snapshot.chat].filter(Boolean);
        const oldBehaviors = targets.map(element => element.style.scrollBehavior);
        targets.forEach(element => { element.style.scrollBehavior = 'auto'; });

        // Assign scroll positions directly. window.scrollTo can animate on themes that
        // apply scroll-behavior:smooth, which looks like the chat jumps after a click.
        if (snapshot.root) {
            snapshot.root.scrollLeft = snapshot.rootScrollLeft;
            snapshot.root.scrollTop = snapshot.rootScrollTop;
        }
        if (snapshot.chat) {
            snapshot.chat.scrollLeft = snapshot.chatScrollLeft;
            snapshot.chat.scrollTop = snapshot.chatScrollTop;
        }
        document.documentElement.scrollLeft = snapshot.windowX;
        document.documentElement.scrollTop = snapshot.windowY;
        if (document.body) {
            document.body.scrollLeft = snapshot.windowX;
            document.body.scrollTop = snapshot.windowY;
        }
        window.scrollTo(snapshot.windowX, snapshot.windowY);

        requestAnimationFrame(() => {
            if (snapshot.root) {
                snapshot.root.scrollLeft = snapshot.rootScrollLeft;
                snapshot.root.scrollTop = snapshot.rootScrollTop;
            }
            if (snapshot.chat) {
                snapshot.chat.scrollLeft = snapshot.chatScrollLeft;
                snapshot.chat.scrollTop = snapshot.chatScrollTop;
            }
            document.documentElement.scrollLeft = snapshot.windowX;
            document.documentElement.scrollTop = snapshot.windowY;
            if (document.body) {
                document.body.scrollLeft = snapshot.windowX;
                document.body.scrollTop = snapshot.windowY;
            }
            targets.forEach((element, index) => { element.style.scrollBehavior = oldBehaviors[index]; });
        });
    }

    function waitForEditor(messageElement, timeoutMs = 2500) {
        return new Promise(resolve => {
            const existing = messageElement.querySelector(EDITOR_SELECTOR);
            if (existing) return resolve(existing);

            let finished = false;
            let timeoutId;
            const observer = new MutationObserver(() => {
                const editor = messageElement.querySelector(EDITOR_SELECTOR);
                if (editor) finish(editor);
            });
            function finish(editor) {
                if (finished) return;
                finished = true;
                observer.disconnect();
                clearTimeout(timeoutId);
                resolve(editor ?? null);
            }
            observer.observe(messageElement, { childList: true, subtree: true });
            timeoutId = setTimeout(() => finish(messageElement.querySelector(EDITOR_SELECTOR)), timeoutMs);
        });
    }

    async function beginEditAtClick(messageElement, event) {
        const editButton = messageElement.querySelector('.mes_edit');
        if (!editButton) return;

        const messageText = messageElement.querySelector('.mes_text');
        const snapshot = getScrollSnapshot();
        const session = {
            initialHtml: messageText?.innerHTML ?? '',
            clickTextOffset: textOffsetFromClick(messageElement, event),
            viewDirty: false,
            sourceMode: false,
            initializedView: false,
        };
        sessions.set(messageElement, session);

        // Preserve ST's own edit/save flow, including Regex, swipe data, events and persistence.
        editButton.click();
        const editor = await waitForEditor(messageElement);
        if (!editor) return;

        syncEditorUi();
        requestAnimationFrame(() => {
            const view = messageElement.querySelector('.sme-wysiwyg-view');
            if (!view?.isConnected) return;
            view.focus({ preventScroll: true });
            setCaretAtTextOffset(view, session.clickTextOffset);
            restoreScroll(snapshot);
            // Core edit handlers and third-party themes may adjust scrolling one frame
            // after the textarea is inserted. Reapply once after that layout settles.
            requestAnimationFrame(() => restoreScroll(snapshot));
        });
    }

    function onChatClick(event) {
        if (!(event.target instanceof Element)) return;
        const messageElement = event.target.closest('.mes');
        if (!messageElement || !messageElement.closest(CHAT_SELECTOR)) return;
        if (messageElement.querySelector(EDITOR_SELECTOR)) return;

        // A message card also contains reasoning, metadata, avatars, controls, and padding.
        // Only clicks whose target is genuinely inside the rendered body may start editing.
        // This intentionally excludes the whole "Thought for ..." block and its margins.
        if (isReasoningArea(event.target, messageElement)) return;
        if (event.target.closest(INTERACTIVE_SELECTOR)) return;
        if (!event.target.closest('.mes_text')) return;

        const selection = window.getSelection?.();
        if (selection && !selection.isCollapsed) return;
        void beginEditAtClick(messageElement, event);
    }

    function serializeInline(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const element = node;
        const tag = element.tagName.toLowerCase();
        const children = () => Array.from(element.childNodes).map(serializeAny).join('');
        const value = children();
        switch (tag) {
            case 'br': return '\n';
            case 'strong': case 'b': return value ? `**${value}**` : '';
            case 'em': case 'i': return value ? `*${value}*` : '';
            case 'u': return value ? `__${value}__` : '';
            case 'del': case 's': case 'strike': return value ? `~~${value}~~` : '';
            case 'code': return value.includes('\n') ? `\`\`\`\n${value}\n\`\`\`` : `\`${value}\``;
            case 'a': {
                const href = element.getAttribute('href');
                return href ? `[${value}](${href})` : value;
            }
            case 'img': {
                const src = element.getAttribute('src') || '';
                const alt = element.getAttribute('alt') || '';
                return src ? `![${alt}](${src})` : '';
            }
            default: return value;
        }
    }

    function serializeBlock(node) {
        const element = node;
        const tag = element.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
            const level = Number(tag[1]);
            return `${'#'.repeat(level)} ${serializeInlineChildren(element).trim()}`;
        }
        if (tag === 'blockquote') {
            return serializeBlockChildren(element).split('\n').map(line => line ? `> ${line}` : '>').join('\n');
        }
        if (tag === 'pre') {
            const code = element.querySelector('code');
            const language = code?.className.match(/language-([\w+-]+)/)?.[1] || '';
            const value = (code || element).textContent || '';
            return `\`\`\`${language}\n${value.replace(/^\n+|\n+$/g, '')}\n\`\`\``;
        }
        if (tag === 'ul' || tag === 'ol') {
            const items = Array.from(element.children).filter(child => child.tagName.toLowerCase() === 'li');
            return items.map((item, index) => {
                const marker = tag === 'ol' ? `${index + 1}. ` : '- ';
                const body = serializeBlockChildren(item).trim().replace(/\n/g, '\n  ');
                return `${marker}${body}`;
            }).join('\n');
        }
        if (tag === 'hr') return '---';
        if (['p', 'div', 'section', 'article', 'main', 'header', 'footer'].includes(tag)) {
            return serializeBlockChildren(element).trim();
        }
        return serializeInline(element).trim();
    }

    function serializeInlineChildren(element) {
        return Array.from(element.childNodes).map(serializeInline).join('');
    }

    function serializeBlockChildren(element) {
        const chunks = [];
        let inlineBuffer = '';
        const flushInline = () => {
            if (inlineBuffer) {
                chunks.push(inlineBuffer);
                inlineBuffer = '';
            }
        };
        for (const child of Array.from(element.childNodes)) {
            if (child.nodeType === Node.ELEMENT_NODE && /^(P|DIV|BLOCKQUOTE|PRE|UL|OL|H[1-6]|HR|SECTION|ARTICLE)$/.test(child.tagName)) {
                flushInline();
                const block = serializeBlock(child);
                if (block) chunks.push(block);
            } else {
                inlineBuffer += serializeInline(child);
            }
        }
        flushInline();
        return chunks.join('\n\n');
    }

    function serializeAny(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const tag = node.tagName.toLowerCase();
        if (['p', 'div', 'blockquote', 'pre', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'section', 'article'].includes(tag)) {
            return serializeBlock(node);
        }
        return serializeInline(node);
    }

    function serializeFormattedView(view) {
        return serializeBlockChildren(view).replace(/\n{3,}/g, '\n\n').trim();
    }

    async function toggleSourceMode(messageElement) {
        const session = sessions.get(messageElement);
        const editor = messageElement.querySelector(EDITOR_SELECTOR);
        const view = messageElement.querySelector('.sme-wysiwyg-view');
        if (!session || !editor || !view) return;

        if (!session.sourceMode) {
            if (session.viewDirty) {
                editor.value = serializeFormattedView(view);
                session.viewDirty = false;
            }
            const visibleOffset = getCaretTextOffset(view);
            const visibleLength = Math.max(1, getTextNodeLength(view));
            const rawOffset = Math.round((visibleOffset / visibleLength) * editor.value.length);
            session.lastSourceOffset = clamp(rawOffset, 0, editor.value.length);
            session.sourceMode = true;
            editor.classList.remove('sme-source-hidden');
            view.classList.add('sme-view-hidden');
            messageElement.classList.add('sme-source-mode');
            updateSourceButtonLabels(messageElement, true);
            editor.focus({ preventScroll: true });
            editor.setSelectionRange(session.lastSourceOffset, session.lastSourceOffset);
            return;
        }

        const raw = editor.value;
        const rawOffset = editor.selectionStart ?? session.lastSourceOffset ?? raw.length;
        const html = await formatSource(raw, messageElement);
        // Keep source text authoritative if the user typed again while formatting loaded.
        if (!editor.isConnected || !view.isConnected) return;
        view.innerHTML = html;
        session.viewDirty = false;
        session.sourceMode = false;
        view.classList.remove('sme-view-hidden', 'sme-has-changes');
        editor.classList.add('sme-source-hidden');
        messageElement.classList.remove('sme-source-mode');
        updateSourceButtonLabels(messageElement, false);
        const renderedLength = getTextNodeLength(view);
        const visibleOffset = Math.round((rawOffset / Math.max(1, raw.length)) * renderedLength);
        view.focus({ preventScroll: true });
        setCaretAtTextOffset(view, clamp(visibleOffset, 0, renderedLength));
    }

    function onToolbarClick(event) {
        if (!(event.target instanceof Element)) return;
        const control = event.target.closest('[data-sme-action]');
        if (!control) return;
        event.preventDefault();
        event.stopPropagation();
        const message = control.closest('.mes');
        if (!message) return;

        const action = control.dataset.smeAction;
        if (action === 'source') {
            void toggleSourceMode(message);
            return;
        }

        const editor = message.querySelector(EDITOR_SELECTOR);
        const view = message.querySelector('.sme-wysiwyg-view');
        const session = sessions.get(message);
        if (action === 'save' && editor && view && session && !session.sourceMode && session.viewDirty) {
            editor.value = serializeFormattedView(view);
        }

        const coreSelector = action === 'save' ? '.mes_edit_done' : '.mes_edit_cancel';
        message.querySelector(coreSelector)?.click();
    }

    function onEditorKeydown(event) {
        const target = event.target;
        const isNativeEditor = target instanceof HTMLTextAreaElement && target.classList.contains('edit_textarea');
        const isFormattedEditor = target instanceof HTMLElement && target.classList.contains('sme-wysiwyg-view');
        if (!isNativeEditor && !isFormattedEditor) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            target.closest('.mes')?.querySelector('.sme-action-save')?.click();
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            target.closest('.mes')?.querySelector('.sme-action-cancel')?.click();
        }
    }

    function installSettingsObserver() {
        hideClickToEditSetting();
        settingsObserver?.disconnect();
        settingsObserver = new MutationObserver(records => {
            const settingAdded = records.some(record => Array.from(record.addedNodes).some(node => {
                if (!(node instanceof Element)) return false;
                return node.id === 'click_to_edit' || node.matches?.('label[for="click_to_edit"]') || !!node.querySelector?.('#click_to_edit');
            }));
            if (settingAdded) hideClickToEditSetting();
        });
        if (document.body) settingsObserver.observe(document.body, { childList: true, subtree: true });
    }

    function initialize() {
        if (initialized) return;
        const chatElement = document.querySelector(CHAT_SELECTOR);
        if (!chatElement) {
            setTimeout(initialize, 250);
            return;
        }

        initialized = true;
        installSettingsObserver();
        chatElement.addEventListener('click', onChatClick);
        chatElement.addEventListener('click', onToolbarClick);
        document.addEventListener('keydown', onEditorKeydown, true);

        chatObserver = new MutationObserver(records => {
            let touchedEditor = false;
            for (const record of records) {
                for (const node of [...record.addedNodes, ...record.removedNodes]) {
                    if (!(node instanceof Element)) continue;
                    if (node.matches(`${EDITOR_SELECTOR}, .mes.sme-editing, .sme-edit-toolbar, .sme-wysiwyg-view`)
                        || node.querySelector?.(`${EDITOR_SELECTOR}, .mes.sme-editing, .sme-edit-toolbar, .sme-wysiwyg-view`)) {
                        touchedEditor = true;
                        break;
                    }
                }
                if (touchedEditor) break;
            }
            if (touchedEditor) syncEditorUi();
        });
        chatObserver.observe(chatElement, { childList: true, subtree: true });
        syncEditorUi();
        log('Ready. Click a message body to open formatted editing.');
    }

    function boot() {
        try {
            context = window.SillyTavern?.getContext?.() ?? null;
            initialize();
            const source = context?.eventSource;
            const events = context?.event_types;
            if (source && events?.CHAT_CHANGED) source.on(events.CHAT_CHANGED, () => setTimeout(syncEditorUi, 0));
            if (source && events?.APP_READY) source.on(events.APP_READY, initialize);
        } catch (error) {
            console.error(`[${MODULE}] Initialization failed.`, error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
