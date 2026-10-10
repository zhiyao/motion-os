// Adapts a live composition to the video interface used by the editor.
export function liveVideo(api, { toEd, toSrc, fps }) {
  const listeners = {};
  const getPlayer = () => api.ref.current;
  const emit = (eventName) => {
    for (const listener of listeners[eventName] || []) {
      listener();
    }
  };
  let playbackRate = 1;
  let pendingRenderTime = 0;

  // The composition mounts asynchronously. Apply any seek requested before it was ready.
  const mountTimer = setInterval(() => {
    const player = getPlayer();
    if (!player) {
      return;
    }
    clearInterval(mountTimer);
    for (const eventName of ['play', 'pause', 'ended']) {
      player.addEventListener(eventName, () => emit(eventName));
    }
    player.seekTo(Math.round(toEd(pendingRenderTime) * fps));
    emit('loadedmetadata');
  }, 30);

  return {
    get currentTime() {
      const player = getPlayer();
      return player ? toSrc(player.getCurrentFrame() / fps) : pendingRenderTime;
    },
    set currentTime(renderTime) {
      pendingRenderTime = renderTime;
      const player = getPlayer();
      if (player) {
        player.seekTo(Math.round(toEd(renderTime) * fps));
        setTimeout(() => emit('seeked'), 30);
      }
    },
    get paused() {
      return !getPlayer()?.isPlaying();
    },
    play() {
      getPlayer()?.play();
      return Promise.resolve();
    },
    pause() {
      getPlayer()?.pause();
    },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(rate) {
      playbackRate = rate;
      api.setRate(rate);
    },
    addEventListener(eventName, listener) {
      (listeners[eventName] ||= []).push(listener);
    },
    // The live composition has no media URL; the editor can still assign src like a video.
    set src(value) {},
    videoWidth: 0,
  };
}
