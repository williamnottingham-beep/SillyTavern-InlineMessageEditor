# Seamless Message Edit

A SillyTavern UI extension that provides formatted in-place editing while preserving SillyTavern's native message-edit/save pipeline.

Version: **1.1.3**

## Features

- Click a message body to edit at approximately the clicked visible-text position.
- Starts in a formatted `contenteditable` view based on SillyTavern's already-rendered message HTML, retaining visible Markdown styles, blockquotes, colored quote text and code formatting while editing.
- **Show source** toggles to the native source textarea so Markdown markers such as `**bold**`, `*italic*`, `> quotes`, and code fences can be viewed and edited.
- Save and Cancel controls appear both above and below the editor.
- The top and bottom control bars live in a detached absolute-positioned overlay on the message card, outside the message-text flow. They do not add layout height or shift the surrounding chat.
- `Ctrl+Enter` / `Cmd+Enter` saves. `Escape` cancels.
- Hides the stock edit icon and the Click to edit setting.
- Ignores SillyTavern reasoning/thinking details when detecting message-body clicks, preserving the collapsible “Thought for…” block and its native controls.
- Native SillyTavern save handling is retained for Regex processing, swipe synchronization, message events, and chat persistence.
- Locks the formatted and source editing surfaces to the message body height measured before editing, with internal scrolling if the content changes. This prevents the active message from expanding while typing.
- Restores the exact pre-edit document and chat scroll positions without applying a compensating layout delta, avoiding subtle click-time chat nudges.

## Install manually

1. Extract this folder.
2. Copy the `seamless-message-edit` directory to `SillyTavern/data/<your-user>/extensions/`.
3. Refresh SillyTavern.
4. Enable **Seamless Message Edit** in Extensions if needed.

For an all-users installation, place the directory in `SillyTavern/public/scripts/extensions/third-party/seamless-message-edit/` when that folder is available in your setup.

## Editing modes

- **Formatted**: edit the rendered message with formatting and quote styles visible.
- **Source**: edit the raw message content and Markdown markers in the native textarea.
- Switching from formatted mode to source serializes common Markdown elements (bold, italic, underline, strike-through, headings, links, images, code, blockquotes, lists, paragraphs and line breaks). The extension keeps the original source intact when the formatted surface has not been changed.

The formatted mode is WYSIWYG-style editing. Complex Markdown extensions or custom HTML structures may be normalized when the formatted surface is modified; use **Show source** for exact source-level changes or syntax that must remain byte-for-byte intact.

## Regex compatibility

The extension does not run Regex itself or modify SillyTavern's save pipeline. Before invoking the core save button, it copies the edited content to SillyTavern's native `.edit_textarea`. The core `messageEditDone` / `updateMessage` path therefore remains responsible for Regex, events, active swipe data, and chat persistence.

## Compatibility

Uses the documented UI extension manifest shape and imports SillyTavern's exported `messageFormatting` API from `/script.js` when switching source back to formatted mode. SillyTavern core updates or extensions that modify message HTML may require compatibility adjustments.

## License

MIT. See `LICENSE`.
