// Adapts a live composition to the video interface used by the editor.
export function liveVideo(api, {toEd, toSrc, fps}){
  const on = {}, fire = n => (on[n] || []).forEach(f => f()), p = () => api.ref.current;
  let rate = 1, t0 = 0;
  const wait = setInterval(() => { if (!p()) return; clearInterval(wait);
    ['play', 'pause', 'ended'].forEach(n => p().addEventListener(n, () => fire(n)));
    p().seekTo(Math.round(toEd(t0) * fps)); fire('loadedmetadata'); }, 30);
  return {
    get currentTime(){ return p() ? toSrc(p().getCurrentFrame() / fps) : t0; },
    set currentTime(t){ t0 = t; if (p()) { p().seekTo(Math.round(toEd(t) * fps)); setTimeout(() => fire('seeked'), 30); } },
    get paused(){ return !p()?.isPlaying(); },
    play(){ p()?.play(); return Promise.resolve(); }, pause(){ p()?.pause(); },
    get playbackRate(){ return rate; }, set playbackRate(r){ rate = r; api.setRate(r); },
    addEventListener(n, f){ (on[n] ||= []).push(f); }, set src(v){}, videoWidth: 0,
  };
}
