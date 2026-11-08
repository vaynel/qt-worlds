/**
 * Worship playlist (GIFTED), played in this order and looped by the single
 * persistent worship player. Official IFrame embed on youtube-nocookie.com,
 * always visible at >= 200x200 CSS px. Unplayable videos are skipped.
 *
 * IDs are used only as data (IFrame API videoId / encoded URL), never parsed
 * as options, so IDs starting with "--" are fine.
 */
export interface WorshipVideo {
  id: string;
  title?: string;
  channel?: string;
}

export const WORSHIP_VIDEOS: WorshipVideo[] = [
  { id: 'zNfnWXIK-AE', title: '나는 보기 원하네 (한밤의 프레이즈 X GIFTED)', channel: 'GIFTED' },
  { id: '--lX6TwDFhs', title: '주와 같이 길가는 것 (MV)', channel: 'GIFTED' },
  { id: 'sEqndjElNIQ', title: '내 갈급함 / 전심으로 (Room Live Worship)', channel: 'GIFTED' },
  { id: 'Te9Ha-aJi-E', title: '말씀하시면 (Room Live Worship)', channel: 'GIFTED' },
  { id: 'K5dhCef_04s', title: '어떤 모습입니까 (Band Live Clip)', channel: 'GIFTED' },
  { id: 'IPZpHi4X-0w', title: '나의 만족과 유익을 위해 (Room Live Worship)', channel: 'GIFTED' },
];

/**
 * Optional: a YouTube / YouTube Music playlist URL for "🎧 YouTube에서 듣기".
 * When empty, the link opens the current song on music.youtube.com.
 */
export const WORSHIP_PLAYLIST_URL = '';
