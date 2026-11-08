/**
 * World layout and tuning constants. Landmarks are authored (fixed positions);
 * everything between them is procedural from the seed.
 */

import { CAMPFIRE, LANTERN_HILL, PRAYER_GARDEN } from '../../../shared/protocol';

export const DEFAULT_SEED = 'worlds-v1';

/** Chunk edge length in world units (metres) and grid cells per edge. */
export const CHUNK_SIZE = 32;
export const CHUNK_CELLS = 16;
export const CELL_SIZE = CHUNK_SIZE / CHUNK_CELLS;
/** Chunks kept loaded around the player (radius, in chunks). */
export const VIEW_RADIUS = 3;

export const WATER_LEVEL = 0;
/** Deepest water the player may wade into before being blocked. */
export const MAX_WADE_DEPTH = 0.35;

export type LandmarkId = 'plaza' | 'prayerGarden' | 'campfire' | 'lanternHill' | 'closet';

export interface LandmarkDef {
  id: LandmarkId;
  name: string;
  /** Short line shown when the player is nearby. */
  blurb: string;
  x: number;
  z: number;
  /** Fully flattened radius. */
  radius: number;
  /** Blend distance from the flat area back to natural terrain. */
  falloff: number;
  /** Target ground height of the flat area. */
  height: number;
}

export const LANDMARKS: readonly LandmarkDef[] = [
  {
    id: 'plaza',
    name: '중앙 광장',
    blurb: '오늘의 말씀이 내려앉는 곳이에요.',
    x: 0,
    z: 0,
    radius: 14,
    falloff: 14,
    height: 2.5,
  },
  {
    id: 'prayerGarden',
    name: '기도의 뜰',
    blurb: '자리를 펴고 조용히 함께 기도하는 열린 뜰이에요.',
    x: PRAYER_GARDEN.x,
    z: PRAYER_GARDEN.z,
    radius: 13,
    falloff: 12,
    height: 3,
  },
  {
    id: 'campfire',
    name: '모닥불 모임터',
    blurb: '모닥불 곁에 모이면 가까운 사람과 이야기할 수 있어요.',
    x: CAMPFIRE.x,
    z: CAMPFIRE.z,
    radius: 10,
    falloff: 12,
    height: 2.8,
  },
  {
    id: 'lanternHill',
    name: '등불 언덕',
    blurb: '묵상을 등불로 밝혀 두는 언덕이에요. 등불 가까이 가서 읽어 보세요.',
    x: LANTERN_HILL.x,
    z: LANTERN_HILL.z,
    radius: 8,
    falloff: 30,
    height: 10,
  },
  {
    id: 'closet',
    name: '골방',
    blurb: '나만 들어가는 기도의 방 입구예요. 곧 문이 열려요.',
    x: -40,
    z: 52,
    radius: 8,
    falloff: 12,
    height: 3.5,
  },
];

export const PLAZA = LANDMARKS[0];

/**
 * Where a fresh player appears: just south of the plaza centre, facing north,
 * so the lantern hill sits on the horizon straight ahead with the prayer
 * garden and campfire to either side. The private room is tucked away behind.
 */
export const SPAWN = { x: 0, z: 8, yaw: 0 };

export const PALETTE = {
  sand: 0xe6d3a3,
  sandWet: 0xbfae84,
  grassLight: 0xa9c47a,
  grassMid: 0x8fb36a,
  grassDeep: 0x6f9a58,
  slope: 0x9c8f68,
  path: 0xd8bf8e,
  rock: 0xa49c8e,
  underwater: 0x7d9a86,
  water: 0x6fb0b8,
  trunk: 0x8a5a3b,
  pine: 0x4f7f5a,
  leaf: 0x7fa65a,
  leafWarm: 0xc9a85a,
  stone: 0xe8dcc4,
  stoneDark: 0xc9b99a,
  wood: 0xa8744c,
  woodDark: 0x7b5236,
  cream: 0xf4ead5,
  terracotta: 0xc8644a,
  lantern: 0xffc46b,
} as const;
