"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";

const MIN_CROP_PX = 64;
const MAX_BYTES = 15 * 1024 * 1024;
const HANDLES = ["n", "e", "s", "w", "nw", "ne", "se", "sw"] as const;

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CropSelection = {
  rect: CropRect;
  imageWidth: number;
  imageHeight: number;
};

type CropHandle = (typeof HANDLES)[number] | "move";

type ImageSize = {
  width: number;
  height: number;
};

type CropMetrics = {
  left: number;
  top: number;
  offsetX: number;
  offsetY: number;
  scale: number;
};

type DragState = {
  pointerId: number;
  handle: CropHandle;
  originX: number;
  originY: number;
  start: CropRect;
  move: (event: PointerEvent) => void;
  end: (event: PointerEvent) => void;
};

export type CropFileResult =
  | { ok: true; file: File }
  | { ok: false; reason: "too-large" | "decode-failed" };

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function minimums(imageWidth: number, imageHeight: number) {
  return {
    minWidth: Math.min(MIN_CROP_PX, imageWidth),
    minHeight: Math.min(MIN_CROP_PX, imageHeight),
  };
}

function containCrop(rect: CropRect, imageWidth: number, imageHeight: number): CropRect {
  const { minWidth, minHeight } = minimums(imageWidth, imageHeight);
  const width = clamp(rect.width, minWidth, imageWidth);
  const height = clamp(rect.height, minHeight, imageHeight);
  return {
    x: clamp(rect.x, 0, imageWidth - width),
    y: clamp(rect.y, 0, imageHeight - height),
    width,
    height,
  };
}

export function resizeCrop(
  start: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  if (imageWidth < 1 || imageHeight < 1) return start;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return start;

  const { minWidth, minHeight } = minimums(imageWidth, imageHeight);

  if (handle === "move") {
    const width = clamp(start.width, minWidth, imageWidth);
    const height = clamp(start.height, minHeight, imageHeight);
    return containCrop(
      {
        x: start.x + dx,
        y: start.y + dy,
        width,
        height,
      },
      imageWidth,
      imageHeight,
    );
  }

  const east = handle === "e" || handle === "ne" || handle === "se";
  const west = handle === "w" || handle === "nw" || handle === "sw";
  const south = handle === "s" || handle === "se" || handle === "sw";
  const north = handle === "n" || handle === "ne" || handle === "nw";

  let x = start.x;
  let y = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (west) x = clamp(start.x + dx, 0, right - minWidth);
  if (east) right = clamp(right + dx, (west ? x : start.x) + minWidth, imageWidth);
  if (north) y = clamp(start.y + dy, 0, bottom - minHeight);
  if (south) bottom = clamp(bottom + dy, (north ? y : start.y) + minHeight, imageHeight);

  return containCrop(
    {
      x,
      y,
      width: right - x,
      height: bottom - y,
    },
    imageWidth,
    imageHeight,
  );
}

