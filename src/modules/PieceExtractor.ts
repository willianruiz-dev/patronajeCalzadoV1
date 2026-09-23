import { DPI, pixelsToMM } from './ScannerConfig';
import { Piece, Point } from './ProportionalScaler';

/**
 * Binariza la imagen (luminosidad) a blanco=255 / negro=0.
 */
export function binarizeImage(
  imageData: ImageData,
  threshold: number = 180
): ImageData {
  const src = imageData.data;
  const out = new ImageData(new Uint8ClampedArray(src), imageData.width, imageData.height);
  for (let i = 0; i < src.length; i += 4) {
    const gray = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    const v = gray < threshold ? 0 : 255;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

/**
 * Dilatación morfológica sencilla en 3x3 (expande píxeles negros, útil para cerrar trazos).
 * Operamos con "negro=1, blanco=0" internamente para que el close haga sentido:
 * después de close, un trazo dibujado a mano con pequeños huecos pasa a ser una pared continua.
 */
function invertToBinary(uint8: Uint8ClampedArray, w: number, h: number): Uint8Array {
  // 1 = tinta (negro), 0 = fondo blanco
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    bin[i] = uint8[i * 4] < 128 ? 1 : 0;
  }
  return bin;
}

function dilate(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        for (let dx = -radius; dx <= radius && !hit; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && bin[yy * w + xx]) hit = 1;
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

function erode(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let miss = 0;
      for (let dy = -radius; dy <= radius && !miss; dy++) {
        for (let dx = -radius; dx <= radius && !miss; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !bin[yy * w + xx]) miss = 1;
        }
      }
      out[y * w + x] = miss ? 0 : 1;
    }
  }
  return out;
}

/**
 * Cierre morfológico: dilatar N pasos y luego erosionar N pasos.
 * Cierra pequeños huecos en el trazo sin cambiar la forma de las piezas.
 */
function morphClose(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let b = bin;
  for (let i = 0; i < radius; i++) b = dilate(b, w, h, 1);
  for (let i = 0; i < radius; i++) b = erode(b, w, h, 1);
  return b;
}

/**
 * Flood-fill en la imagen binaria (0=blanco, 1=tinta) marcando los píxeles
 * alcanzables desde las 4 esquinas a través de píxeles BLANCOS (0).
 * Devuelve una máscara donde 1 = fondo (exterior alcanzable desde borde),
 * 0 = o bien tinta o bien una región encerrada (la pieza).
 */
function floodFillBackground(bin: Uint8Array, w: number, h: number): Uint8Array {
  const isBg = new Uint8Array(w * h);
  const stack: number[] = [];
  const pushIfWhite = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const idx = y * w + x;
    if (isBg[idx]) return;
    if (bin[idx] === 1) return; // tinta, pared
    isBg[idx] = 1;
    stack.push(idx);
  };
  // Las 4 esquinas
  pushIfWhite(0, 0);
  pushIfWhite(w - 1, 0);
  pushIfWhite(0, h - 1);
  pushIfWhite(w - 1, h - 1);
  // También todos los bordes del marco
  for (let x = 0; x < w; x++) { pushIfWhite(x, 0); pushIfWhite(x, h - 1); }
  for (let y = 0; y < h; y++) { pushIfWhite(0, y); pushIfWhite(w - 1, y); }

  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % w;
    const y = (idx - x) / w;
    pushIfWhite(x + 1, y);
    pushIfWhite(x - 1, y);
    pushIfWhite(x, y + 1);
    pushIfWhite(x, y - 1);
  }
  return isBg;
}

/**
 * Connected components de los píxeles INTERIORES (blancos NO alcanzables desde el borde).
 * Cada componente conectado es una PIEZA del patrón.
 */
function connectedComponents(mask: Uint8Array, w: number, h: number, bin: Uint8Array): { label: Int32Array; count: number; sizes: number[]; boxes: Array<{minX:number;minY:number;maxX:number;maxY:number}> } {
  const label = new Int32Array(w * h);
  const sizes: number[] = [0];
  const boxes: Array<{minX:number;minY:number;maxX:number;maxY:number}> = [{minX:0,minY:0,maxX:0,maxY:0}];
  let nextLabel = 1;
  const stack: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      // Interior = no tinta y no fondo
      if (bin[idx] === 0 && mask[idx] === 0 && label[idx] === 0) {
        label[idx] = nextLabel;
        stack.push(idx);
        let area = 0;
        let minX = x, minY = y, maxX = x, maxY = y;
        while (stack.length) {
          const i = stack.pop()!;
          area++;
          const cx = i % w;
          const cy = (i - cx) / w;
          if (cx < minX) minX = cx;
          if (cy < minY) minY = cy;
          if (cx > maxX) maxX = cx;
          if (cy > maxY) maxY = cy;
          const neigh = [i + 1, i - 1, i + w, i - w];
          for (const n of neigh) {
            if (n < 0 || n >= w * h) continue;
            const nx = n % w, ny = (n - nx) / w;
            // Aseguramos vecindad 4 (no saltar filas por borde)
            if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
            if (bin[n] === 0 && mask[n] === 0 && label[n] === 0) {
              label[n] = nextLabel;
              stack.push(n);
            }
          }
        }
        sizes.push(area);
        boxes.push({ minX, minY, maxX, maxY });
        nextLabel++;
      }
    }
  }
  return { label, count: nextLabel - 1, sizes, boxes };
}

