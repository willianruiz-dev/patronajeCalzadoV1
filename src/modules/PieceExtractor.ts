import { DPI, pixelsToMM } from './ScannerConfig';
import { Piece, Point } from './ProportionalScaler';

/**
 * Binariza: 0 negro (tinta), 255 blanco.
 */
export function binarizeImage(imageData: ImageData, threshold: number): ImageData {
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

/** 1 = tinta (negro), 0 = fondo (blanco) */
function toBinary(imgData: ImageData): Uint8Array {
  const w = imgData.width, h = imgData.height;
  const b = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) b[i] = imgData.data[i * 4] < 128 ? 1 : 0;
  return b;
}

/** Dilatación 4-vecindad (crece la tinta 1px) */
function dilate4(bin: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bin[i]) { out[i] = 1; continue; }
      if (x > 0 && bin[i-1]) { out[i]=1; continue; }
      if (x < w-1 && bin[i+1]) { out[i]=1; continue; }
      if (y > 0 && bin[i-w]) { out[i]=1; continue; }
      if (y < h-1 && bin[i+w]) { out[i]=1; continue; }
      out[i] = 0;
    }
  }
  return out;
}

/** Repetir una operación N veces */
function repeatN(op: (b: Uint8Array, w: number, h: number) => Uint8Array, bin: Uint8Array, w: number, h: number, n: number): Uint8Array {
  let b = bin;
  for (let i = 0; i < n; i++) b = op(b, w, h);
  return b;
}

/** Añade borde blanco */
function addWhiteBorder(bin: Uint8Array, w: number, h: number, pad: number) {
  const nw = w + pad*2, nh = h + pad*2;
  const out = new Uint8Array(nw*nh);
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) out[(y+pad)*nw + (x+pad)] = bin[y*w+x];
  return { bin:out, w:nw, h:nh, ox:pad, oy:pad };
}

/**
 * Connected-components de la tinta (1) y etiqueta cuáles tocan el borde.
 * Devuelve label array y un Set con las etiquetas que tocan el borde (fondo).
 */
function labelInkComponents(bin: Uint8Array, w: number, h: number): {
  label: Int32Array; count: number; touchesBorder: Set<number>; areas: number[];
  boxes: Array<{minX:number;minY:number;maxX:number;maxY:number}>;
} {
  const label = new Int32Array(w*h);
  const touchesBorder = new Set<number>();
  const areas: number[] = [0];
  const boxes: Array<{minX:number;minY:number;maxX:number;maxY:number}> = [{minX:0,minY:0,maxX:0,maxY:0}];
  let nextLabel = 1;
  const stack: number[] = [];

  for (let y=0; y<h; y++) {
    for (let x=0; x<w; x++) {
      const i = y*w + x;
      if (bin[i] === 1 && label[i] === 0) {
        label[i] = nextLabel;
        stack.push(i);
        let area = 0;
        let minX=x,minY=y,maxX=x,maxY=y;
        let onBorder = false;
        while (stack.length) {
          const k = stack.pop()!;
          area++;
          const kx = k%w, ky = (k-kx)/w;
          if (kx<minX)minX=kx; if (ky<minY)minY=ky;
          if (kx>maxX)maxX=kx; if (ky>maxY)maxY=ky;
          if (kx===0||ky===0||kx===w-1||ky===h-1) onBorder=true;
          const neigh = [k+1,k-1,k+w,k-w];
          for (const n of neigh) {
            if (n<0||n>=w*h) continue;
            const nx=n%w, ny=(n-nx)/w;
            if (Math.abs(nx-kx)+Math.abs(ny-ky)!==1) continue;
            if (bin[n]===1 && label[n]===0) { label[n]=nextLabel; stack.push(n); }
          }
        }
        areas.push(area);
        boxes.push({minX,minY,maxX,maxY});
        if (onBorder) touchesBorder.add(nextLabel);
        nextLabel++;
      }
    }
  }
  return { label, count: nextLabel-1, touchesBorder, areas, boxes };
}

/**
 * Traza el contorno EXTERIOR de un blob negro (componente de tinta) usando Moore-Neighborhood.
 * El blob está marcado en `label` con el valor `targetLabel`.
 * El punto inicial es la esquina superior-izquierda del blob (primer píxel con esa etiqueta al escanear desde arriba-izq).
 */
