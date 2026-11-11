export const CANVAS_SIZE = 1024;
export const DETECTION_LONG_EDGE = 2048;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_UPSCALE = 1.5;
export const NOSE_TOLERANCE_OF_FACE_WIDTH = 0.02;
export const SOCKET_INSET_PX = 4;
export const OUTER_CORNER_MAX_PX = 2;
export const FEATHER_PX = 8;
export const ACCEPTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type PlateName =
  | "smile"
  | "curious"
  | "pain"
  | "nausea"
  | "gaze"
  | "blink";

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type SmileLandmarks = {
  leftEye: Rect;
  rightEye: Rect;
  leftEyeCenter: Point;
  rightEyeCenter: Point;
  betweenPupils: Point;
  mouthCenter: Point;
  noseBridge: Point;
  leftPupil: Point;
  rightPupil: Point;
  leftOuterCorner: Point;
  rightOuterCorner: Point;
};

export type RejectionCode =
  | "unsupported-type"
  | "too-large"
  | "decode-failed"
  | "no-face"
  | "multiple-faces"
  | "eyes-not-visible"
  | "upscale-too-large"
  | "alignment-failed"
  | "nose-moved"
  | "pupil-outside-socket"
  | "outer-corner-moved"
  | "outside-mask"
  | "halo";

export type LockerRejection = {
  code: RejectionCode;
  message: string;
};