/**
 * Trazado de contorno usando Moore neighborhood tracing sobre la máscara de tinta.
 * Sigue el borde de una región etiquetada con `lbl` y devuelve una lista ordenada
 * de puntos (x,y) que forman el contorno externo en sentido horario.
 */
function traceBoundary(
  x0: number, y0: number,
  label: Int32Array, bin: Uint8Array, w: number, h: number,
  targetLabel: number
): Point[] {
  const pts: Point[] = [];
  // Direcciones Moore: 0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE
  const dx = [1, 1, 0,-1,-1,-1, 0, 1];
  const dy = [0, 1, 1, 1, 0,-1,-1,-1];

  // Buscamos el pixel más a la izquierda-arriba de la pieza (punto de arranque del borde)
  // Recorremos bounding box
  let sx = x0, sy = y0;
  findStart:
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (label[idx] === targetLabel) {
        // Subir hasta encontrar la tinta (bin=1) al lado o ser borde exterior
        sx = x; sy = y;
        break findStart;
      }
    }
  }

  // El punto de inicio es el primer píxel de TINTA inmediatamente arriba de (sx,sy),
  // es decir el borde superior del componente.
  let bx = sx, by = sy;
  for (let y = sy - 1; y >= 0; y--) {
    if (bin[y * w + sx] === 1) { by = y; break; }
    if (y === 0) break;
  }

  // Algoritmo de Moore simplificado: caminar alrededor del píxel tinta,
  // manteniendo el interior de la pieza a la derecha.
  let curX = bx, curY = by;
  // Iniciar mirando hacia el sur (el interior está al norte del borde superior)
  let dir = 2;
  const startX = curX, startY = curY;
  let steps = 0;
  const maxSteps = w * h;

  // Función: dada una posición (cx,cy) y una dirección de entrada, busca la primera
  // dirección en la que el píxel es tinta, empezando por la dirección "backtrack + 1".
  const isTinta = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && bin[y * w + x] === 1;

  pts.push({ x: curX, y: curY });

  while (steps++ < maxSteps) {
    // Empezamos por (dir + 5) % 8 (dirección anterior en sentido antihorario, 90° a la izq)
    // y barremos en sentido horario hasta encontrar un píxel negro
    let found = -1;
    for (let i = 0; i < 8; i++) {
      const d = (dir + 5 + i) % 8;
      const nx = curX + dx[d];
      const ny = curY + dy[d];
      if (isTinta(nx, ny)) { found = d; curX = nx; curY = ny; dir = d; break; }
    }
    if (found === -1) break; // aislado
    pts.push({ x: curX, y: curY });
    if (curX === startX && curY === startY && pts.length > 3) break;
    // Girar para la siguiente iteración: siguiente búsqueda empieza 2 pasos atrás
    dir = (found + 6) % 8;
  }

  return pts;
}

/**
 * Simplifica un contorno eliminando puntos redundantes (Douglas-Peucker simple).
 */