function pixelCrop(rect: CropRect, imageWidth: number, imageHeight: number): CropRect | null {
  if (imageWidth < 1 || imageHeight < 1) return null;
  const fitted = containCrop(
    {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    imageWidth,
    imageHeight,
  );
  if (fitted.width < 1 || fitted.height < 1) return null;
  return fitted;
}

function scaleRect(rect: CropRect, from: ImageSize, to: ImageSize): CropRect {
  return {
    x: rect.x * (to.width / from.width),
    y: rect.y * (to.height / from.height),
    width: rect.width * (to.width / from.width),
    height: rect.height * (to.height / from.height),
  };
}

function measureStage(stage: HTMLElement, imageWidth: number, imageHeight: number): CropMetrics | null {
  const bounds = stage.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1 || imageWidth < 1 || imageHeight < 1) return null;
  const scale = Math.min(bounds.width / imageWidth, bounds.height / imageHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const displayWidth = imageWidth * scale;
  const displayHeight = imageHeight * scale;
  return {
    left: bounds.left,
    top: bounds.top,
    offsetX: (bounds.width - displayWidth) / 2,
    offsetY: (bounds.height - displayHeight) / 2,
    scale,
  };
}

function pointInImage(clientX: number, clientY: number, metrics: CropMetrics) {
  return {
    x: (clientX - metrics.left - metrics.offsetX) / metrics.scale,
    y: (clientY - metrics.top - metrics.offsetY) / metrics.scale,
  };
}

function cursorFor(handle: CropHandle): string {
  switch (handle) {
    case "move":
      return "grabbing";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  if (typeof canvas.toBlob !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function usableBlob(blob: Blob | null, type: string): blob is Blob {
  if (!blob || blob.size <= 0) return false;
  return blob.type === "" || blob.type === type;
}

async function encodeCanvas(
  canvas: HTMLCanvasElement,
  mediaType: string,
): Promise<{ blob: Blob; type: string } | null> {
  if (mediaType === "image/webp") {
    const webp = await canvasToBlob(canvas, "image/webp", 0.92);
    if (usableBlob(webp, "image/webp")) return { blob: webp, type: "image/webp" };
    const png = await canvasToBlob(canvas, "image/png");
    if (usableBlob(png, "image/png")) return { blob: png, type: "image/png" };
    return null;
  }

  const blob = await canvasToBlob(canvas, mediaType, mediaType === "image/jpeg" ? 0.92 : undefined);
  if (!usableBlob(blob, mediaType)) return null;
  return { blob, type: mediaType };
}

function fileNameFor(originalName: string, mime: string): string {
  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const trimmed = originalName.trim();
  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base.length > 0 ? base : "image"}.${extension}`;
}

async function decodeBitmap(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      return null;
    }
  }
}

export async function cropImageFile(
  file: File,
  mediaType: string,
  rect: CropRect,
  view: ImageSize,
): Promise<CropFileResult> {
  if (view.width < 1 || view.height < 1 || typeof document === "undefined") {
    return { ok: false, reason: "decode-failed" };
  }

  const bitmap = await decodeBitmap(file);
  if (!bitmap) return { ok: false, reason: "decode-failed" };

  try {
    if (bitmap.width < 1 || bitmap.height < 1) return { ok: false, reason: "decode-failed" };
    const pixels = pixelCrop(scaleRect(rect, view, { width: bitmap.width, height: bitmap.height }), bitmap.width, bitmap.height);
    if (!pixels) return { ok: false, reason: "decode-failed" };

    if (pixels.x === 0 && pixels.y === 0 && pixels.width === bitmap.width && pixels.height === bitmap.height) {
      return { ok: true, file };
    }

    const canvas = document.createElement("canvas");
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      return { ok: false, reason: "decode-failed" };
    }

    const context = canvas.getContext("2d");
    if (!context) return { ok: false, reason: "decode-failed" };
    if (mediaType === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixels.width, pixels.height);
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height);

    const encoded = await encodeCanvas(canvas, mediaType);
    if (!encoded) return { ok: false, reason: "decode-failed" };
    if (encoded.type !== "image/jpeg" && encoded.type !== "image/png" && encoded.type !== "image/webp") {
      return { ok: false, reason: "decode-failed" };
    }
    if (encoded.blob.size > MAX_BYTES) return { ok: false, reason: "too-large" };

    const next = new File([encoded.blob], fileNameFor(file.name, encoded.type), {
      type: encoded.type,
      lastModified: Date.now(),
    });
    if (next.size > MAX_BYTES) return { ok: false, reason: "too-large" };
    if (next.type !== "image/jpeg" && next.type !== "image/png" && next.type !== "image/webp") {
      return { ok: false, reason: "decode-failed" };
    }
    return { ok: true, file: next };
  } catch {
    return { ok: false, reason: "decode-failed" };
  } finally {
    bitmap.close();
  }
}

export default function CropFrame({
  src,
  disabled = false,
  onSelection,
}: {
  src: string;
  disabled?: boolean;
  onSelection: (selection: CropSelection) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const imageSizeRef = useRef<ImageSize | null>(null);
  const rectRef = useRef<CropRect | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const mountedRef = useRef(true);
  const loadedSrcRef = useRef<string | null>(null);
  const onSelectionRef = useRef(onSelection);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [metrics, setMetrics] = useState<CropMetrics | null>(null);
  const [dragHandle, setDragHandle] = useState<CropHandle | null>(null);

  onSelectionRef.current = onSelection;

  const publishImage = (image: HTMLImageElement, stage: HTMLElement | null) => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width < 1 || height < 1) return;

    if (loadedSrcRef.current !== src) {
      loadedSrcRef.current = src;
      const full = { x: 0, y: 0, width, height };
      const size = { width, height };
      imageSizeRef.current = size;
      rectRef.current = full;
      setRect(full);
      onSelectionRef.current({ rect: full, imageWidth: width, imageHeight: height });
    }

    const size = imageSizeRef.current;
    if (!stage || !size) return;
    const next = measureStage(stage, size.width, size.height);
    if (next) setMetrics(next);
  };

  useLayoutEffect(() => {
    const image = imageRef.current;
    const stage = stageRef.current;
    if (!image || !stage) return;

    const sync = () => {
      if (image.complete) publishImage(image, stage);
      else if (imageSizeRef.current) {
        const next = measureStage(stage, imageSizeRef.current.width, imageSizeRef.current.height);
        if (next) setMetrics(next);
      }
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const drag = dragRef.current;
      if (!drag) return;
      window.removeEventListener("pointermove", drag.move);
      window.removeEventListener("pointerup", drag.end);
      window.removeEventListener("pointercancel", drag.end);
      dragRef.current = null;
      document.body.style.cursor = "";
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    const drag = dragRef.current;
    if (!drag) return;
    window.removeEventListener("pointermove", drag.move);
    window.removeEventListener("pointerup", drag.end);
    window.removeEventListener("pointercancel", drag.end);
    dragRef.current = null;
    document.body.style.cursor = "";
    setDragHandle(null);
  }, [disabled]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>, handle: CropHandle) => {
    if (disabled || event.button !== 0) return;
    const stage = stageRef.current;
    const size = imageSizeRef.current;
    const start = rectRef.current;
    if (!stage || !size || !start) return;
    const metricsNow = measureStage(stage, size.width, size.height);
    if (!metricsNow) return;

    event.preventDefault();
    event.stopPropagation();
    const origin = pointInImage(event.clientX, event.clientY, metricsNow);

    let move: (pointerEvent: PointerEvent) => void = () => {};
    let end: (pointerEvent: PointerEvent) => void = () => {};

    move = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || pointerEvent.pointerId !== drag.pointerId || !mountedRef.current) return;
      const liveSize = imageSizeRef.current;
      const liveStage = stageRef.current;
      if (!liveSize || !liveStage) return;
      const liveMetrics = measureStage(liveStage, liveSize.width, liveSize.height);
      if (!liveMetrics) return;
      pointerEvent.preventDefault();
      const point = pointInImage(pointerEvent.clientX, pointerEvent.clientY, liveMetrics);
      const next = resizeCrop(
        drag.start,
        drag.handle,
        point.x - drag.originX,
        point.y - drag.originY,
        liveSize.width,
        liveSize.height,
      );
      rectRef.current = next;
      setRect(next);
      setMetrics(liveMetrics);
      onSelectionRef.current({
        rect: next,
        imageWidth: liveSize.width,
        imageHeight: liveSize.height,
      });
    };

    end = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      dragRef.current = null;
      document.body.style.cursor = "";
      if (mountedRef.current) setDragHandle(null);
    };

    dragRef.current = {
      pointerId: event.pointerId,
      handle,
      originX: origin.x,
      originY: origin.y,
      start: { x: start.x, y: start.y, width: start.width, height: start.height },
      move,
      end,
    };
    document.body.style.cursor = cursorFor(handle);
    setDragHandle(handle);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const rectStyle = rect && metrics
    ? {
        left: `${metrics.offsetX + rect.x * metrics.scale}px`,
        top: `${metrics.offsetY + rect.y * metrics.scale}px`,
        width: `${rect.width * metrics.scale}px`,
        height: `${rect.height * metrics.scale}px`,
      }
    : undefined;

  return (
    <div ref={stageRef} className={dragHandle ? `crop-stage is-${dragHandle}` : "crop-stage"}>
      <img
        ref={imageRef}
        src={src}
        alt="Uploaded preview"
        draggable={false}
        onLoad={(event: SyntheticEvent<HTMLImageElement>) => {
          publishImage(event.currentTarget, stageRef.current ?? event.currentTarget.parentElement);
        }}
        onDragStart={(event) => event.preventDefault()}
      />
      {rectStyle ? (
        <div
          className={dragHandle ? "crop-rect is-dragging" : "crop-rect"}
          style={rectStyle}
          aria-hidden="true"
          onPointerDown={(event) => startDrag(event, "move")}
        >
          {HANDLES.map((handle) => (
            <span
              key={handle}
              className={`crop-handle crop-handle-${handle}`}
              onPointerDown={(event) => startDrag(event, handle)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
