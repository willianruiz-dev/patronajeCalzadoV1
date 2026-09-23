import Decimal from 'decimal.js';

/**
 * Tamaños de papel soportados para IMPRIMIR el resultado.
 * Dimensiones en mm en orientación VERTICAL (retrato). La orientación
 * horizontal se obtiene intercambiando ancho/alto.
 *
 * 'plotter' = hoja a medida (una hoja por talla del tamaño exacto del molde),
 * pensada para plotters/rollo continuo.
 */
export type PaperSize = 'carta' | 'oficio' | 'a4' | 'a3' | 'tabloide' | 'plotter';

export interface PaperSpec {
  id: PaperSize;
  name: string;
  widthMM: number;
  heightMM: number;
}

export const PAPERS: Record<PaperSize, PaperSpec> = {
  carta:    { id: 'carta',    name: 'Carta (21.6 × 27.9 cm)',        widthMM: 215.9, heightMM: 279.4 },
  oficio:   { id: 'oficio',   name: 'Oficio / Legal (21.6 × 35.6 cm)', widthMM: 215.9, heightMM: 355.6 },
  a4:       { id: 'a4',       name: 'A4 (21.0 × 29.7 cm)',           widthMM: 210,   heightMM: 297 },
  a3:       { id: 'a3',       name: 'A3 (29.7 × 42.0 cm)',           widthMM: 297,   heightMM: 420 },
  tabloide: { id: 'tabloide', name: 'Doble carta / Tabloide (27.9 × 43.2 cm)', widthMM: 279.4, heightMM: 431.8 },
  plotter:  { id: 'plotter',  name: 'Plotter / rollo (hoja a medida por talla)', widthMM: 0, heightMM: 0 },
};

/** Compatibilidad: dimensiones en horizontal de los papeles clásicos. */
export const PAPER_DIMENSIONS_MM: Record<'carta' | 'oficio' | 'a4', { width: number; height: number }> = {
  carta: { width: 279.4, height: 215.9 },
  oficio: { width: 355.6, height: 215.9 },
  a4: { width: 297, height: 210 },
};

export type DPI = 300 | 600;

/** Papeles que se usan como hoja del ESCÁNER (la regla de la escala). No incluye plotter. */
export const SCAN_PAPER_IDS = ['carta', 'oficio', 'a4', 'a3', 'tabloide'] as const;
export type ScanPaperId = typeof SCAN_PAPER_IDS[number];
export type ScanSheetChoice = 'auto' | ScanPaperId | 'otro';

export interface SheetMM {
  widthMM: number;
  heightMM: number;
}

/** Tamaño de la imagen en mm según el DPI (lo que Corel mediría del bitmap). */
export function pixelsToSheetMM(widthPx: number, heightPx: number, dpi: number): SheetMM {
  return { widthMM: widthPx * 25.4 / dpi, heightMM: heightPx * 25.4 / dpi };
}

/** Gira el papel para que coincida con la orientación de la imagen (px o mm, da igual la unidad). */
export function paperOrientedToImage(paper: PaperSpec, imgWidth: number, imgHeight: number): SheetMM {
  const imgLandscape = imgWidth >= imgHeight;
  const paperLandscape = paper.widthMM >= paper.heightMM;
  if (imgLandscape === paperLandscape) return { widthMM: paper.widthMM, heightMM: paper.heightMM };
  return { widthMM: paper.heightMM, heightMM: paper.widthMM };
}

export interface DetectedScanPaper {
  id: ScanPaperId;
  name: string;
  measured: SheetMM;
  nominal: SheetMM;
  errMM: number;
}

/**
 * Reconoce el papel del escáner comparando los mm de la imagen (px × 25.4/DPI)
 * con Carta / Oficio / A4 / A3 / Tabloide, en cualquier orientación (± tolMM).
 */
export function detectScanPaper(widthPx: number, heightPx: number, dpi: number, tolMM = 8): DetectedScanPaper | null {
  const measured = pixelsToSheetMM(widthPx, heightPx, dpi);
  let best: DetectedScanPaper | null = null;
  for (const id of SCAN_PAPER_IDS) {
    const paper = PAPERS[id];
    const nominal = paperOrientedToImage(paper, measured.widthMM, measured.heightMM);
    const dw = Math.abs(nominal.widthMM - measured.widthMM);
    const dh = Math.abs(nominal.heightMM - measured.heightMM);
    if (dw > tolMM || dh > tolMM) continue;
    const errMM = dw + dh;
    if (!best || errMM < best.errMM) {
      best = { id, name: paper.name.split(' (')[0], measured, nominal, errMM };
    }
  }
  return best;
}

export interface ScanConfiguration {
  paperSize: PaperSize;
  dpi: DPI;
  baseSize: number;
}

/**
 * Calcula milímetros por pixel basado en DPI.
 * 1 pulgada = 25.4 mm
 * mmPorPixel = 25.4 / DPI
 */
export function getMmPerPixel(dpi: DPI): Decimal {
  return new Decimal(25.4).dividedBy(dpi);
}

/**
 * Convierte dimensiones en píxeles a milímetros según el DPI.
 */
export function pixelsToMM(pixels: number, dpi: DPI): Decimal {
  return new Decimal(pixels).times(getMmPerPixel(dpi));
}

/**
 * Convierte milímetros a píxeles según el DPI.
 */
export function mmToPixels(mm: number, dpi: DPI): Decimal {
  return new Decimal(mm).dividedBy(getMmPerPixel(dpi));
}

/**
 * Valida si el tamaño de la imagen (en píxeles) corresponde aproximadamente
 * al tamaño de papel seleccionado con el DPI indicado.
 * Devuelve { valid: boolean, message: string }
 */
export function validateImageSize(
  imageWidthPx: number,
  imageHeightPx: number,
  paperSize: 'carta' | 'oficio' | 'a4',
  dpi: DPI
): { valid: boolean; message: string } {
  const paper = PAPER_DIMENSIONS_MM[paperSize];
  const expectedWidthPx = Math.round((paper.width / 25.4) * dpi);
  const expectedHeightPx = Math.round((paper.height / 25.4) * dpi);

  const tolerancePx = Math.round(50 * (dpi / 300)); // Tolera ~50px de error

  const widthOk = Math.abs(imageWidthPx - expectedWidthPx) <= tolerancePx
    || Math.abs(imageWidthPx - expectedHeightPx) <= tolerancePx; // Puede estar rotada
  const heightOk = Math.abs(imageHeightPx - expectedHeightPx) <= tolerancePx
    || Math.abs(imageHeightPx - expectedWidthPx) <= tolerancePx;

  if (!widthOk || !heightOk) {
    return {
      valid: false,
      message: `La imagen (${imageWidthPx}x${imageHeightPx}px) no coincide con ${paperSize}@${dpi}dpi (esperado ~${expectedWidthPx}x${expectedHeightPx}px). Puedes continuar, pero revisa la orientación.`
    };
  }
  return { valid: true, message: 'Tamaño de imagen válido.' };
}
