/**
 * Network-ready snapshot of a player. M1 only produces it locally; in M2 the
 * client will send this to the WebSocket server and render remote players
 * (with Avatar) from the same shape.
 */
export interface AvatarState {
  id: string;
  nickname: string;
  x: number;
  y: number;
  z: number;
  /** Facing angle in radians (0 = +z). */
  yaw: number;
  /** Horizontal speed in m/s, drives the walk animation. */
  speed: number;
}
