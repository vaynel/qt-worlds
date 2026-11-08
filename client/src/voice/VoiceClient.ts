import type { ErrorCode, VoicePeerInfo, VoiceSignal } from '../../../shared/protocol';
import { api, ApiError } from '../net/api';
import type { NetClient } from '../net/NetClient';

export type VoiceState = 'idle' | 'joining' | 'in';

interface Peer extends VoicePeerInfo {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: HTMLAudioElement;
  /** 0..100, this listener only. */
  volume: number;
  /** Muted by me (only for me). */
  localMuted: boolean;
  /** Signals are applied strictly in order (ICE must wait for the SDP). */
  chain: Promise<void>;
}

export interface VoiceHooks {
  onChange: () => void;
  toast: (text: string) => void;
  /** Joined (true) / left (false): duck worship and ambience. */
  onActive: (active: boolean) => void;
  /** Master 음성 volume 0..100. */
  masterVolume: () => number;
  /** Permission is "prompt": show our own explanation first; resolves true on [마이크 켜기]. */
  micPrePrompt: () => Promise<boolean>;
  /** Permission is denied: device-specific help; resolves true on [다시 시도]. */
  micHelp: () => Promise<boolean>;
}

/** Keep the mic this long after leaving voice (re-joining needs no new prompt). */
const MIC_KEEP_MS = 10 * 60 * 1000;
export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/** permissions.query where supported (Safari may not know 'microphone'). */
export async function micPermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    return status ? (status.state as MicPermission) : 'unknown';
  } catch {
    return 'unknown';
  }
}

const SPEAK_THRESHOLD = 0.035;
const SPEAK_HOLD_MS = 450;

/**
 * Group voice prayer room: a WebRTC mesh (audio only, Opus, <= 8 people) with
 * signaling over our authenticated WebSocket and "perfect negotiation" for
 * glare. The newcomer offers to everyone already in the room. Nothing is
 * recorded; the server only relays signaling between room members.
 */
export class VoiceClient {
  state: VoiceState = 'idle';
  groupId: number | null = null;
  groupName = '';
  selfId = '';
  owner = false;
  muted = true;
  speaking = false;
  private readonly peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private mic: MediaStream | null = null;
  private analyser: { ctx: AudioContext; node: AnalyserNode; timer: number; data: Float32Array<ArrayBuffer> } | null = null;
  private lastLoud = 0;
  /** Set while we want to be in a room (survives reconnects). */
  private wantedGroup: number | null = null;
  private readonly audioRoot: HTMLElement;
  /** Signaling counters (diagnostics / tests). */
  private readonly counters = { iceSent: 0, iceReceived: 0, iceErrors: 0, sdpSent: 0, sdpReceived: 0, micRequests: 0 };
  /** The user unmuted last (restored silently after a reconnect). */
  private wantUnmuted = false;
  private releaseTimer = 0;
  private micBusy = false;

