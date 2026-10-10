import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationRenderer, truncatePreview } from '../player/conversation.mjs';

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character],
  );
const { renderMarkdown, renderEntry } = createConversationRenderer({
  escapeHtml,
  formatTime: (time) => `${time}s`,
});

test('conversation markdown escapes HTML while preserving supported formatting', () => {
  assert.equal(
    renderMarkdown('**Done** <script>alert(1)</script>'),
    '<p><b>Done</b> &lt;script&gt;alert(1)&lt;/script&gt;</p>',
  );
  assert.equal(renderMarkdown('```js\n<img>```'), '<pre><code>&lt;img&gt;</code></pre>');
  assert.equal(renderMarkdown('- First\n- Second'), '<ul><li>First</li><li>Second</li></ul>');
  assert.equal(renderMarkdown('1. First\n2. Second'), '<ol><li>First</li><li>Second</li></ol>');
});

test('user conversation entries include messages, change summaries, and delivery status', () => {
  const html = renderEntry({
    role: 'user',
    at: 'invalid',
    status: 'done',
    batch: {
      messages: ['Please **update** it'],
      edits: [{ element: '<Title>', field: 'Text', from: 'Before', to: 'After' }],
    },
  });
  assert.match(html, /Please <b>update<\/b> it/);
  assert.match(html, /1 change/);
  assert.match(html, /aria-label="Done"/);
  assert.match(html, /&lt;Title&gt; · Text: Before → After/);
});

test('preview truncation leaves short values intact and bounds long values', () => {
  assert.equal(truncatePreview(null), '');
  assert.equal(truncatePreview('Short'), 'Short');
  assert.equal(truncatePreview('x'.repeat(81)), 'x'.repeat(80) + '…');
});
