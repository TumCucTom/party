// ============================================================
// Rtc — proximity video calls (PeerJS, loaded globally by
// index.html) with true spatial voice: every remote stream is
// routed through a WebAudio PannerNode positioned at that
// player's avatar, so people sound like where they stand.
// Call setup mirrors the original 2D party app: walk close to
// someone to ring them, walk away to hang up; the peer with the
// lower id places the call to avoid glare.
// ============================================================

import * as THREE from 'three';
import { CALL_DISTANCE, HANGUP_DISTANCE, VOICE_REF_DISTANCE } from './constants.js';

const _fwd = new THREE.Vector3();

const PEER_PREFIX = 'w3-';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export class Rtc {
  /** @param {AudioContext} ctx shared game AudioContext (already resumed) */
  constructor(ctx) {
    this.ctx = ctx;
    this.peer = null;
    this.myId = null;
    this.myStream = null;
    this.calls = new Map();   // socketId -> { call, video, source, panner }
    this.pending = new Set(); // socketIds we are currently dialing

    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 1;
    this.voiceGain.connect(ctx.destination);

    // hidden holder so remote <video> elements live in the DOM
    this.mediaHolder = document.createElement('div');
    this.mediaHolder.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;';
    document.body.appendChild(this.mediaHolder);

    this.onVideo = null;    // (socketId, videoElement)
    this.onVideoEnd = null; // (socketId)
  }

  /** @param {MediaStream|null} stream local cam/mic (null = spectator) */
  init(myId, stream) {
    this.myId = myId;
    this.myStream = stream || this._dummyStream();
    this.peer = new window.Peer(PEER_PREFIX + myId, {
      config: { iceServers: ICE_SERVERS },
    });
    this.peer.on('call', (call) => {
      call.answer(this.myStream);
      this._wireCall(call);
    });
    this.peer.on('error', (err) => console.warn('[rtc]', err.type || err));
  }

  /** Valid stream to answer/call with when we have no cam & mic. */
  _dummyStream() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const stream = canvas.captureStream(1);
    const silence = this.ctx.createMediaStreamDestination();
    for (const track of silence.stream.getAudioTracks()) stream.addTrack(track);
    return stream;
  }

  _socketIdOf(call) {
    return call.peer.startsWith(PEER_PREFIX) ? call.peer.slice(PEER_PREFIX.length) : call.peer;
  }

  _wireCall(call) {
    const id = this._socketIdOf(call);
    const existing = this.calls.get(id);
    if (existing && existing.call !== call) existing.call.close();
    this.calls.set(id, { call, video: null, source: null, panner: null });

    call.on('stream', (remote) => {
      const entry = this.calls.get(id);
      if (!entry || entry.call !== call || entry.video) return;

      // video element: muted — audio goes through the spatial graph below
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.srcObject = remote;
      this.mediaHolder.appendChild(video);
      video.play().catch(() => {});
      entry.video = video;

      if (remote.getAudioTracks().length) {
        const panner = this.ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'linear';
        panner.refDistance = VOICE_REF_DISTANCE;
        panner.maxDistance = HANGUP_DISTANCE;
        panner.rolloffFactor = 1;
        const source = this.ctx.createMediaStreamSource(remote);
        source.connect(panner);
        panner.connect(this.voiceGain);
        entry.source = source;
        entry.panner = panner;
      }
      this.pending.delete(id);
      this.onVideo?.(id, video);
    });
    call.on('close', () => this.hangUp(id));
    call.on('error', () => this.hangUp(id));
  }

  call(socketId) {
    if (!this.peer || this.calls.has(socketId) || this.pending.has(socketId)) return;
    if (this.myId >= socketId) return; // the lower id dials; the other answers
    this.pending.add(socketId);
    const call = this.peer.call(PEER_PREFIX + socketId, this.myStream);
    if (!call) { this.pending.delete(socketId); return; }
    this._wireCall(call);
  }

  hangUp(socketId) {
    this.pending.delete(socketId);
    const entry = this.calls.get(socketId);
    if (!entry) return;
    this.calls.delete(socketId);
    try { entry.call.close(); } catch { /* already closed */ }
    entry.source?.disconnect();
    entry.panner?.disconnect();
    if (entry.video) {
      entry.video.srcObject = null;
      entry.video.remove();
    }
    this.onVideoEnd?.(socketId);
  }

  /**
   * Ring players that came in range, hang up on those who left it.
   * @param {Array<{id: string, distance: number}>} others
   */
  updateProximity(others) {
    const seen = new Set();
    for (const { id, distance } of others) {
      seen.add(id);
      if (distance < CALL_DISTANCE) this.call(id);
      else if (distance > HANGUP_DISTANCE) this.hangUp(id);
    }
    for (const id of [...this.calls.keys()]) {
      if (!seen.has(id)) this.hangUp(id);
    }
    for (const id of [...this.pending]) {
      if (!seen.has(id)) this.pending.delete(id);
    }
  }

  /** Per-frame: move the WebAudio listener to the camera. */
  updateListener(camera) {
    const l = this.ctx.listener;
    const p = camera.position;
    const fwd = camera.getWorldDirection(_fwd);
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  /** Per-frame: move a remote player's voice to their avatar. */
  setPeerPosition(socketId, pos) {
    const panner = this.calls.get(socketId)?.panner;
    if (!panner) return;
    if (panner.positionX) {
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  dispose() {
    for (const id of [...this.calls.keys()]) this.hangUp(id);
    this.peer?.destroy();
  }
}