function traceOuterContour(label: Int32Array, w: number, h: number, targetLabel: number, startX: number, startY: number): Point[] {
  const dx = [1,1,0,-1,-1,-1,0,1];
  const dy = [0,1,1,1,0,-1,-1,-1];
  const isBlob = (x:number,y:number) =>
    x>=0 && y>=0 && x<w && y<h && label[y*w+x] === targetLabel;

  // Buscar el primer píxel del blob con un píxel de fondo arriba (punto superior del contorno)
  let sx = startX, sy = startY;
  findStart:
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (label[y*w+x] === targetLabel) { sx = x; sy = y; break findStart; }
    }
  }

  // Moore-Neighbor empezando en (sx,sy), dirección inicial sur, fondo al norte.
  const pts: Point[] = [];
  let cx = sx, cy = sy;
  let dir = 0; // empezar mirando al E (buscar el borde derecho)
  // Ajustar la dirección inicial: retroceder hasta estar sobre un píxel de fondo
  // Encontrar la primera dirección que apunta al fondo (no blob)
  for (let d=0; d<8; d++) {
    if (!isBlob(cx+dx[d], cy+dy[d])) { dir = d; break; }
  }

  const startCX = cx, startCY = cy;
  pts.push({x:cx,y:cy});
  const maxSteps = w*h;
  let steps = 0;

  while (steps++ < maxSteps) {
    let found = -1;
    for (let i=0; i<8; i++) {
      const d = (dir + 7 - i + 8) % 8; // barrer antihorario a partir de dir-1
      const nx = cx+dx[d], ny = cy+dy[d];
      if (isBlob(nx,ny)) { found = d; cx = nx; cy = ny; dir = d; break; }
    }
    if (found === -1) break;
    pts.push({x:cx,y:cy});
    if (cx===startCX && cy===startCY && pts.length>3) break;
    dir = (found + 2) % 8;
  }

  return pts;
}

/** Douglas-Peucker */
function dpSimplify(pts: Point[], eps: number): Point[] {
  if (pts.length<=2) return pts.slice();
  const a=pts[0], b=pts[pts.length-1];
  const dx=b.x-a.x, dy=b.y-a.y;
  const ln = Math.hypot(dx,dy)||1;
  let maxD=0, idx=0;
  for (let i=1;i<pts.length-1;i++){
    const p=pts[i];
    const d=Math.abs(dy*p.x-dx*p.y + b.x*a.y - b.y*a.x)/ln;
    if(d>maxD){maxD=d;idx=i;}
  }
  if(maxD>eps){
    const L=dpSimplify(pts.slice(0,idx+1),eps);
    const R=dpSimplify(pts.slice(idx),eps);
    return L.slice(0,-1).concat(R);
  }
  return [a,b];
}

export interface ExtractResult {
  pieces: Piece[];
  debugOverlay: ImageData | null;
  usedRadius: number;
}

let _originalImgData: ImageData | null = null;

/**
 * Extrae piezas usando dilatación progresiva (método robusto para dibujos a mano).
 * EstrATEGIA:
 *   1. Binariza
 *   2. Añade borde blanco
 *   3. Prueba dilataciones progresivas: al dilatar los trazos, éstos se engruesan
 *      hasta que para una pieza cerrada acaban fusionándose en una mancha negra SÓLIDA
 *      que coincide con la silueta de la pieza.
 *   4. Los componentes de tinta que NO tocan el borde son esas manchas = piezas.
 *   5. Trazamos el contorno externo con Moore-Neighborhood sobre esa mancha.
 *   6. Probamos con el radio inicial y vamos aumentando automáticamente hasta
 *      encontrar componentes de tinta internos (piezas).
 */
