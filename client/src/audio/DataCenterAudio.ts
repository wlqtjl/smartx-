/**
 * 数据中心音效系统 —— §六。
 * 接入 Howler.js：
 *  - 环境 hum 背景音（随 `player:zoneChange` 切换不同 track）
 *  - 交互 SFX（`interaction:activate`, `ui:*`, `fx:*`）
 *
 * 如果对应音频文件不存在（静态资源未部署），Howler 会触发 loaderror；
 * 我们把错误静默成 noop，避免阻塞游戏流程。
 */
import { Howl, Howler } from 'howler';
import { EventBus } from '../core/EventBus';
import type { DataCenterZone } from '../fps/PlayerController';

export interface AudioConfig {
  ambientSounds: {
    serverHum: { file: string; volume: number; loop: true };
    acUnit: { file: string; volume: number; loop: true };
    coldAisleWhoosh: { file: string; volume: number; loop: true };
  };
  interactionSounds: {
    cableInsert: string;
    keyboardClick: string;
    scanBeep: string;
    alertBeep: string;
    dataTransferHum: string;
    cutoverClick: string;
    bootupChime: string;
    vmShutdown: string;
  };
  musicTracks: {
    menuBgm: string;
    level1_tension: string;
    level3_urgent: string;
    cutover_climax: string;
    victory: string;
    failure: string;
  };
}

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  ambientSounds: {
    serverHum: { file: '/audio/ambient/server_hum.ogg', volume: 0.4, loop: true },
    acUnit: { file: '/audio/ambient/ac_unit.ogg', volume: 0.3, loop: true },
    coldAisleWhoosh: { file: '/audio/ambient/cold_aisle_whoosh.ogg', volume: 0.5, loop: true },
  },
  interactionSounds: {
    cableInsert: '/audio/sfx/cable_insert.wav',
    keyboardClick: '/audio/sfx/keyboard_click.wav',
    scanBeep: '/audio/sfx/scan_beep.wav',
    alertBeep: '/audio/sfx/alert_beep.wav',
    dataTransferHum: '/audio/sfx/data_transfer_hum.wav',
    cutoverClick: '/audio/sfx/cutover_click.wav',
    bootupChime: '/audio/sfx/bootup_chime.wav',
    vmShutdown: '/audio/sfx/vm_shutdown.wav',
  },
  musicTracks: {
    menuBgm: '/audio/music/menu_bgm.ogg',
    level1_tension: '/audio/music/level1_tension.ogg',
    level3_urgent: '/audio/music/level3_urgent.ogg',
    cutover_climax: '/audio/music/cutover_climax.ogg',
    victory: '/audio/music/victory.ogg',
    failure: '/audio/music/failure.ogg',
  },
};

const safeHowl = (opts: { src: string; volume: number; loop?: boolean }): Howl => {
  return new Howl({
    src: [opts.src],
    volume: opts.volume,
    loop: opts.loop ?? false,
    html5: true,
    onloaderror: () => {
      /* 静态资源未提供时静默降级 */
    },
    onplayerror: () => {
      /* 浏览器策略阻止自动播放时静默 */
    },
  });
};

export class DataCenterAudio {
  private ambientByZone: Partial<Record<DataCenterZone, Howl>> = {};
  private sfx: Partial<Record<keyof AudioConfig['interactionSounds'], Howl>> = {};
  private current: Howl | null = null;
  private muted = false;
  private unlockedByUser = false;
  private disposers: Array<() => void> = [];

  constructor(private readonly config: AudioConfig = DEFAULT_AUDIO_CONFIG) {
    Howler.volume(0.8);
    this.preload();
    this.wireEventBus();

    // 浏览器自动播放策略：等首次用户交互后再启动 ambient
    const unlock = (): void => {
      if (this.unlockedByUser) return;
      this.unlockedByUser = true;
      // 按当前 zone 启动 ambient；fallback 为 COMMAND_POST
      this.playAmbient('COMMAND_POST');
    };
    window.addEventListener('click', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    this.disposers.push(() => window.removeEventListener('click', unlock));
    this.disposers.push(() => window.removeEventListener('keydown', unlock));
  }

  private preload(): void {
    const amb = this.config.ambientSounds;
    // 不同房间选不同 ambient，给玩家明显的声景差
    this.ambientByZone.COMMAND_POST = safeHowl({
      src: amb.serverHum.file,
      volume: amb.serverHum.volume,
      loop: true,
    });
    this.ambientByZone.NETWORK_ROOM = safeHowl({
      src: amb.acUnit.file,
      volume: amb.acUnit.volume,
      loop: true,
    });
    this.ambientByZone.STORAGE_ROOM = safeHowl({
      src: amb.serverHum.file,
      volume: amb.serverHum.volume * 1.2,
      loop: true,
    });
    this.ambientByZone.COLD_AISLE = safeHowl({
      src: amb.coldAisleWhoosh.file,
      volume: amb.coldAisleWhoosh.volume,
      loop: true,
    });
    this.ambientByZone.HOT_AISLE = safeHowl({
      src: amb.acUnit.file,
      volume: amb.acUnit.volume,
      loop: true,
    });

    for (const [k, path] of Object.entries(this.config.interactionSounds)) {
      this.sfx[k as keyof AudioConfig['interactionSounds']] = safeHowl({
        src: path,
        volume: 0.6,
      });
    }
  }

  private wireEventBus(): void {
    const subs = [
      EventBus.on('player:zoneChange', ({ zone }: { zone: DataCenterZone }) => {
        this.playAmbient(zone);
      }),
      EventBus.on('interaction:activate', () => this.sfx.keyboardClick?.play()),
      EventBus.on('ui:open_vcenter_login', () => this.sfx.keyboardClick?.play()),
      EventBus.on('fx:rack_lights_scanning', () => this.sfx.scanBeep?.play()),
      EventBus.on('ui:show_scan_results', () => this.sfx.bootupChime?.play()),
      EventBus.on('ui:show_sync_challenge', () => this.sfx.alertBeep?.play()),
      EventBus.on('migration:cutoverStep', () => this.sfx.cutoverClick?.play()),
      EventBus.on('fx:data_cable_visual', () => this.sfx.dataTransferHum?.play()),
      EventBus.on('fx:storage_mismatch_flash', () => this.sfx.alertBeep?.play()),
    ];
    this.disposers.push(() => subs.forEach((off) => off()));
  }

  playAmbient(zone: DataCenterZone): void {
    if (!this.unlockedByUser) return;
    const next = this.ambientByZone[zone];
    if (!next) return;
    if (this.current === next) return;
    if (this.current) {
      try {
        this.current.fade(this.current.volume(), 0, 400);
        const oldRef = this.current;
        setTimeout(() => oldRef.stop(), 450);
      } catch {
        /* ignore */
      }
    }
    this.current = next;
    if (!next.playing()) next.play();
    try {
      next.fade(0, next.volume(), 400);
    } catch {
      /* ignore */
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    Howler.mute(muted);
  }

  isMuted(): boolean {
    return this.muted;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    for (const h of Object.values(this.ambientByZone)) h?.stop();
    for (const h of Object.values(this.sfx)) h?.stop();
  }
}