  constructor(
    private readonly net: NetClient,
    private readonly hooks: VoiceHooks,
  ) {
    this.audioRoot = document.createElement('div');
    this.audioRoot.id = 'voice-audio';
    this.audioRoot.hidden = true;
    document.body.append(this.audioRoot);
    net.on({
      voiceRoom: (m) => this.onRoom(m),
      voicePeer: (peer, joined) => this.onPeer(peer, joined),
      voicePeerLeft: (id) => this.closePeer(id),
      voiceSignal: (from, data) => this.queueSignal(from, data),
      voiceLeft: (reason) => this.onLeft(reason),
      voiceError: (code, message) => this.onError(code, message),
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    // The page is going away: release the microphone (browser indicator off).
    window.addEventListener('pagehide', () => this.releaseMic());
  }

  get active(): boolean {
    return this.state !== 'idle';
  }

  peerList(): Peer[] {
    return [...this.peers.values()];
  }

  // ---------------------------------------------------------------- join / leave

  async join(groupId: number) {
    if (this.state !== 'idle' && this.groupId === groupId) return;
    if (this.state !== 'idle') this.leave();
    this.state = 'joining';
    this.groupId = groupId;
    this.wantedGroup = groupId;
    this.hooks.onChange();
    try {
      const r = await api<{ iceServers: RTCIceServer[] }>('GET', `/api/voice/ice?group=${groupId}`);
      this.iceServers = r.iceServers;
    } catch (err) {
      this.state = 'idle';
      this.groupId = null;
      this.wantedGroup = null;
      this.hooks.toast(err instanceof ApiError ? err.message : '음성 기도방에 들어가지 못했어요.');
      this.hooks.onChange();
      return;
    }
    this.net.voiceJoin(groupId);
  }

  leave() {
    this.wantedGroup = null;
    this.wantUnmuted = false;
    if (this.state === 'idle') return;
    this.net.voiceLeave();
    this.cleanup();
  }

  /** Stop the microphone for real (page unload, or 10 min out of voice). */
  releaseMic() {
    window.clearTimeout(this.releaseTimer);
    this.stopAnalyser();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
  }

  /** After a WebSocket reconnect the server forgot us: rejoin if we were in a room. */
  rejoinAfterReconnect() {
    const g = this.wantedGroup;
    if (g === null) return;
    this.cleanup(false);
    this.wantedGroup = g;
    this.state = 'joining';
    this.groupId = g;
    this.net.voiceJoin(g);
    this.hooks.onChange();
  }

  /**
   * Drop all peers. The microphone is kept (muted) so a later unmute or
   * rejoin needs no new permission prompt; it is released after MIC_KEEP_MS
   * out of voice, or when the page closes.
   */
  private cleanup(leaving = true) {
    for (const id of [...this.peers.keys()]) this.closePeer(id, false);
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = false;
    this.muted = true;
    if (leaving) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = window.setTimeout(() => {
        if (this.state === 'idle') this.releaseMic();
      }, MIC_KEEP_MS);
    }
    this.speaking = false;
    const wasActive = this.state !== 'idle';
    this.state = 'idle';
    this.groupId = null;
    this.selfId = '';
    if (wasActive) this.hooks.onActive(false);
    this.hooks.onChange();
  }

  private onRoom(m: { groupId: number; groupName: string; selfId: string; owner: boolean; peers: VoicePeerInfo[] }) {
    if (this.wantedGroup !== m.groupId) {
      // We left meanwhile.
      this.net.voiceLeave();
      return;
    }
    const first = this.state !== 'in';
    window.clearTimeout(this.releaseTimer);
    this.state = 'in';
    this.groupId = m.groupId;
    this.groupName = m.groupName;
    this.selfId = m.selfId;
    this.owner = m.owner;
    // Joined muted (server rule); keep the local mic disabled until unmuted.
    if (this.mic) for (const t of this.mic.getAudioTracks()) t.enabled = false;
    this.muted = true;
    // The newcomer offers to everyone already here.
    for (const p of m.peers) this.createPeer(p, true);
    if (first) this.hooks.onActive(true);
    this.hooks.onChange();
    // After a reconnect, restore "unmuted" if the mic is already ours (no prompt).
    if (this.wantUnmuted && this.mic) void this.setMuted(false);
  }

  private onPeer(info: VoicePeerInfo, joined: boolean) {
    if (this.state !== 'in') return;
    const p = this.peers.get(info.id);
    if (joined && !p) {
      // They will offer to us.
      this.createPeer(info, false);
    } else if (p) {
      p.muted = info.muted;
      p.speaking = info.speaking;
      p.name = info.name;
      p.owner = info.owner;
    }
    this.hooks.onChange();
  }

  private onLeft(reason: 'left' | 'kicked' | 'removed') {
    if (reason === 'kicked') this.hooks.toast('방장이 음성 기도방에서 내보냈어요. 10분 뒤에 다시 들어올 수 있어요.');
    if (reason === 'removed') this.hooks.toast('모임에서 나와서 음성 기도방도 나왔어요.');
    this.wantedGroup = null;
    this.wantUnmuted = false;
    this.cleanup();
  }

  private onError(code: ErrorCode, message: string) {
    this.hooks.toast(message);
    if (this.state === 'joining' && (code === 'voice_full' || code === 'voice_blocked' || code === 'voice_not_member' || code === 'voice_login')) {
      this.wantedGroup = null;
      this.cleanup();
    }
  }

  // ---------------------------------------------------------------- peers

  private createPeer(info: VoicePeerInfo, initiator: boolean) {
    this.closePeer(info.id, false);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.dataset.peer = info.id;
    this.audioRoot.append(audio);
    const peer: Peer = {
      ...info,
      pc,
      polite: this.selfId < info.id,
      makingOffer: false,
      ignoreOffer: false,
      audio,
      volume: 100,
      localMuted: false,
      chain: Promise.resolve(),
    };
    this.peers.set(info.id, peer);
    this.applyVolume(peer);

    if (initiator) {
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (this.mic) void tr.sender.replaceTrack(this.mic.getAudioTracks()[0] ?? null);
    }
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.net.voiceSignal(peer.id, { type: pc.localDescription.type as 'offer', sdp: pc.localDescription.sdp });
      } catch {
        /* a later negotiation will retry */
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !candidate.candidate) return;
      this.counters.iceSent++;
      this.net.voiceSignal(peer.id, {
        type: 'ice',
        candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex },
      });
    };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => undefined);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
      this.hooks.onChange();
    };
    pc.onconnectionstatechange = () => this.hooks.onChange();
  }

  private closePeer(id: string, notify = true) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try {
      p.pc.close();
    } catch {
      /* ignore */
    }
    p.audio.srcObject = null;
    p.audio.remove();
    if (notify) this.hooks.onChange();
  }

  private queueSignal(from: string, data: VoiceSignal) {
    const p = this.peers.get(from);
    if (!p) return;
    p.chain = p.chain.then(() => this.onSignal(from, data)).catch(() => undefined);
  }

  private async onSignal(from: string, data: VoiceSignal) {
    const p = this.peers.get(from);
    if (!p) return;
    const pc = p.pc;
    try {
      if (data.type === 'offer' || data.type === 'answer') {
        this.counters.sdpReceived++;
        const collision = data.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription({ type: data.type, sdp: data.sdp });
        if (data.type === 'offer') {
          // Answerer: send our mic (if any) on the transceivers the offer created.
          for (const t of pc.getTransceivers()) {
            if (t.receiver.track.kind !== 'audio') continue;
            t.direction = 'sendrecv';
            if (this.mic && !t.sender.track) await t.sender.replaceTrack(this.mic.getAudioTracks()[0] ?? null);
          }
          await pc.setLocalDescription();
          if (pc.localDescription) this.net.voiceSignal(from, { type: 'answer', sdp: pc.localDescription.sdp });
        }
      } else if (data.type === 'ice') {
        this.counters.iceReceived++;
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          this.counters.iceErrors++;
          if (!p.ignoreOffer) throw err;
        }
      }
    } catch {
      /* malformed or stale signal: ignore */
    }
  }

  // ---------------------------------------------------------------- mic

  /**
   * Listening never needs the mic. It is requested once, only on the first
   * unmute (🎤), and then kept: mute/unmute just toggles track.enabled.
   */
  async setMuted(muted: boolean) {
    if (this.state !== 'in') return;
    if (!muted && !this.mic) {
      if (this.micBusy) return;
      this.micBusy = true;
      try {
        if (!(await this.acquireMic())) return;
      } finally {
        this.micBusy = false;
      }
      if (this.state !== 'in' || !this.mic) return;
    }
    if (!muted && this.mic) {
      const track = this.mic.getAudioTracks()[0];
      for (const p of this.peers.values()) {
        for (const t of p.pc.getTransceivers()) {
          if (t.receiver.track.kind === 'audio' && t.sender.track !== track) await t.sender.replaceTrack(track);
        }
      }
      if (!this.analyser) this.startAnalyser(this.mic);
    }
    this.wantUnmuted = !muted;
    this.muted = muted;
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
    if (muted) this.setSpeaking(false);
    this.net.voiceMute(muted);
    this.hooks.onChange();
  }

  /** Permission-aware single request: granted → silent; prompt → our pre-prompt; denied → help. */
  private async acquireMic(): Promise<boolean> {
    for (;;) {
      const perm = await micPermission();
      if (perm === 'denied') {
        if (!(await this.hooks.micHelp())) return false;
        continue; // 다시 시도
      }
      if (perm === 'prompt' && !(await this.hooks.micPrePrompt())) return false;
      try {
        this.counters.micRequests++;
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        return true;
      } catch (err) {
        const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        if (!denied) {
          this.hooks.toast('마이크를 찾지 못했어요. 연결을 확인해 주세요.');
          return false;
        }
        if (!(await this.hooks.micHelp())) return false;
      }
    }
  }

  private startAnalyser(stream: MediaStream) {
    this.stopAnalyser();
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const node = ctx.createAnalyser();
    node.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(node);
    const data = new Float32Array(node.fftSize);
    const timer = window.setInterval(() => {
      if (this.muted) return;
      node.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (rms > SPEAK_THRESHOLD) this.lastLoud = now;
      this.setSpeaking(now - this.lastLoud < SPEAK_HOLD_MS);
    }, 120);
    this.analyser = { ctx, node, timer, data };
  }

  private stopAnalyser() {
    if (!this.analyser) return;
    window.clearInterval(this.analyser.timer);
    void this.analyser.ctx.close().catch(() => undefined);
    this.analyser = null;
  }

  private setSpeaking(speaking: boolean) {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.net.voiceSpeaking(speaking);
    this.hooks.onChange();
  }

  // ---------------------------------------------------------------- listening

  setPeerVolume(id: string, volume: number) {
    const p = this.peers.get(id);
    if (!p) return;
    p.volume = Math.max(0, Math.min(100, volume));
    this.applyVolume(p);
  }

  setPeerLocalMuted(id: string, muted: boolean) {
    const p = this.peers.get(id);
    if (!p) return;
    p.localMuted = muted;
    this.applyVolume(p);
    this.hooks.onChange();
  }

  /** Master 음성 slider changed. */
  applyAllVolumes() {
    for (const p of this.peers.values()) this.applyVolume(p);
  }

  private applyVolume(p: Peer) {
    p.audio.volume = Math.max(0, Math.min(1, (p.volume / 100) * (this.hooks.masterVolume() / 100)));
    p.audio.muted = p.localMuted;
  }

  kick(id: string) {
    if (this.owner) this.net.voiceKick(id);
  }

  private readonly onVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    // Back from the background: repair broken connections.
    for (const p of this.peers.values()) {
      if (p.pc.iceConnectionState === 'failed' || p.pc.iceConnectionState === 'disconnected') p.pc.restartIce();
    }
  };

  // ---------------------------------------------------------------- diagnostics

  async stats() {
    const out: { id: string; bytesReceived: number; packetsReceived: number; connection: string }[] = [];
    for (const p of this.peers.values()) {
      let bytes = 0;
      let packets = 0;
      try {
        const report = await p.pc.getStats();
        report.forEach((s) => {
          const r = s as { type: string; kind?: string; bytesReceived?: number; packetsReceived?: number };
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            bytes += r.bytesReceived ?? 0;
            packets += r.packetsReceived ?? 0;
          }
        });
      } catch {
        /* closed */
      }
      out.push({ id: p.id, bytesReceived: bytes, packetsReceived: packets, connection: p.pc.connectionState });
    }
    return out;
  }

  describe() {
    return {
      state: this.state,
      groupId: this.groupId,
      groupName: this.groupName,
      selfId: this.selfId,
      owner: this.owner,
      muted: this.muted,
      speaking: this.speaking,
      micTracks: this.mic?.getTracks().map((t) => t.readyState) ?? [],
      micEnabled: this.mic?.getAudioTracks().some((t) => t.enabled) ?? false,
      wantUnmuted: this.wantUnmuted,
      peers: this.peerList().map((p) => ({
        id: p.id,
        name: p.name,
        muted: p.muted,
        speaking: p.speaking,
        owner: p.owner,
        connection: p.pc.connectionState,
        localMuted: p.localMuted,
        volume: p.volume,
      })),
      audioElements: this.audioRoot.querySelectorAll('audio').length,
      signaling: { ...this.counters },
    };
  }
}
