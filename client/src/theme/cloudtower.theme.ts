/**
 * CloudTower 暗色风格主题 —— 对应主架构文档 §八。
 */
export const CLOUDTOWER_THEME = {
  colors: {
    bg: {
      primary: '#0A0E1A',
      secondary: '#111827',
      panel: '#1A2035',
      panelBorder: '#1E3A5F',
    },
    accent: {
      primary: '#00B4FF',
      success: '#00E676',
      warning: '#FFB300',
      error: '#FF1744',
      vmware: '#717171',
      smartx: '#00B4FF',
    },
    text: {
      primary: '#E8EFF7',
      secondary: '#7A9CC0',
      muted: '#3D5A80',
      code: '#00E676',
    },
    heatmap: {
      cold: '#0040FF',
      normal: '#00CC44',
      warm: '#FF9900',
      hot: '#FF1100',
    },
  },
  typography: {
    fontMono: '"JetBrains Mono", "Fira Code", monospace',
    fontDisplay: '"Rajdhani", "Orbitron", sans-serif',
    fontBody: '"Inter", "Noto Sans SC", sans-serif',
  },
  progressBar: {
    height: '4px',
    borderRadius: '2px',
    background: '#1E3A5F',
    fill: 'linear-gradient(90deg, #0066CC, #00B4FF)',
    shimmer: true,
  },
  statusDots: {
    idle: '#3D5A80',
    scanning: '#00B4FF',
    migrating: '#FFB300',
    completed: '#00E676',
    failed: '#FF1744',
  },
} as const;

export type CloudTowerTheme = typeof CLOUDTOWER_THEME;
