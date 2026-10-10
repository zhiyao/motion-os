// Loaded only when window.selftest() is explicitly called.
import {easeInOut, keyBox, keepAfterNewVersion} from './model.mjs';

export async function selftest(context){
  const {P, st, ui, convo, addKey, allEls, edDur, editRow, elBox, elById, elKeys, elTime, entryHTML, feedback, fps1, isCut, liveBoxes, loopEnd, markDirty, md, moveTo, nextAfterCut, now, openNotes, pendingEdits, pruneMissing, pruneReelBoxes, queueCount, renderAll, renderPane, renderQueue, renderTL, renderTranscript, sceneAt, sceneEnd, sceneLen, sceneLens, sceneOf, seek, sendFeedback, set, setKeys, setTrim, toEd, toSrc, undoPath, setVideo} = context;
  let vid = context.vid;
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  // Rendering is read-only: switching views must not rewrite stored edits.
  let writes = 0;
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) { if (key === 'motion-os-axi:' + P.id) writes++; return originalSetItem.call(this, key, value); };
  try { renderAll(); eq(writes, 0, 'rendering does not save state'); }
  finally { Storage.prototype.setItem = originalSetItem; }
  const A = {t:2, box:[0, 0, 10, 10]}, B = {t:4, box:[20, 40, 30, 30]};
  eq(easeInOut(0), 0, 'ease 0'); eq(easeInOut(1), 1, 'ease 1'); eq(easeInOut(0.5), 0.5, 'ease mid'); eq(easeInOut(0.25), 0.0625, 'ease quarter');
  eq(keyBox([A], 9), A.box, 'one key holds');
  eq(keyBox([A, B], 1), A.box, 'before holds first');
  eq(keyBox([A, B], 2), A.box, 'on first');
  eq(keyBox([A, B], 3), [10, 20, 20, 20], 'midpoint is halfway');
  eq(keyBox([A, B], 4), B.box, 'on last');
  eq(keyBox([A, B], 5), B.box, 'after holds last');
  // state helpers, on a scratch copy of the edits; vid is swapped for a stub so now() is exact (a live player seeks asynchronously)
  const savedQ = JSON.stringify({notes: st.notes, messages: st.messages, sent: st.sent, sentSnap: st.sentSnap, links: st.links});
  const saved = JSON.stringify(st.over), realVid = vid, e = allEls().find(x => x.box), id = e.id, T0 = e.t[0] + 0.5, T1 = Math.min(e.t[1] - 0.1, T0 + 1.5);
  vid = {currentTime:0, paused:true, pause(){}}; setVideo(vid);
  try {
    st.over = {}; set(`${id}.@box`, [1, 2, e.box[2], e.box[3]], e.box);
    vid.currentTime = T0; addKey(e);
    eq(elKeys(e), [{t:fps1(T0), box:[1, 2, e.box[2], e.box[3]]}], 'first key takes the moved box');
    eq(`${id}.@box` in st.over, false, '@box removed');
    vid.currentTime = T1; eq(moveTo(e, [5, 6, e.box[2], e.box[3]]), true, 'drag adds second key');
    eq(elKeys(e).length, 2, 'two keys');
    vid.currentTime = (T0 + T1) / 2; eq(moveTo(e, [9, 9, 9, 9]), false, 'drag off-key refused');
    eq(elKeys(e)[1].box, [5, 6, e.box[2], e.box[3]], 'refused drag changed nothing');
    vid.currentTime = T1; moveTo(e, [7, 7, e.box[2], e.box[3]]); eq(elKeys(e)[1].box, [7, 7, e.box[2], e.box[3]], 'drag on key edits it');
    setKeys(e, [{...elKeys(e)[0], t:fps1(T1 + 0.5)}, elKeys(e)[1]]); eq(elKeys(e).map(k => k.box[0]), [7, 1], 'keys re-sort by time');
    setKeys(e, [elKeys(e)[0]]); vid.currentTime = 0; eq(elBox(e), [7, 7, e.box[2], e.box[3]], 'one key left holds');
    setKeys(e, []); eq(`${id}.@keys` in st.over, false, 'no keys removes the path'); eq(elBox(e), e.box, 'back to reel.json box');
    setKeys(e, [{t:fps1(T0), box:e.box}, {t:fps1(T1), box:[5, 6, e.box[2], e.box[3]]}]);
    eq(liveBoxes()[id], {box:e.box, keys:elKeys(e)}, 'live payload carries keys');
    const kr = editRow(`${id}.@keys`, elKeys(e));
    eq([kr.field, kr.to.startsWith(`${+fps1(T0).toFixed(2)}s [${e.box.join(' ')}] -> `), kr.to.endsWith('(ease in-out)')], ['keyframes', true, true], 'feedback keyframes row');
    st.over = {}; set(`${id}.@box`, [1, 2, 3, 4], e.box); eq(liveBoxes()[id], [...e.box, 1, 2, 3, 4], 'old payload for plain moves');
    // keyframes from reel.json
    const rs = P.scenes.find(s => s.els.some(x => x.box && x.t[1] - x.t[0] > 1.5)), re = rs.els.find(x => x.box && x.t[1] - x.t[0] > 1.5);
    const RK = [{t: fps1(re.t[0] + 0.2), box: re.box}, {t: fps1(re.t[0] + 1.2), box: [re.box[0], re.box[1] - 10, re.box[2] * 1.2, re.box[3] * 1.2].map(v => Math.round(v * 10) / 10)}];
    re.keys = RK; st.over = {}; const RE = () => elById(re.id);
    try {
      eq(elKeys(RE()), RK, "reel keys are the element's keyframes");
      vid.currentTime = (RK[0].t + RK[1].t) / 2; eq(elBox(RE()), keyBox(RK, now()), 'box follows the reel keys');
      Object.assign(ui, {sel: re.id, scene: rs.id, tab: 'scene'}); renderTL(); renderPane();
      eq([document.querySelectorAll('#tl .kf').length, !!document.querySelector(`[data-key="${re.id}"]`), document.querySelector(`[data-undo="${re.id}.@keys"]`)?.closest('.f')?.classList.contains('changed')], [2, true, false], 'diamonds and an unchanged Keyframes section');
      eq(liveBoxes()[re.id], undefined, 'nothing sent to the renderer without an edit');
      vid.currentTime = RK[1].t; moveTo(RE(), [5, 5, re.box[2], re.box[3]]);
      eq(st.over[`${re.id}.@keys`]?.[1].box, [5, 5, re.box[2], re.box[3]], 'dragging on a reel keyframe makes an edit');
      eq(editRow(`${re.id}.@keys`, st.over[`${re.id}.@keys`]).from, `${+RK[0].t.toFixed(2)}s [${RK[0].box.join(' ')}] -> ${+RK[1].t.toFixed(2)}s [${RK[1].box.join(' ')}]`, 'poll row from is the reel keys');
      setKeys(RE(), RK); eq(`${re.id}.@keys` in st.over, false, 'setting the reel keys back removes the edit');
      setKeys(RE(), []); eq([st.over[`${re.id}.@keys`], elKeys(RE()), elBox(RE())], [[], null, re.box], 'deleting both stores an explicit removal');
      renderPane(); eq(!!document.querySelector(`.f.changed [data-undo="${re.id}.@keys"]`), true, 'a removal can be undone from the card');
      eq([liveBoxes()[re.id], editRow(`${re.id}.@keys`, []).to], [{box: re.box, keys: []}, 'none (remove the animation)'], 'removal goes to the renderer and the agent');
      eq(keepAfterNewVersion({[`${re.id}.@keys`]: []}, {[`${re.id}.@keys`]: []}), {}, 'a sent keyframe edit is dropped on the new version');
      st.over = {}; eq(elKeys(RE()), RK, 'after the drop the reel keys show again');
      // a removal plus a move: sent as "hold at the moved box"; undoing the removal clears the move; stale moves are pruned on load
      setKeys(RE(), []); vid.currentTime = re.t[0] + 0.5; moveTo(RE(), [5, 5, re.box[2], re.box[3]]);
      eq(liveBoxes()[re.id], {box: re.box, keys: [{t: 0, box: [5, 5, re.box[2], re.box[3]]}]}, 'removed animation + move reaches the renderer as a held box');
      undoPath(`${re.id}.@keys`); eq([`${re.id}.@box` in st.over, liveBoxes()[re.id]], [false, undefined], 'undoing the removal clears the move');
      // an unsent move on an element a new version just animated is kept, as "remove the animation and hold here" (Undo brings the animation back)
      st.over = {[`${re.id}.@box`]: [1, 1, 10, 10]}; pruneReelBoxes();
      eq([st.over[`${re.id}.@keys`], st.over[`${re.id}.@box`], liveBoxes()[re.id]], [[], [1, 1, 10, 10], {box: re.box, keys: [{t: 0, box: [1, 1, 10, 10]}]}], 'an unsent move survives a new version that animates the element');
      undoPath(`${re.id}.@keys`); eq([elKeys(RE()), `${re.id}.@box` in st.over], [RK, false], 'Undo restores the new animation');
    } finally { delete re.keys; }
    // typing a keyframe time that passes through a reorder ("1" on the way to "12") must only change that keyframe
    setKeys(e, [{t:fps1(T0), box:e.box}, {t:fps1(T1), box:[5, 6, e.box[2], e.box[3]]}]);
    Object.assign(ui, {sel:id, scene:e.s, tab:'scene'}); renderPane();
    const tIn = () => document.querySelector(`[data-key="${id}"][data-i="1"][data-ix="t"]`), type = (inp, v) => { inp.value = v; inp.dispatchEvent(new Event('input', {bubbles:true})); };
    const inp = tIn(); type(inp, '0'); type(inp, String(fps1(T1 + 0.3))); inp.dispatchEvent(new Event('change', {bubbles:true}));
    eq(elKeys(e).map(k => k.t), [fps1(T0), fps1(T1 + 0.3)], 'typing a time edits only that keyframe');
    eq(+tIn().value, +fps1(T1 + 0.3).toFixed(2), 'panel shows the new time in order');
    // after a new version, sent keyframes are dropped even if changed since; other unsent edits stay
    eq(keepAfterNewVersion({'a.@keys':[{t:1, box:[1]}], 'b.@box':[1], 'c.@box':[2], 'd.@box':[3]}, {'a.@keys':[{t:1, box:[0]}], 'b.@box':[1], 'd.@box':[9]}),
       {'a.@keys':[{t:1, box:[1]}], 'c.@box':[2], 'd.@box':[3]}, 'on a new version only edits sent unchanged are dropped');
    // two clocks: render time (stored) vs edited time (what you watch with cut tails removed)
    const r3 = x => Math.round(x * 1000) / 1000, [s0, s1, s2] = P.scenes, O0 = s0.t[1] - s0.t[0], L0 = fps1(O0 - 1), f = 1 / P.fps;
    st.over = {};
    eq([r3(toEd(1.234)), r3(toSrc(1.234)), r3(edDur())], [1.234, 1.234, r3(P.duration)], 'no trims is identity');
    st.over[`${s0.id}.@len`] = L0;
    eq(r3(sceneLen(s0)), r3(L0), 'trimmed length');
    eq(r3(toEd(s0.t[0] + 0.2)), r3(s0.t[0] + 0.2), 'before the cut unchanged');
    eq([isCut(s0.t[0] + L0 + 0.5), isCut(s0.t[0] + L0 - 0.1)], [true, false], 'cut tail detected');
    eq(r3(toEd(s0.t[0] + L0 + 0.5)), r3(L0), 'cut tail maps to the new end');
    eq(r3(toEd(s1.t[0] + 0.3)), r3(L0 + 0.3), 'later scene moves earlier');
    eq(r3(toSrc(L0 + 0.3)), r3(s1.t[0] + 0.3), 'edited back to render');
    eq(r3(toSrc(L0 - 0.1)), r3(s0.t[0] + L0 - 0.1), 'edited inside trimmed scene');
    eq(r3(sceneEnd(s0)), r3(s0.t[0] + L0), 'scene end is the new end');
    eq([r3(nextAfterCut(s0.t[0] + L0 + f)), nextAfterCut(s0.t[0] + 0.1)], [r3(s1.t[0]), null], 'jump target after a cut');
    st.over[`${s1.id}.@len`] = fps1(s1.t[1] - s1.t[0] - 0.5);
    eq(r3(edDur()), r3(P.duration - (O0 - L0) - (s1.t[1] - s1.t[0] - sceneLen(s1))), 'two trims shorten the total');
    if (s2) eq(r3(toEd(s2.t[0])), r3(L0 + sceneLen(s1)), 'two trims stack');
    eq(r3(toSrc(edDur())), r3(P.duration), 'end maps to end');
    st.over[`${s0.id}.@len`] = O0 + 5; eq(r3(sceneLen(s0)), r3(O0), 'length never exceeds the original');
    const last = P.scenes[P.scenes.length - 1]; st.over = {[`${last.id}.@len`]: fps1(last.t[1] - last.t[0] - 0.5)};
    eq(nextAfterCut(P.duration - 0.1), -1, 'last scene cut tail stops');
    // seek, loop end and time fields respect trims
    st.over = {[`${s0.id}.@len`]: L0};
    seek(s0.t[0] + L0 + 0.5); eq(r3(now()), r3(s0.t[0] + L0 - f), 'seek into a cut lands on the new end');
    eq(loopEnd(s0), sceneEnd(s0), 'loop uses the new end');
    const e1 = allEls().find(x => x.s === s1.id); Object.assign(ui, {sel:e1.id, scene:s1.id, tab:'scene'}); renderPane();
    const tf = document.querySelector(`[data-time="${e1.id}"][data-ix="0"]`);
    eq(+tf.value, Math.round(toEd(e1.t[0]) * 10) / 10, 'timing field shows edited time');
    tf.value = String(Math.round((toEd(e1.t[0]) + 0.2) * 10) / 10); tf.dispatchEvent(new Event('input', {bubbles:true}));
    eq(elTime(e1)[0], Math.round((e1.t[0] + 0.2) * 10) / 10, 'timing field stores render time');
    // prompt and live payload carry trims
    st.over = {[`${s0.id}.@len`]: L0};
    eq(sceneLens(), {[s0.id]: L0}, 'scene lengths for the renderer');
    const fbk = feedback();
    eq(fbk.trims, [{scene: s0.id, name: s0.name, from: +O0.toFixed(2), to: +L0.toFixed(2), drop: `${(s0.t[0] + L0).toFixed(2)}-${s0.t[1].toFixed(2)}s`, shift: `-${(O0 - L0).toFixed(2)}s`}], 'feedback has the trim');
    eq(fbk.edits.length, 0, 'trims are not edits');
    eq(keepAfterNewVersion({[`${s0.id}.@len`]: L0}, {[`${s0.id}.@len`]: L0}), {}, 'sent trim dropped on new version');
    // review fixes: a live-style clock (edited frames read back through toSrc) across trim, Undo, last-scene end and arrow steps
    const liveClock = {ed:0, paused:true, pause(){}, get currentTime(){ return toSrc(this.ed); }, set currentTime(t){ this.ed = toEd(t); }};
    vid = liveClock; setVideo(vid); st.over = {}; renderTL();
    liveClock.currentTime = s0.t[0] + O0 - 0.5;
    const trk = document.querySelector('#tl .trk').getBoundingClientRect(), xAt = edT => trk.left + edT / edDur() * trk.width, y = trk.top + trk.height / 2;
    const fire = (el, type, x) => el.dispatchEvent(new PointerEvent(type, {bubbles:true, clientX:x, clientY:y, pointerId:1}));
    const h0 = document.querySelector(`[data-trim="${s0.id}"]`);
    fire(h0, 'pointerdown', xAt(O0)); fire(window, 'pointermove', xAt(L0)); fire(window, 'pointerup', xAt(L0));
    eq([sceneAt(now()).id, isCut(now())], [s0.id, false], 'trim over the playhead stays in the trimmed scene');
    liveClock.currentTime = s1.t[0] + 0.4; const before = now();
    Object.assign(ui, {scene:s0.id, tab:'scene'}); renderPane(); document.querySelector(`[data-undo="${s0.id}.@len"]`).click();
    eq(r3(now()), r3(before), 'undoing a trim keeps the playhead on the same content');
    st.over = {[`${last.id}.@len`]: fps1(last.t[1] - last.t[0] - 0.5)}; seek(sceneEnd(last));
    eq(now() < sceneEnd(last), true, 'seek never lands past the trimmed end');
    st.over = {[`${s0.id}.@len`]: L0}; seek(s0.t[0] + L0 - 0.5);
    document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', shiftKey:true, bubbles:true}));
    eq(sceneAt(now()).id, s1.id, 'Shift+Right steps across a cut');
    // Send with the server unreachable marks nothing as sent
    st.over = {[`${s0.id}.@len`]: L0}; st.sentSnap = {}; const realFetch = window.fetch; window.fetch = () => Promise.reject(new Error('offline'));
    try { await sendFeedback(); } finally { window.fetch = realFetch; }
    eq(pendingEdits(), 1, 'failed send keeps edits pending');
    // conversation pane: the queue mirrors the unsent state
    st.over = {}; st.sentSnap = {}; st.sent = []; st.links = [];
    st.notes = [{id: 501, t: s1.t[0] + 0.2, x: 10, y: 10, el: null, text: 'a'}, {id: 502, t: s1.t[0] + 0.4, x: 20, y: 20, el: null, text: 'b'}];
    st.messages = [{id: 1, text: 'make it faster'}];
    const te = allEls().find(x => Object.values(x.props).some(p => p.type === 'text')), tk = Object.keys(te.props).find(k => te.props[k].type === 'text');
    set(`${te.id}.${tk}`, 'New words', te.props[tk].v); set(`${s0.id}.@len`, L0, O0); renderQueue();
    const q = document.querySelector('#convoQ');
    eq([q.querySelectorAll('.ql').length, q.querySelectorAll('[data-note-bub]').length, q.querySelectorAll('[data-msg]').length, q.querySelectorAll('[data-trim-bub]').length], [1, 2, 1, 1], 'one Changes line, two notes, one message, one trim');
    eq([...q.querySelectorAll('[data-note-bub] .num')].map(x => x.textContent), ['1', '2'], 'note bubbles carry the pin number');
    q.querySelector(`.ql [data-undo="${te.id}.${tk}"]`).click();
    eq(`${te.id}.${tk}` in st.over, false, 'Undo on a Changes line removes that edit');
    eq(feedback().messages, ['make it faster'], 'messages go in the payload');
    // typing in a queued note survives a transcript refresh
    const ta = document.querySelector('[data-note-text="501"]'); ta.focus();
    convo.sig = ''; renderTranscript([{id: 'x', at: new Date().toISOString(), role: 'agent', text: 'hello'}], 'listening', 0);
    eq(document.activeElement === document.querySelector('[data-note-text="501"]'), true, 'refresh keeps focus in a queued note');
    // markdown subset, HTML stays text
    eq(md('<img src=x onerror=alert(1)>').includes('<img'), false, 'markdown escapes HTML');
    eq(md('**a** `b`\n\n- x\n- y'), '<p><b>a</b> <code>b</code></p><ul><li>x</li><li>y</li></ul>', 'markdown subset');
    // double-click sends one batch; success empties the queue
    let posts = 0; const rf = window.fetch;
    window.fetch = async (u, o) => { if (o?.method === 'POST') { posts++; await new Promise(r => setTimeout(r, 50)); } return {ok: true, json: async () => ({entries: [], presence: 'idle', waiting: 0})}; };
    try { await Promise.all([sendFeedback(), sendFeedback()]); } finally { window.fetch = rf; }
    eq([posts, st.messages.length, queueCount()], [1, 0, 0], 'one send, queue emptied');
    // typing in the composer and pressing Send to Agent sends that text (no Enter needed)
    st.over = {}; st.messages = []; st.notes = st.notes.filter(n => st.sent.includes(n.id)); st.links = []; renderQueue();
    const mi = document.querySelector('#msgIn'); mi.value = 'hello'; mi.dispatchEvent(new Event('input', {bubbles: true}));
    eq(document.querySelector('#sendBtn').disabled, false, 'typing enables Send to Agent');
    let sentBody = null; const rf3 = window.fetch; window.fetch = async (u, o) => { if (o?.method === 'POST') sentBody = JSON.parse(o.body); return {ok: true, json: async () => ({entries: [], presence: 'idle', waiting: 0})}; };
    try { await sendFeedback(); } finally { window.fetch = rf3; }
    eq([sentBody?.messages, mi.value, st.messages.length], [['hello'], '', 0], 'the typed text is sent and the box clears');
    const bub = document.createElement('div'); bub.innerHTML = entryHTML({role: 'user', at: new Date().toISOString(), status: 'sent', batch: {messages: ['hello'], notes: [{n: 1, t: 1, text: 'x'}]}});
    eq([bub.querySelector('summary .md')?.textContent, bub.querySelector('summary .sum')?.textContent], ['hello', '1 note'], 'a sent message shows its text in the bubble');
    // a keyframe edit changed after Send survives the new version (it replaces reel keys, so it can't double-apply)
    eq(keepAfterNewVersion({'a.@keys': [{t: 1, box: [2]}]}, {'a.@keys': [{t: 1, box: [1]}]}), {'a.@keys': [{t: 1, box: [2]}]}, 'a keyframe revision made after Send is kept');
    // Undo is held while a send is in flight, so the agent never gets an edit the user already undid
    st.over = {[`${s0.id}.@len`]: L0}; convo.sending = true; undoPath(`${s0.id}.@len`); convo.sending = false;
    eq(`${s0.id}.@len` in st.over, true, 'Undo waits while a send is in flight');
    // deleting a queued item is held while a send is in flight (it's already in the request)
    st.messages = [{id: 9, text: 'keep me'}]; st.notes = [{id: 902, t: 1, x: 1, y: 1, el: null, text: 'n'}]; st.sent = []; st.links = [{url: 'https://a.example/x'}]; renderQueue(); convo.sending = true;
    for (const sel of ['[data-del-msg="9"]', '[data-del-note="902"]', '[data-del-link="0"]']) document.querySelector(`#convoQ ${sel}`)?.click();
    convo.sending = false;
    eq([st.messages.length, st.notes.length, st.links.length], [1, 1, 1], 'queued items cannot be deleted while a send is in flight');
    // a note edited while its send is in flight stays queued with the new text
    st.over = {}; st.messages = []; st.notes = [{id: 801, t: 1, x: 1, y: 1, el: null, text: 'old'}]; st.sent = []; let rel2; const rf4 = window.fetch;
    window.fetch = (u, o) => o?.method === 'POST' ? new Promise(r => rel2 = () => r({ok: true, json: async () => ({})})) : Promise.resolve({ok: true, json: async () => ({entries: [], presence: 'idle', waiting: 0})});
    try { const sending = sendFeedback(); st.notes[0].text = 'new'; rel2(); await sending; } finally { window.fetch = rf4; }
    eq(openNotes().map(n => n.text), ['new'], 'a note edited during a send stays queued');
    // things queued while a send is in flight stay queued
    st.messages = [{id: 7, text: 'first'}]; let release; const rf2 = window.fetch;
    window.fetch = (u, o) => o?.method === 'POST' ? new Promise(r => release = () => r({ok: true, json: async () => ({})})) : Promise.resolve({ok: true, json: async () => ({entries: [], presence: 'idle', waiting: 0})});
    try { const sending = sendFeedback(); st.messages.push({id: 8, text: 'second'}); st.notes.push({id: 777, t: 1, x: 1, y: 1, el: null, text: 'late'}); release(); await sending; } finally { window.fetch = rf2; }
    eq([st.messages.map(m => m.id), openNotes().some(n => n.id === 777)], [[8], true], 'things added during a send stay queued');
    // edits pointing at elements or scenes a new version removed are dropped, so the queue and load never crash
    st.over = {'gone-el.text': 'x', 'S99.@len': 3, [`${s0.id}.@len`]: L0, 'brand.color.zzz': '#fff'}; st.notes = [{id: 901, t: 1, x: 1, y: 1, el: 'gone-el', text: 'n'}];
    pruneMissing();
    eq([Object.keys(st.over), st.notes[0].el], [[`${s0.id}.@len`], null], 'edits on removed elements, scenes and brand entries are dropped');
    const nb = allEls().find(x => x.box), nbBox = nb.box, nbRef = sceneOf(nb.s).els.find(x => x.id === nb.id); nbRef.box = null;
    try { st.over = {[`${nb.id}.@box`]: [1, 1, 5, 5], [`${nb.id}.@keys`]: []}; pruneMissing(); eq(Object.keys(st.over), [], 'box edits on an element that lost its box are dropped'); } finally { nbRef.box = nbBox; }
    // trims: a full-length drag stores nothing; a no-op trim is never queued or sent
    st.over = {}; setTrim({id: s0.id, t: [s0.t[0], s0.t[0] + 4.699999999999999]}, 4.7); eq(`${s0.id}.@len` in st.over, false, 'dragging back to full length stores no trim');
    st.over = {}; st.sentSnap = {}; const qc0 = queueCount(); st.over = {[`${s0.id}.@len`]: O0 + 1}; eq(queueCount(), qc0, 'a trim not shorter than the scene is not counted as queued');
    st.over = {[`${s0.id}.@len`]: O0 + 1}; renderQueue(); eq([feedback().trims.length, document.querySelectorAll('#convoQ [data-trim-bub]').length], [0, 0], 'a trim not shorter than the scene is not queued or sent');
    // keyframe times typed in the card stay inside the element and never collide
    const ke2 = allEls().find(x => x.box && x.t[1] - x.t[0] > 2); st.over = {};
    setKeys(ke2, [{t: fps1(ke2.t[0] + 0.5), box: ke2.box}, {t: fps1(ke2.t[0] + 1.5), box: ke2.box.map(v => v + 1)}]);
    Object.assign(ui, {sel: ke2.id, scene: ke2.s, tab: 'scene'}); renderPane();
    const typeT = (i, v) => { const inp = document.querySelector(`[data-key="${ke2.id}"][data-i="${i}"][data-ix="t"]`); inp.value = String(v); inp.dispatchEvent(new Event('change', {bubbles: true})); };
    typeT(1, toEd(ke2.t[1]) + 5); eq(elKeys(elById(ke2.id))[1].t <= ke2.t[1] + 1e-6, true, 'a typed time past the element end is clamped to it');
    renderPane(); typeT(1, +toEd(elKeys(elById(ke2.id))[0].t).toFixed(2)); const kk = elKeys(elById(ke2.id)); eq(kk[1].t > kk[0].t, true, 'two keyframes never share a time');
    st.over = {'gone-el.text': 'x'}; let threw = false; try { renderQueue(); } catch (e) { threw = true; } eq(threw, false, 'the queue skips an edit on a removed element');
  } finally { vid = realVid; setVideo(vid); st.over = JSON.parse(saved); Object.assign(st, JSON.parse(savedQ)); markDirty(); renderAll(); }
  return 'selftest ok';
}
