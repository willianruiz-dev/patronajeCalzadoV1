import Decimal from 'decimal.js';

export type PaperSize = 'carta' | 'oficio' | 'a4';

// Dimensiones en milímetros (ancho x alto) en orientación horizontal
export const PAPER_DIMENSIONS_MM: Record<PaperSize, { width: number; height: number }> = {
  carta: { width: 279.4, height: 215.9 },   // Carta US: 11" x 8.5"
  oficio: { width: 355.6, height: 215.9 },  // Oficio/Legal: 14" x 8.5"
  a4: { width: 297, height: 210 },          // A4: 297mm x 210mm
};

export type DPI = 300 | 600;

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
  paperSize: PaperSize,
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
