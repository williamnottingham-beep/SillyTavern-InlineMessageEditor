import { getContext } from "../../../extensions.js";

let turndownService = null;
let activeEditor = null; 

async function initTurndown() {
    if (window.TurndownService) {
        setupTurndown();
        return;
    }
    
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/turndown/dist/turndown.js';
        script.onload = () => {
            setupTurndown();
            resolve();
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

function setupTurndown() {
    turndownService = new window.TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*'
    });
    
    turndownService.addRule('strikethrough', {
        filter: ['del', 's', 'strike'],
        replacement: function (content) {
            return '~~' + content + '~~';
        }
    });

    turndownService.remove(['button', 'script', 'style']);
}

// Prevents ST's scroll jumping when UI elements are added/removed
function executeWithScrollFreeze(action) {
    const chatContainer = document.getElementById('chat');
    const html = document.documentElement;
    const body = document.body;
    
    // 1. Snapshot exact scroll positions
    const scrollY = window.scrollY || html.scrollTop || body.scrollTop;
    const chatScrollY = chatContainer ? chatContainer.scrollTop : 0;
    
    // 2. Perform the DOM changes
    action();
    
    // 3. Force scroll back to where it was
    const forceScroll = () => {
        window.scrollTo(window.scrollX, scrollY);
        if (chatContainer) chatContainer.scrollTop = chatScrollY;
    };
    
    // Lock it instantly, and pulse a few times to defeat ST's native auto-scroll observer
    forceScroll();
    setTimeout(forceScroll, 10);
    setTimeout(forceScroll, 50);
    setTimeout(forceScroll, 150);
}

function saveMessage(mesId, newMarkdown) {
    const context = getContext();
    const chat = context.chat;
    const idNum = parseInt(mesId, 10);
    
    if (isNaN(idNum) || !chat[idNum]) return;
    
    // IF THE TEXT DIDN'T CHANGE, DO NOTHING (Saves processing & prevents jump)
    if (chat[idNum].mes === newMarkdown) return; 

    chat[idNum].mes = newMarkdown;
    
    if (typeof window.updateMessageBlock === 'function') {
        window.updateMessageBlock(idNum, chat[idNum]);
    }

    if (typeof context.saveChat === 'function') {
        context.saveChat();
    } else if (typeof context.saveChatDebounced === 'function') {
        context.saveChatDebounced();
    }
}

jQuery(async () => {
    await initTurndown();

    setTimeout(() => {
        const labels = document.querySelectorAll('.checkbox_label');
        labels.forEach(label => {
            if (label.textContent.toLowerCase().includes('click to edit')) {
                label.style.display = 'none'; 
            }
        });
    }, 2000); 

    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    function createToolbar(onSave, onCancel) {
        const bar = document.createElement('div');
        bar.className = 'inline-edit-toolbar';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'inline-edit-btn';
        cancelBtn.innerHTML = '<i>❌</i> Cancel';
        cancelBtn.onmousedown = (e) => { e.preventDefault(); };
        cancelBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onCancel(); };

        const saveBtn = document.createElement('button');
        saveBtn.className = 'inline-edit-btn';
        saveBtn.innerHTML = '<i>✔️</i> Save';
        saveBtn.onmousedown = (e) => { e.preventDefault(); };
        saveBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onSave(); };

        bar.appendChild(cancelBtn);
        bar.appendChild(saveBtn);
        return bar;
    }

    chatContainer.addEventListener('click', (e) => {
        if (e.target.closest('.inline-edit-toolbar')) return;

        const mesText = e.target.closest('.mes_text');
        
        if (e.target.closest('a')) return;
        if (!mesText) return;

        const isEditing = mesText.getAttribute('contenteditable') === 'true';

        if (!isEditing && window.getSelection().toString().length > 0) return;

        e.stopPropagation();
        e.preventDefault();

        if (isEditing) return;

        if (activeEditor && activeEditor !== mesText) {
            activeEditor.blur(); 
        }

        const mesBlock = mesText.closest('.mes');
        if (!mesBlock) return;
        const mesId = mesBlock.getAttribute('mesid');

        executeWithScrollFreeze(() => {
            mesText.setAttribute('contenteditable', 'true');
            mesText.setAttribute('inputmode', 'text'); 
            mesText.classList.add('inline-editing');
            mesBlock.classList.add('inline-editing-active');
            mesText.focus();
        });
        
        let range;
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(e.clientX, e.clientY);
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
                range.collapse(true);
            }
        }
        if (range) {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }

        const originalHtml = mesText.innerHTML;
        activeEditor = mesText;

        let isSaving = false;
        let isCanceling = false;

        const cleanup = () => {
            mesText.removeAttribute('contenteditable');
            mesText.removeAttribute('inputmode');
            mesText.classList.remove('inline-editing');
            mesBlock.classList.remove('inline-editing-active');
            
            if (topToolbar && topToolbar.parentNode) topToolbar.parentNode.removeChild(topToolbar);
            if (bottomToolbar && bottomToolbar.parentNode) bottomToolbar.parentNode.removeChild(bottomToolbar);
            
            mesText.removeEventListener('blur', onBlur);
            mesText.removeEventListener('keydown', onKeyDown);
            if (activeEditor === mesText) activeEditor = null;
        };

        const saveChanges = () => {
            if (isSaving || isCanceling) return;
            isSaving = true;
            const htmlContent = mesText.innerHTML;

            let newMarkdown = turndownService.turndown(htmlContent);
            newMarkdown = newMarkdown.replace(/\\([*_+~.])/g, '$1');

            // Freeze the screen, perform the DOM removal, and save text
            executeWithScrollFreeze(() => {
                cleanup();
                saveMessage(mesId, newMarkdown);
            });
        };

        const cancelChanges = () => {
            if (isSaving || isCanceling) return;
            isCanceling = true;
            
            // Freeze screen, revert text, and perform DOM removal
            executeWithScrollFreeze(() => {
                mesText.innerHTML = originalHtml; 
                cleanup();
                mesText.blur();
            });
        };

        const topToolbar = createToolbar(saveChanges, cancelChanges);
        const bottomToolbar = createToolbar(saveChanges, cancelChanges);
        
        executeWithScrollFreeze(() => {
            mesText.parentNode.insertBefore(topToolbar, mesText);
            if (mesText.nextSibling) {
                mesText.parentNode.insertBefore(bottomToolbar, mesText.nextSibling);
            } else {
                mesText.parentNode.appendChild(bottomToolbar);
            }
        });

        const onBlur = () => {
            setTimeout(() => {
                if (activeEditor === mesText && !mesBlock.contains(document.activeElement)) {
                    saveChanges();
                }
            }, 150);
        };

        const onKeyDown = (ke) => {
            if (ke.key === 'Escape') {
                ke.preventDefault();
                cancelChanges();
            } else if (ke.key === 'Enter' && ke.ctrlKey) {
                ke.preventDefault();
                saveChanges();
            }
        };

        mesText.addEventListener('blur', onBlur);
        mesText.addEventListener('keydown', onKeyDown);

    }, true);
});