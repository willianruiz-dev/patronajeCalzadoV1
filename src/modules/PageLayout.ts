/**
 * Paginación de cada talla en hojas REALES de impresora.
 *
 * Problema que resuelve: el molde escalado de una talla (p. ej. 229.6 × 306.4 mm
 * para la talla 40) no cabe en una hoja Carta, y ninguna impresora acepta una
 * hoja gigante con todas las tallas en fila.
 *
 * Solución (igual que la impresión "en mosaico/póster"):
 *   - Cada talla va en su(s) propia(s) hoja(s), nunca se mezclan tallas.
 *   - Si el molde cabe en el área imprimible se centra en UNA hoja.
 *   - Si no cabe, se divide en una cuadrícula de hojas (filas × columnas) con
 *     una franja de SOLAPE entre hojas vecinas para poder pegarlas, y con
 *     cruces de registro dibujadas en las mismas coordenadas del molde en
 *     ambas hojas, de modo que al alinear las cruces el dibujo coincide.
 *
 * Todo en milímetros. Las coordenadas "src" son del molde escalado (origen en
 * la esquina superior izquierda del recuadro del molde); las "dst" son de la
 * hoja (origen en la esquina superior izquierda de la hoja).
 */

import { PAPERS, PaperSize } from './ScannerConfig';

export type Orientation = 'auto' | 'vertical' | 'horizontal';

export interface PrintSettings {
  paper: PaperSize;
  orientation: Orientation;
  /** Margen no imprimible de la impresora (mm). */
  marginMM: number;
  /** Solape entre hojas vecinas (mm) para pegarlas. */
  overlapMM: number;
}

/** Franja reservada arriba de cada hoja para la etiqueta (talla, hoja n/N...). */
export const HEADER_MM = 14;
/** Franja reservada abajo de cada hoja para la barra de control de 100 mm. */
export const FOOTER_MM = 11;

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  paper: 'carta',
  orientation: 'auto',
  marginMM: 8,
  overlapMM: 10,
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tile {
  /** Fila y columna dentro de la cuadrícula de hojas (0-based). */
  row: number;
  col: number;
  /** Número de hoja dentro de la talla (1-based, orden de lectura). */
  index: number;
  /** Región del molde escalado que se ve en esta hoja (mm, coords del molde). */
  src: Rect;
  /** Posición en la hoja donde cae la esquina superior izquierda de `src` (mm). */
  dstX: number;
  dstY: number;
  /** Si hay una hoja vecina en cada lado (hay solape en ese borde). */
  hasLeft: boolean;
  hasRight: boolean;
  hasTop: boolean;
  hasBottom: boolean;
}

export interface SizeLayout {
  size: number;
  /** Dimensiones del molde escalado (mm). */
  moldeW: number;
  moldeH: number;
  /** Tamaño de la hoja ya orientada (mm). */
  pageW: number;
  pageH: number;
  landscape: boolean;
  /** Área imprimible destinada al dibujo (mm, coords de hoja). */
  area: Rect;
  rows: number;
  cols: number;
  tiles: Tile[];
  overlapMM: number;
  paper: PaperSize;
}

/** Número de hojas necesarias para cubrir una longitud L con hojas de área A y solape ov. */
export function tilesNeeded(lengthMM: number, areaMM: number, overlapMM: number): number {
  if (lengthMM <= areaMM + 1e-6) return 1;
  const step = areaMM - overlapMM;
  if (step <= 0) return Infinity;
  return Math.max(1, Math.ceil((lengthMM - overlapMM) / step - 1e-9));
}

function buildTiles(
  moldeW: number,
  moldeH: number,
  area: Rect,
  overlap: number,
): { rows: number; cols: number; tiles: Tile[] } {
  const cols = tilesNeeded(moldeW, area.w, overlap);
  const rows = tilesNeeded(moldeH, area.h, overlap);
  const tiles: Tile[] = [];
  if (!isFinite(cols) || !isFinite(rows)) return { rows: 0, cols: 0, tiles };

  const stepX = area.w - overlap;
  const stepY = area.h - overlap;
  let index = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const srcX = cols === 1 ? 0 : c * stepX;
      const srcY = rows === 1 ? 0 : r * stepY;
      const srcW = Math.min(area.w, moldeW - srcX);
      const srcH = Math.min(area.h, moldeH - srcY);
      // Si cabe en una sola hoja en ese eje, se centra.
      const dstX = cols === 1 ? area.x + (area.w - moldeW) / 2 : area.x;
      const dstY = rows === 1 ? area.y + (area.h - moldeH) / 2 : area.y;
      tiles.push({
        row: r,
        col: c,
        index: index++,
        src: { x: srcX, y: srcY, w: srcW, h: srcH },
        dstX,
        dstY,
        hasLeft: c > 0,
        hasRight: c < cols - 1,
        hasTop: r > 0,
        hasBottom: r < rows - 1,
      });
    }
  }
  return { rows, cols, tiles };
}

