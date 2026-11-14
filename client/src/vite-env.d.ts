/// <reference types="vite/client" />

interface WorldsDebug {
  ready: boolean;
  frame: number;
  seed: string;
  terrainChecksum: number;
  chunks: number;
  player: { x: number; y: number; z: number };
  location: string;
  timeOfDay: { hours: number; phase: string; sun: number };
  renderer: { calls: number; triangles: number; pixelRatio: number; sheetCovers: boolean };
  net: {
    status: string;
    id: string;
    name: string;
    remotes: { id: string; name: string; x: number; z: number; seat: number; visible: boolean; inside: boolean }[];
    mats: (string | null)[];
    seat: number;
    nearCampfire: boolean;
    chatVisible: boolean;
    chatLog: string[];
  };
  m3: Record<string, unknown>;
  m4: Record<string, unknown>;
  m8: Record<string, unknown>;
  m9: Record<string, unknown>;
  wx: Record<string, unknown>;
  m10: Record<string, unknown>;
  la: Record<string, unknown>;
}

interface Window {
  __WORLDS_DEBUG__?: WorldsDebug;
}
declare const __BUILD_TAG__: string;
