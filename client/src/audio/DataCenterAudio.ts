/**
 * 数据中心音效配置 —— §六
 * 真实项目接入 Howler.js 或 WebAudio；本模块仅负责集中声明与事件路由。
 */
import { EventBus } from '../core/EventBus';

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
    menuBgm: '/audio/music/menu.ogg',
    level1_tension: '/audio/music/level1_tension.ogg',
    level3_urgent: '/audio/music/level3_urgent.ogg',
    cutover_climax: '/audio/music/cutover_climax.ogg',
    victory: '/audio/music/victory.ogg',
    failure: '/audio/music/failure.ogg',
  },
};

/**
 * 极简播放器：把 EventBus 事件映射为音效请求。
 * 真实实现应在 ctor 中 `new Howl()` 预加载。
 */
export class DataCenterAudio {
  private zone: string = 'COMMAND_POST';

  constructor(private config: AudioConfig = DEFAULT_AUDIO_CONFIG) {
    EventBus.on('player:zoneChange', ({ zone }: { zone: string }) => {
      this.zone = zone;
      EventBus.emit('audio:ambient', { zone });
    });
    EventBus.on('audio:play', ({ sfx }: { sfx: keyof AudioConfig['interactionSounds'] }) => {
      const file = this.config.interactionSounds[sfx];
      if (file) console.debug(`[Audio] play sfx`, sfx, file);
    });
    EventBus.on('audio:play_success_fanfare', () => {
      console.debug('[Audio] play music', this.config.musicTracks.victory);
    });
  }

  getConfig(): AudioConfig {
    return this.config;
  }

  currentZone(): string {
    return this.zone;
  }
}
