/** Map a pointer through object-fit: contain. Ignore the letterbox outside the image. */
export function viewportPoint(rect, frame, clientX, clientY) {
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const left = rect.left + (rect.width - frame.width * scale) / 2;
  const top = rect.top + (rect.height - frame.height * scale) / 2;
  const x = (clientX - left) / scale,
    y = (clientY - top) / scale;
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height
    ? { x, y }
    : null;
}
