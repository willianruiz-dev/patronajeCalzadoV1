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

// ---------------------------------------------------------------------------
// Detección automática de los números de talla escritos en el molde
// ---------------------------------------------------------------------------

export interface NumberCandidate extends PxRect {
  /** 0 = texto horizontal; 90 = texto girado (se lee de abajo hacia arriba). */
  angle: 0 | 90;
}

interface Component {
  x: number; y: number; w: number; h: number; area: number;
}

/**
 * Busca, dentro del recuadro del molde, grupos de DOS trazos pequeños del
 * tamaño de un dígito, alineados y pegados entre sí: eso es una talla ("36").
 * Devuelve las regiones (en px de `imgData`) para borrarlas y re-enumerarlas.
 *
 * Heurísticas (sin OCR):
 *   - Un dígito mide entre 2.5 y 25 mm y es un trazo (no un relleno sólido).
 *   - Dos dígitos de una talla tienen alturas parecidas, se solapan en su eje
 *     y la separación entre ellos es menor que un dígito.
 *   - Si hay un tercer trazo similar a continuación es una palabra
 *     ("TALON", "PUNTA"), no una talla: se descarta.
 *   - También se aceptan trazos únicos con proporción de dos dígitos unidos.
 */
export function detectarNumerosEscritos(imgData: ImageData, crop: PxRect, mmPerPx: number): NumberCandidate[] {
  const W = imgData.width, d = imgData.data;
  const x0 = Math.max(0, Math.floor(crop.x)), y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(W, Math.ceil(crop.x + crop.w)), y1 = Math.min(imgData.height, Math.ceil(crop.y + crop.h));
  const cw = x1 - x0, ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return [];

  // Gris + umbral relativo al papel (igual criterio que el recuadro)
  const gray = new Uint8Array(cw * ch);
  const hist = new Uint32Array(256);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = ((y + y0) * W + (x + x0)) * 4;
      const g = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0;
      gray[y * cw + x] = g;
      hist[g]++;
    }
  }
  let paper = 0, pc = -1;
  for (let g = 0; g < 256; g++) if (hist[g] > pc) { pc = hist[g]; paper = g; }
  const threshold = Math.min(190, Math.max(90, paper >= 150 ? paper - 55 : otsuThreshold(hist, cw * ch)));

  const minDigit = 2.5 / mmPerPx;
  const maxDigit = 25 / mmPerPx;

  // Componentes conexas (8 vecinos)
  const visited = new Uint8Array(cw * ch);
  const stack = new Int32Array(cw * ch);
  const comps: Component[] = [];
  for (let start = 0; start < gray.length; start++) {
    if (visited[start] || gray[start] >= threshold) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = cw, minY = ch, maxX = -1, maxY = -1, area = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % cw, y = (i - x) / cw;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= ch) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= cw || (!dx && !dy)) continue;
          const j = ny * cw + nx;
          if (!visited[j] && gray[j] < threshold) { visited[j] = 1; stack[sp++] = j; }
        }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const big = Math.max(bw, bh), small = Math.min(bw, bh);
    if (big < minDigit || big > maxDigit * 2.2) continue;   // ni polvo ni contornos
    if (small < minDigit * 0.3) continue;                    // rayitas
    const fill = area / (bw * bh);
    if (fill < 0.06 || fill > 0.7) continue;                 // ni ruido ni manchas sólidas
    comps.push({ x: minX, y: minY, w: bw, h: bh, area });
  }

  const digitLike = comps.filter(c => Math.max(c.w, c.h) <= maxDigit);
  const used = new Set<Component>();
  const candidates: NumberCandidate[] = [];

  const similar = (a: number, b: number) => { const r = a / b; return r > 0.6 && r < 1.66; };
  const overlap1D = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

  // Vecino "siguiente" en la dirección de lectura
  const nextRight = (a: Component, pool: Component[]) => {
    let best: Component | null = null, bestGap = Infinity;
    for (const b of pool) {
      if (b === a || !similar(a.h, b.h)) continue;
      if (overlap1D(a.y, a.y + a.h, b.y, b.y + b.h) < 0.5 * Math.min(a.h, b.h)) continue;
      const gap = b.x - (a.x + a.w);
      const hm = Math.max(a.h, b.h);
      if (gap < -0.15 * hm || gap > 0.9 * hm) continue;
      if (gap < bestGap) { bestGap = gap; best = b; }
    }
    return best;
  };
  const nextUp = (a: Component, pool: Component[]) => { // texto girado 90°: el segundo dígito está ARRIBA del primero
    let best: Component | null = null, bestGap = Infinity;
    for (const b of pool) {
      if (b === a || !similar(a.w, b.w)) continue;
      if (overlap1D(a.x, a.x + a.w, b.x, b.x + b.w) < 0.5 * Math.min(a.w, b.w)) continue;
      const gap = a.y - (b.y + b.h);
      const wm = Math.max(a.w, b.w);
      if (gap < -0.15 * wm || gap > 0.9 * wm) continue;
      if (gap < bestGap) { bestGap = gap; best = b; }
    }
    return best;
  };
  const prevOf = (a: Component, pool: Component[], next: (c: Component, p: Component[]) => Component | null) =>
    pool.find(c => c !== a && next(c, pool) === a) || null;

  for (const dir of ['h', 'v'] as const) {
    const next = dir === 'h' ? nextRight : nextUp;
    for (const a of digitLike) {
      if (used.has(a)) continue;
      const b = next(a, digitLike);
      if (!b || used.has(b)) continue;
      // Debe ser exactamente un par: ni un tercero después ni uno antes.
      const c = next(b, digitLike);
      if (c && !used.has(c)) continue;
      if (prevOf(a, digitLike, next)) continue;
      used.add(a); used.add(b);
      const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y);
      const maxX = Math.max(a.x + a.w, b.x + b.w), maxY = Math.max(a.y + a.h, b.y + b.h);
      const pad = Math.round(0.12 * Math.max(maxX - minX, maxY - minY));
      candidates.push({ x: x0 + minX - pad, y: y0 + minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad, angle: dir === 'h' ? 0 : 90 });
    }
  }

  // Trazos únicos con forma de "dos dígitos unidos" (p. ej. un "36" escrito a
  // mano sin levantar el lápiz). Debe estar AISLADO: las letras de una palabra
  // también tienen esa forma pero siempre tienen vecinas cerca.
  const isolated = (c: Component) => {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2, reach = 1.5 * Math.max(c.w, c.h);
    return !comps.some(o => o !== c && Math.abs(o.x + o.w / 2 - cx) < reach && Math.abs(o.y + o.h / 2 - cy) < reach);
  };
  for (const c of comps) {
    if (used.has(c)) continue;
    const r = c.w / c.h;
    let angle: 0 | 90 | null = null;
    if (r >= 1.15 && r <= 2.2 && c.h <= maxDigit) angle = 0;
    else if (r <= 1 / 1.15 && r >= 1 / 2.2 && c.w <= maxDigit) angle = 90;
    if (angle === null) continue;
    const fill = c.area / (c.w * c.h);
    if (fill > 0.45 || fill < 0.12) continue;
    if (!isolated(c)) continue;
    const pad = Math.round(0.12 * Math.max(c.w, c.h));
    candidates.push({ x: x0 + c.x - pad, y: y0 + c.y - pad, w: c.w + 2 * pad, h: c.h + 2 * pad, angle });
  }

  // De mayor a menor tamaño, máximo 12
  candidates.sort((p, q) => q.w * q.h - p.w * p.h);
  return candidates.slice(0, 12).map(c => ({
    x: Math.max(0, c.x), y: Math.max(0, c.y),
    w: Math.min(W - Math.max(0, c.x), c.w), h: Math.min(imgData.height - Math.max(0, c.y), c.h),
    angle: c.angle,
  }));
}
