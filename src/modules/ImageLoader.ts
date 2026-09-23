/**
 * Carga y procesamiento de imágenes para el escalado al estilo CorelDRAW.
 */

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Dimensiones de la imagen una vez aplicada (o no) la rotación de 90°. */
export function rotatedSize(img: HTMLImageElement, rotated: boolean): { w: number; h: number } {
  return rotated ? { w: img.naturalHeight, h: img.naturalWidth } : { w: img.naturalWidth, h: img.naturalHeight };
}

/**
 * Dibuja la imagen (rotada 90° en sentido horario si `rotated`) sobre el
 * contexto, en coordenadas de la imagen rotada. El llamador puede aplicar
 * antes una escala/traslación al contexto (p. ej. para recortar o reducir).
 */
export function drawSource(ctx: CanvasRenderingContext2D, img: HTMLImageElement, rotated: boolean): void {
  ctx.save();
  if (rotated) {
    ctx.translate(img.naturalHeight, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * Crea un canvas "de trabajo" con la imagen (rotada si aplica) reducida a
 * un máximo de `maxSidePx` en su lado mayor. Devuelve el canvas y el factor
 * de escala respecto a la imagen original (workPx = originalPx * scale).
 */
export function createWorkCanvas(img: HTMLImageElement, rotated: boolean, maxSidePx = 2400): { canvas: HTMLCanvasElement; scale: number } {
  const { w, h } = rotatedSize(img, rotated);
  const scale = Math.min(1, maxSidePx / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  drawSource(ctx, img, rotated);
  return { canvas, scale };
}

/**
 * Recorta una región (en coordenadas de la imagen rotada, a resolución
 * ORIGINAL) y la devuelve en un canvas nuevo, limitado a `maxSidePx`.
 * Si `whitenBackground` es true, los píxeles claros se vuelven blanco puro
 * (elimina el gris del escáner: imprime más limpio y pesa menos).
 */
export function createCropCanvas(
  img: HTMLImageElement,
  rotated: boolean,
  cropOriginalPx: PxRect,
  maxSidePx = 3600,
  whitenBackground = true,
  whiteThreshold = 205,
): HTMLCanvasElement {
  const k = Math.min(1, maxSidePx / Math.max(cropOriginalPx.w, cropOriginalPx.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cropOriginalPx.w * k));
  canvas.height = Math.max(1, Math.round(cropOriginalPx.h * k));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(k, k);
  ctx.translate(-cropOriginalPx.x, -cropOriginalPx.y);
  drawSource(ctx, img, rotated);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (whitenBackground) {
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (g >= whiteThreshold) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
      else {
        // Estira ligeramente el contraste de la tinta para que imprima nítida.
        const f = g / whiteThreshold; // 0..1
        const v = Math.round(255 * Math.pow(f, 1.6));
        d[i] = Math.min(d[i], v); d[i + 1] = Math.min(d[i + 1], v); d[i + 2] = Math.min(d[i + 2], v);
      }
      d[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }
  return canvas;
}

/** Umbral de Otsu sobre un histograma de 256 niveles. */
export function otsuThreshold(hist: Uint32Array | number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

export interface BBoxDetectionInfo {
  bbox: PxRect | null;
  threshold: number;
  /** Bandas de borde descartadas (px) por parecer sombra/borde del escáner. */
  trimmed: { left: number; top: number; right: number; bottom: number };
}

/**
 * Detecta el Bounding Box de la TINTA del dibujo (equivalente a seleccionar
 * "el grupo entero" en Corel), de forma robusta frente a:
 *   - bordes/sombras negras del escáner (bandas oscuras pegadas al borde),
 *   - polvo y ruido aislado,
 *   - fondo gris no uniforme.
 *
 * Estrategia:
 *   1. Umbral automático (Otsu, acotado) sobre escala de grises.
 *   2. Se ignora una franja exterior de `borderIgnorePx` y además se recortan
 *      filas/columnas pegadas al borde que estén mayoritariamente oscuras.
 *   3. Se cuenta la tinta por bloques de `blockPx` píxeles; un bloque cuenta
 *      como dibujo sólo si tiene suficiente tinta Y algún vecino con tinta
 *      (elimina motas aisladas).
 *   4. El bbox es la unión de esos bloques, con un pequeño margen.
 */
export function detectarBoundingBoxTinta(
  imgData: ImageData,
  opts: { borderIgnorePx?: number; blockPx?: number; padPx?: number } = {},
): BBoxDetectionInfo {
  const w = imgData.width, h = imgData.height;
  const d = imgData.data;
  const borderIgnore = opts.borderIgnorePx ?? Math.round(Math.max(w, h) * 0.012);
  const blockPx = opts.blockPx ?? 8;
  const padPx = opts.padPx ?? Math.round(Math.max(w, h) * 0.004);

  // 1. Gris + histograma -> Otsu
  const gray = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const g = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0;
    gray[i] = g;
    hist[g]++;
  }
  // Nivel del papel = valor de gris más frecuente. En un plano (casi todo
  // papel con pocas líneas) es más fiable umbralizar RELATIVO al papel que
  // usar Otsu a secas: todo lo que sea claramente más oscuro que el papel
  // (lápiz, tinta) cuenta como dibujo; la textura del papel no.
  let paperLevel = 0, paperCount = -1;
  for (let g = 0; g < 256; g++) if (hist[g] > paperCount) { paperCount = hist[g]; paperLevel = g; }
  let threshold = paperLevel >= 150
    ? paperLevel - 55
    : otsuThreshold(hist, w * h); // fondo oscuro/raro: caemos a Otsu
  threshold = Math.min(190, Math.max(90, threshold));

  // 2. Recorte de bordes oscuros (sombra de la tapa del escáner, borde negro,
  //    línea del cristal). Una fila/columna "de borde" es la que está oscura en
  //    más de la mitad de su longitud: ninguna línea del molde es tan larga y
  //    recta. Buscamos la fila/columna de borde MÁS INTERIOR dentro de la
  //    franja exterior (hasta un 15% por lado) y descartamos todo lo que quede
  //    afuera, más una pequeña guarda para el halo/ringing del JPEG.
  let left = borderIgnore, top = borderIgnore, right = w - 1 - borderIgnore, bottom = h - 1 - borderIgnore;
  const guard = Math.max(3, Math.round(Math.max(w, h) * 0.003));
  const limit = Math.floor(Math.min(w, h) * 0.15);
  const rowDarkFrac = (y: number) => { let c = 0; for (let x = left; x <= right; x++) if (gray[y * w + x] < threshold) c++; return c / Math.max(1, right - left + 1); };
  const colDarkFrac = (x: number) => { let c = 0; for (let y = top; y <= bottom; y++) if (gray[y * w + x] < threshold) c++; return c / Math.max(1, bottom - top + 1); };
  const trimmed = { left: 0, top: 0, right: 0, bottom: 0 };
  const innermost = (from: number, step: number, frac: (i: number) => number): number => {
    let last = -1;
    for (let k = 0; k < limit; k++) {
      const i = from + k * step;
      if (frac(i) > 0.5) last = k;
    }
    return last; // -1 si no hay borde
  };
  let k = innermost(top, 1, rowDarkFrac);
  if (k >= 0) { trimmed.top = k + 1 + guard; top += trimmed.top; }
  k = innermost(bottom, -1, rowDarkFrac);
  if (k >= 0) { trimmed.bottom = k + 1 + guard; bottom -= trimmed.bottom; }
  k = innermost(left, 1, colDarkFrac);
  if (k >= 0) { trimmed.left = k + 1 + guard; left += trimmed.left; }
  k = innermost(right, -1, colDarkFrac);
  if (k >= 0) { trimmed.right = k + 1 + guard; right -= trimmed.right; }
  if (right - left < 10 || bottom - top < 10) return { bbox: null, threshold, trimmed };

  // 3. Densidad de tinta por bloques
  const bw = Math.ceil((right - left + 1) / blockPx);
  const bh = Math.ceil((bottom - top + 1) / blockPx);
  if (bw <= 0 || bh <= 0) return { bbox: null, threshold, trimmed };
  const counts = new Uint16Array(bw * bh);
  for (let y = top; y <= bottom; y++) {
    const by = ((y - top) / blockPx) | 0;
    for (let x = left; x <= right; x++) {
      if (gray[y * w + x] < threshold) counts[by * bw + (((x - left) / blockPx) | 0)]++;
    }
  }
  const minInk = Math.max(3, Math.round(blockPx * 0.5)); // una línea fina que cruce el bloque
  const ink = new Uint8Array(bw * bh);
  for (let i = 0; i < ink.length; i++) ink[i] = counts[i] >= minInk ? 1 : 0;

  // Componentes conexas de bloques con tinta: descartamos motas de polvo
  // (componentes con muy pocos bloques / muy poca tinta). Una marca legítima
  // del molde (agujero, muesca) de >= 1.5 mm supera de sobra estos mínimos.
  const minBlocks = 3;
  const minInkPixels = 30;
  const keep = new Uint8Array(bw * bh);
  const labelSeen = new Uint8Array(bw * bh);
  const queue: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || labelSeen[start]) continue;
    queue.length = 0;
    queue.push(start);
    labelSeen[start] = 1;
    const members: number[] = [];
    let inkPixels = 0;
    while (queue.length) {
      const i = queue.pop()!;
      members.push(i);
      inkPixels += counts[i];
      const bx = i % bw, by = (i - bx) / bw;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = bx + dx, ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const j = ny * bw + nx;
        if (ink[j] && !labelSeen[j]) { labelSeen[j] = 1; queue.push(j); }
      }
    }
    if (members.length >= minBlocks && inkPixels >= minInkPixels) for (const i of members) keep[i] = 1;
  }

  let minBX = bw, minBY = bh, maxBX = -1, maxBY = -1;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!keep[by * bw + bx]) continue;
      if (bx < minBX) minBX = bx;
      if (by < minBY) minBY = by;
      if (bx > maxBX) maxBX = bx;
      if (by > maxBY) maxBY = by;
    }
  }
  if (maxBX < 0) return { bbox: null, threshold, trimmed };

  // 4. Afinar a píxel dentro de los bloques conservados
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const px0 = left + minBX * blockPx, px1 = Math.min(right, left + (maxBX + 1) * blockPx - 1);
  const py0 = top + minBY * blockPx, py1 = Math.min(bottom, top + (maxBY + 1) * blockPx - 1);
  for (let y = py0; y <= py1; y++) {
    const by = ((y - top) / blockPx) | 0;
    for (let x = px0; x <= px1; x++) {
      const bx = ((x - left) / blockPx) | 0;
      if (!keep[by * bw + bx]) continue;
      if (gray[y * w + x] < threshold) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { bbox: null, threshold, trimmed };

  const x = Math.max(0, minX - padPx);
  const y = Math.max(0, minY - padPx);
  const bboxW = Math.min(w - x, maxX - minX + 1 + padPx * 2);
  const bboxH = Math.min(h - y, maxY - minY + 1 + padPx * 2);
  return { bbox: { x, y, w: bboxW, h: bboxH }, threshold, trimmed };
}