function douglasPeucker(pts: Point[], epsilon: number): Point[] {
  if (pts.length <= 2) return pts.slice();
  let maxDist = 0;
  let index = 0;
  const end = pts.length - 1;
  const a = pts[0], b = pts[end];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < end; i++) {
    const p = pts[i];
    const dist = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
    if (dist > maxDist) { maxDist = dist; index = i; }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(pts.slice(0, index + 1), epsilon);
    const right = douglasPeucker(pts.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

export interface ExtractOptions {
  threshold?: number;       // umbral binarizado (0-255)
  closeRadius?: number;     // radio de cierre morfológico en píxeles
  minPieceMM?: number;      // tamaño mínimo de pieza en mm (filtra ruido)
}

/**
 * Extrae piezas del patrón.
 * Método correcto para moldes dibujados a mano con LÍNEAS (no siluetas rellenas):
 *   1. Binarizar
 *   2. Cierre morfológico para "pegar" trazos con pequeños huecos
 *   3. Flood-fill desde los bordes (fondo)
 *   4. Los componentes blancos NO alcanzables desde el borde = piezas cerradas
 *   5. Trazar el contorno de cada pieza siguiendo la tinta alrededor
 */
export function extractPieces(
  binaryData: ImageData,
  dpi: DPI,
  opts: ExtractOptions = {}
): { pieces: Piece[]; debugBinary: Uint8Array; w: number; h: number } {
  const threshold = opts.threshold ?? 180;
  const closeRadius = opts.closeRadius ?? 4;
  const minPieceMM = opts.minPieceMM ?? 10;

  const w = binaryData.width;
  const h = binaryData.height;

  // 1. Asegurar binarizado
  const binarized = binarizeImage(binaryData, threshold);
  let bin = invertToBinary(binarized.data, w, h);

  // 2. Cierre morfológico para cerrar trazos
  bin = morphClose(bin, w, h, closeRadius);

  // 3. Flood-fill del fondo
  const isBg = floodFillBackground(bin, w, h);

  // 4. Componentes interiores
  const cc = connectedComponents(isBg, w, h, bin);

  const mmPerPx = pixelsToMM(1, dpi).toNumber();
  const minAreaPx = (minPieceMM / mmPerPx) ** 2;
  const minWHPx = Math.ceil(minPieceMM / mmPerPx);

  const pieces: Piece[] = [];

  for (let lbl = 1; lbl <= cc.count; lbl++) {
    const box = cc.boxes[lbl];
    const areaPx = cc.sizes[lbl];
    const bw = box.maxX - box.minX + 1;
    const bh = box.maxY - box.minY + 1;
    if (areaPx < minAreaPx) continue;
    if (bw < minWHPx || bh < minWHPx) continue;

    // 5. Trazar contorno con Moore neighborhood (usando píxeles del label)
    const contourPx = traceBoundary(box.minX, box.minY, cc.label, bin, w, h, lbl);

    // Si el trazado no produjo suficiente puntos, construimos el contorno
    // como la caja convexa de los píxeles del interior con bordes de tinta.
    let finalContourPx: Point[];
    if (contourPx.length < 8) {
      finalContourPx = buildContourFromInterior(cc.label, bin, w, h, lbl);
    } else {
      finalContourPx = contourPx;
    }

    // Simplificar contorno
    const simplifiedPx = douglasPeucker(finalContourPx, 1.5);

    // Convertir a mm, normalizar origen
    const points: Point[] = simplifiedPx.map(p => ({
      x: (p.x - box.minX) * mmPerPx,
      y: (p.y - box.minY) * mmPerPx,
    }));

    const widthMM = bw * mmPerPx;
    const heightMM = bh * mmPerPx;
    const areaMM2 = areaPx * mmPerPx * mmPerPx;

    pieces.push({
      id: `piece_${pieces.length}`,
      points,
      widthMM,
      heightMM,
      boundingBox: { minX: 0, minY: 0, maxX: widthMM, maxY: heightMM },
      areaMM2,
    });
  }

  return { pieces, debugBinary: bin, w, h };
}

/**
 * Respaldo: si el trazado de Moore falla, tomamos todos los píxeles de tinta adyacentes
 * al interior de la pieza y ordenamos por ángulo respecto al centroide.
 */
function buildContourFromInterior(
  label: Int32Array, bin: Uint8Array, w: number, h: number, targetLabel: number
): Point[] {
  const edge: Point[] = [];
  let cx = 0, cy = 0, n = 0;
  const inLabel = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (label[idx] === targetLabel) {
        cx += x; cy += y; n++;
        inLabel.add(idx);
      }
    }
  }
  if (n === 0) return [];
  cx /= n; cy /= n;

  // Borde: píxeles de TINTA adyacentes al interior
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (bin[idx] !== 1) continue;
      const neigh = [idx + 1, idx - 1, idx + w, idx - w];
      let adjacent = false;
      for (const ni of neigh) {
        if (inLabel.has(ni)) { adjacent = true; break; }
      }
      if (adjacent) edge.push({ x, y });
    }
  }

  // Ordenar por ángulo polar alrededor del centroide
  edge.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return edge;
}

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function getImageDataFromImage(img: HTMLImageElement, maxWidthPx: number = 2000): ImageData {
  // Reducir imagen si es muy grande para rendimiento
  const scale = img.width > maxWidthPx ? maxWidthPx / img.width : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function rotateImageData90(img: HTMLImageElement, clockwise: boolean = true): ImageData {
  const src = getImageDataFromImage(img);
  const w = src.width, h = src.height;
  const canvas = document.createElement('canvas');
  canvas.width = h;
  canvas.height = w;
  const ctx = canvas.getContext('2d')!;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d')!;
  tctx.putImageData(src, 0, 0);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(clockwise ? Math.PI / 2 : -Math.PI / 2);
  ctx.drawImage(tmp, -w / 2, -h / 2);
  ctx.restore();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
