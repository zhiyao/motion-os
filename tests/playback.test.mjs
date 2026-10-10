import test from 'node:test';
import assert from 'node:assert/strict';
import { liveVideo } from '../player/playback.mjs';
test('live adapter converts render time to frames and forwards controls and events', async () => {
  const listeners = {};
  let frame = 0;
  let running = false;
  let rate;
  const api = {
    ref: {
      current: null,
    },
    setRate: (value) => (rate = value),
  };
  const video = liveVideo(api, {
    toEd: (t) => t / 2,
    toSrc: (t) => t * 2,
    fps: 30,
  });
  video.currentTime = 4;
  assert.equal(video.currentTime, 4);
  const loaded = new Promise((resolve) => video.addEventListener('loadedmetadata', resolve));
  api.ref.current = {
    addEventListener: (n, f) => (listeners[n] = f),
    seekTo: (f) => (frame = f),
    getCurrentFrame: () => frame,
    isPlaying: () => running,
    play() {
      running = true;
      listeners.play();
    },
    pause() {
      running = false;
      listeners.pause();
    },
  };
  await loaded;
  assert.equal(frame, 60);
  assert.equal(video.currentTime, 4);
  let played = false;
  video.addEventListener('play', () => (played = true));
  await video.play();
  assert.equal(played, true);
  assert.equal(video.paused, false);
  video.pause();
  assert.equal(video.paused, true);
  video.playbackRate = 2;
  assert.equal(rate, 2);
  assert.equal(video.playbackRate, 2);
  const seeked = new Promise((resolve) => video.addEventListener('seeked', resolve));
  video.currentTime = 6;
  await seeked;
  assert.equal(frame, 90);
  assert.equal(video.currentTime, 6);
});