export function extractPiecesWithOptions(
  imageData: ImageData,
  dpi: DPI,
  opts: { threshold?: number; closeRadius?: number; minPieceMM?: number } = {}
): ExtractResult {
  const threshold = opts.threshold ?? 180;
  const initRadius = opts.closeRadius ?? 6;
  const minPieceMM = opts.minPieceMM ?? 10;
  _originalImgData = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);

  const bin0 = toBinary(binarizeImage(imageData, threshold));
  const PAD = 20;
  const padded = addWhiteBorder(bin0, imageData.width, imageData.height, PAD);
  const W = padded.w, H = padded.h;
  const baseBin = padded.bin;

  const mmPerPx = pixelsToMM(1, dpi).toNumber();
  const minAreaPx = (minPieceMM*minPieceMM) / (mmPerPx*mmPerPx);
  const minWHPx = Math.ceil(minPieceMM/mmPerPx);

  let bestPieces: Piece[] = [];
  let bestRadius = initRadius;
  let bestBin: Uint8Array | null = null;
  let bestLabels: Int32Array | null = null;
  let bestBoxes: Array<{minX:number;minY:number;maxX:number;maxY:number}> = [];
  let bestPieceLabels: number[] = [];

  const radii: number[] = [];
  for (let r=initRadius; r<=40; r+=2) radii.push(r);
  for (let r=4; r<initRadius; r+=2) if(!radii.includes(r)) radii.unshift(r);

  for (const radius of radii) {
    const dilated = repeatN(dilate4, baseBin, W, H, radius);
    const cc = labelInkComponents(dilated, W, H);

    const pieceLabels: number[] = [];
    for (let lbl=1; lbl<=cc.count; lbl++) {
      if (cc.touchesBorder.has(lbl)) continue; // el marco / el fondo conectado al borde
      const areaPx = cc.areas[lbl];
      if (areaPx < minAreaPx) continue;
      const box = cc.boxes[lbl];
      const bw = box.maxX-box.minX+1, bh=box.maxY-box.minY+1;
      if (bw < minWHPx || bh < minWHPx) continue;
      pieceLabels.push(lbl);
    }

    if (pieceLabels.length >= 1 && radius >= initRadius - 2) {
      bestRadius = radius;
      bestBin = dilated;
      bestLabels = cc.label;
      bestBoxes = cc.boxes;
      bestPieceLabels = pieceLabels;
      break;
    }
  }

  if (bestBin && bestLabels) {
    for (const lbl of bestPieceLabels) {
      const box = bestBoxes[lbl];
      const contourPx = traceOuterContour(bestLabels, W, H, lbl, box.minX, box.minY);
      const simplified = dpSimplify(contourPx, Math.max(1.0, 1.5));

      const points: Point[] = simplified.map(p => ({
        x: (p.x - PAD - box.minX) * mmPerPx,
        y: (p.y - PAD - box.minY) * mmPerPx,
      }));

      const bw = box.maxX - box.minX + 1;
      const bh = box.maxY - box.minY + 1;
      const widthMM = bw * mmPerPx;
      const heightMM = bh * mmPerPx;
      const areaMM2 = bestPieces.length < 0 ? 0 : 0;

      bestPieces.push({
        id: `piece_${bestPieces.length}`,
        points,
        widthMM,
        heightMM,
        boundingBox: { minX:0, minY:0, maxX:widthMM, maxY:heightMM },
        areaMM2: (bw*bh) * mmPerPx*mmPerPx,
      });
    }
  }

  const debugOverlay = bestBin && _originalImgData
    ? buildDebugOverlay(_originalImgData, bestBin, W, H, PAD, bestLabels, bestPieceLabels)
    : null;

  return { pieces: bestPieces, debugOverlay, usedRadius: bestRadius };
}

function buildDebugOverlay(orig: ImageData, bin: Uint8Array, W: number, H: number, PAD: number, label: Int32Array | null, pieceLabels: number[]): ImageData {
  const out = new ImageData(new Uint8ClampedArray(orig.data), orig.width, orig.height);
  const sx = W / orig.width;
  const sy = H / orig.height;
  const pieceSet = new Set(pieceLabels);
  for (let y=0; y<orig.height; y++) {
    for (let x=0; x<orig.width; x++) {
      const bx = Math.floor(x*sx), by = Math.floor(y*sy);
      const bi = by*W + bx;
      const i = (y*orig.width + x)*4;
      if (label && pieceSet.has(label[bi])) {
        out.data[i]=37; out.data[i+1]=99; out.data[i+2]=235; out.data[i+3]=150;
      } else if (bin[bi]) {
        out.data[i]=239; out.data[i+1]=68; out.data[i+2]=68; out.data[i+3]=140;
      }
    }
  }
  return out;
}

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = ()=>resolve(img);
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function getImageDataFromImage(img: HTMLImageElement, maxWidthPx: number = 1600): ImageData {
  const scale = img.width>maxWidthPx ? maxWidthPx/img.width : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width*scale);
  c.height = Math.round(img.height*scale);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0,0,c.width,c.height);
}

export function rotateImageData90(img: HTMLImageElement): ImageData {
  const src = getImageDataFromImage(img);
  const w=src.width, h=src.height;
  const c = document.createElement('canvas');
  c.width=h; c.height=w;
  const ctx=c.getContext('2d')!;
  const tmp=document.createElement('canvas');
  tmp.width=w;tmp.height=h;
  tmp.getContext('2d')!.putImageData(src,0,0);
  ctx.save();
  ctx.translate(c.width/2,c.height/2);
  ctx.rotate(Math.PI/2);
  ctx.drawImage(tmp,-w/2,-h/2);
  ctx.restore();
  return ctx.getImageData(0,0,c.width,c.height);
}
