// Conversation markup is independent of editor state and DOM updates.
export const truncatePreview = (s) => {
  s = String(s ?? '');
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
};
export function createConversationRenderer({ escapeHtml, formatTime }) {
  const formatMessageTime = (iso) => {
    const d = new Date(iso);
    return isNaN(d)
      ? ''
      : d.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
  };
  const renderInlineMarkdown = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>')
      .replace(
        /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
        '<a href="$1" target="_blank" rel="noopener">$1</a>',
      );
  function renderParagraph(paragraph) {
    const lines = paragraph.split('\n');
    if (lines.every((line) => /^\s*[-*] /.test(line))) {
      const items = lines.map((line) => {
        const text = line.replace(/^\s*[-*] /, '');
        return `<li>${renderInlineMarkdown(text)}</li>`;
      });
      return `<ul>${items.join('')}</ul>`;
    }
    if (lines.every((line) => /^\s*\d+\. /.test(line))) {
      const items = lines.map((line) => {
        const text = line.replace(/^\s*\d+\. /, '');
        return `<li>${renderInlineMarkdown(text)}</li>`;
      });
      return `<ol>${items.join('')}</ol>`;
    }
    const renderedLines = lines.map((line) => {
      if (/^#{1,6} /.test(line)) {
        return `<b>${renderInlineMarkdown(line.replace(/^#+ /, ''))}</b>`;
      }
      return renderInlineMarkdown(line);
    });
    return `<p>${renderedLines.join('<br>')}</p>`;
  }

  function renderMarkdown(source) {
    return String(source ?? '')
      .split('```')
      .map((section, index) => {
        if (index % 2) {
          const code = section.replace(/^[\w-]*\n/, '');
          return `<pre><code>${escapeHtml(code)}</code></pre>`;
        }
        return section
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
          .map(renderParagraph)
          .join('');
      })
      .join('');
  }
  function renderBatchSummary(batch) {
    const items = [
      ...(batch.edits || []).map(
        (e) => `${e.element} · ${e.field}: ${truncatePreview(e.from)} → ${truncatePreview(e.to)}`,
      ),
      ...(batch.notes || []).map(
        (n) => `Note ${n.n} at ${formatTime(n.t)}: ${truncatePreview(n.text)}`,
      ),
      ...(batch.trims || []).map((t) => `Trim ${t.scene}: ${t.from}s → ${t.to}s`),
      ...(batch.links || []).map((l) => `Link ${l}`),
      ...(batch.messages || []).map((m) => `“${truncatePreview(m)}”`),
    ];
    return items.length ? `<ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '';
  }
  // Lucide Send, Inbox, and CircleCheck, embedded so badges work offline.
  function renderStatusBadge(status) {
    const icons = {
      sent: ['Sent', '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'],
      picked: [
        'Picked up',
        '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>',
      ],
      done: ['Done', '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'],
    };
    const key = Object.hasOwn(icons, status) ? status : 'sent';
    const [label, paths] = icons[key];
    return `<span class="bst status-icon ${key}" title="${label}" role="img" aria-label="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg></span>`;
  }
  function renderEntry(entry) {
    if (entry.role === 'agent') {
      return `<div class="bub agent"><div class="bh"><b>Agent</b><span class="mono">${formatMessageTime(entry.at)}</span></div><div class="md">${renderMarkdown(entry.text)}</div></div>`;
    }
    // typed messages read like chat; everything else is summarised, with the full list on expand
    const batch = entry.batch || {};
    const messages = batch.messages || [];
    const summaryParts = [
      ['change', batch.edits],
      ['note', batch.notes],
      ['trim', batch.trims],
      ['link', batch.links],
    ]
      .filter(([, a]) => a?.length)
      .map(([w, a]) => `${a.length} ${w}${a.length > 1 ? 's' : ''}`);
    const remainingBatch = {
      ...batch,
      messages: [],
    };
    return `<details class="bub me"><summary><span class="bh"><b>You</b><span class="mono">${formatMessageTime(entry.at)}</span>${renderStatusBadge(entry.status)}</span>${messages.map((m) => `<div class="md">${renderMarkdown(m)}</div>`).join('')}${summaryParts.length || !messages.length ? `<span class="sum">${escapeHtml(summaryParts.join(', ') || 'Empty send')}</span>` : ''}</summary>${renderBatchSummary(remainingBatch)}</details>`;
  }
  return {
    renderMarkdown,
    renderEntry,
  };
}
