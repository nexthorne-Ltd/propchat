// Synthesizes pleasant modern UI audio chimes using Web Audio API
const STORAGE_KEY = 'zentry_sound_enabled';
const LEGACY_STORAGE_KEY = 'chatify_sound_enabled';

class SoundManager {
  private ctx: AudioContext | null = null;
  private soundEnabled: boolean = true;
  private hydrated = false;
  private listeners = new Set<() => void>();

  /**
   * The stored preference is read on first client access rather than in the
   * constructor, which also runs during SSR where localStorage does not exist.
   */
  private hydrate() {
    if (this.hydrated || typeof window === 'undefined') return;
    this.hydrated = true;
    try {
      const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (stored !== null) this.soundEnabled = stored === 'true';
    } catch {
      // Storage unavailable — keep the default.
    }
  }

  /** Lets React subscribe to the preference via useSyncExternalStore. */
  public subscribe = (onChange: () => void) => {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  };

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    this.armUnlock();
    return this.ctx;
  }

  /**
   * Browsers keep audio muted until the page has had a click or key press. An
   * agent who opens the inbox and just watches it would otherwise never hear
   * the first customer message, so the first interaction anywhere unlocks it.
   */
  private unlockArmed = false;
  private armUnlock() {
    if (this.unlockArmed || typeof window === 'undefined') return;
    this.unlockArmed = true;
    const unlock = () => {
      const ctx = this.ctx;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (!ctx || ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  /** Call once on page load so audio is unlocked by the agent's first click. */
  public prime() {
    this.hydrate();
    this.getContext();
  }

  /** Several messages arriving together play one alert, not a pile-up. */
  private lastAlertAt = 0;

  /** A bright bell note: a sine plus a quieter octave for a clear, cutting tone. */
  private bell(ctx: AudioContext, out: AudioNode, freq: number, start: number, peak: number, length: number) {
    for (const [mult, level, type] of [
      [1, 1, 'sine'],
      [2, 0.35, 'triangle'],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq * mult, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak * level, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain);
      gain.connect(out);
      osc.start(start);
      osc.stop(start + length + 0.02);
    }
  }

  public toggleSound(enable?: boolean): boolean {
    this.hydrate();
    this.soundEnabled = enable !== undefined ? enable : !this.soundEnabled;
    try {
      localStorage.setItem(STORAGE_KEY, String(this.soundEnabled));
    } catch {
      // Storage unavailable — the in-memory value still applies.
    }
    this.listeners.forEach((l) => l());
    return this.soundEnabled;
  }

  public isEnabled = (): boolean => {
    this.hydrate();
    return this.soundEnabled;
  };

  /** Server snapshot: matches the default so hydration stays consistent. */
  public isEnabledServer = (): boolean => true;

  /**
   * A customer message: a loud, bright "ding-dong" played twice, so it is
   * heard across the room and never confused with the softer chime for a
   * visitor arriving on the site.
   */
  public playIncomingMessage() {
    if (!this.soundEnabled) return;
    const ctx = this.getContext();
    if (!ctx) return;
    if (Date.now() - this.lastAlertAt < 700) return;
    this.lastAlertAt = Date.now();

    // Compressor + master gain: loud, without the harsh clipping that two
    // overlapping notes at full level would cause.
    const master = ctx.createGain();
    master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    master.connect(comp);
    comp.connect(ctx.destination);

    const now = ctx.currentTime;
    for (const offset of [0, 0.42]) {
      this.bell(ctx, master, 1046.5, now + offset, 0.7, 0.35); // C6
      this.bell(ctx, master, 1567.98, now + offset + 0.11, 0.6, 0.5); // G6
    }
  }

  /** An @mention of the agent: the message alert, it is just as urgent. */
  public playMention() {
    this.playIncomingMessage();
  }

  // Soft click/pop sound when agent sends a message
  public playSentMessage() {
    if (!this.soundEnabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.08);
    
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  // Attention triple chime for a new visitor starting a conversation
  public playNewConversation() {
    if (!this.soundEnabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, idx) => {
      const startTime = now + idx * 0.07;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.35);
    });
  }
}

export const sound = new SoundManager();