function areaFor(pageW: number, pageH: number, margin: number): Rect {
  return {
    x: margin,
    y: margin + HEADER_MM,
    w: pageW - 2 * margin,
    h: pageH - 2 * margin - HEADER_MM - FOOTER_MM,
  };
}

/**
 * Calcula cómo se reparte UNA talla en hojas.
 */
export function layoutSize(size: number, moldeW: number, moldeH: number, s: PrintSettings): SizeLayout {
  const margin = Math.max(0, s.marginMM);
  const paper = PAPERS[s.paper];

  if (s.paper === 'plotter') {
    // Hoja a medida: el molde entero + márgenes + franjas de etiqueta.
    const pageW = moldeW + 2 * margin;
    const pageH = moldeH + 2 * margin + HEADER_MM + FOOTER_MM;
    const area = areaFor(pageW, pageH, margin);
    const { rows, cols, tiles } = buildTiles(moldeW, moldeH, area, 0);
    return { size, moldeW, moldeH, pageW, pageH, landscape: pageW > pageH, area, rows, cols, tiles, overlapMM: 0, paper: s.paper };
  }

  const candidates: Array<{ landscape: boolean }> =
    s.orientation === 'vertical' ? [{ landscape: false }]
    : s.orientation === 'horizontal' ? [{ landscape: true }]
    : [{ landscape: false }, { landscape: true }];

  let best: SizeLayout | null = null;
  for (const cand of candidates) {
    const pageW = cand.landscape ? paper.heightMM : paper.widthMM;
    const pageH = cand.landscape ? paper.widthMM : paper.heightMM;
    const area = areaFor(pageW, pageH, margin);
    // El solape no puede comerse el área: como mucho un tercio del lado menor.
    const overlap = Math.min(Math.max(0, s.overlapMM), Math.min(area.w, area.h) / 3);
    const { rows, cols, tiles } = buildTiles(moldeW, moldeH, area, overlap);
    const layout: SizeLayout = { size, moldeW, moldeH, pageW, pageH, landscape: cand.landscape, area, rows, cols, tiles, overlapMM: overlap, paper: s.paper };
    if (!best) { best = layout; continue; }
    const nBest = best.rows * best.cols;
    const n = rows * cols;
    if (n < nBest) best = layout;
    else if (n === nBest) {
      // Empate: preferimos la orientación que deja el dibujo más "holgado"
      // (menor porcentaje de área de hoja utilizado => menos cortes justos).
      const slackBest = usedFraction(best);
      const slack = usedFraction(layout);
      if (slack < slackBest - 1e-9) best = layout;
    }
  }
  return best!;
}

function usedFraction(l: SizeLayout): number {
  const totalArea = l.rows * l.cols * l.area.w * l.area.h;
  if (totalArea <= 0) return 1;
  return (l.moldeW * l.moldeH) / totalArea;
}

/** Descripción corta de la orientación/hoja para logs y UI. */
export function describeLayout(l: SizeLayout): string {
  const paperName = l.paper === 'plotter'
    ? `hoja a medida ${l.pageW.toFixed(0)}×${l.pageH.toFixed(0)} mm`
    : `${PAPERS[l.paper].name.split(' (')[0]} ${l.landscape ? 'horizontal' : 'vertical'}`;
  const n = l.rows * l.cols;
  if (n === 1) return `${paperName} · 1 hoja`;
  return `${paperName} · ${l.rows}×${l.cols} = ${n} hojas (solape ${l.overlapMM.toFixed(0)} mm)`;
}

/** Total de hojas de un conjunto de tallas. */
export function totalPages(layouts: SizeLayout[]): number {
  return layouts.reduce((acc, l) => acc + l.rows * l.cols, 0);
}
