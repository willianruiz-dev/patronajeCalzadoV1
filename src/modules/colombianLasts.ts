/**
 * Tabla de tallas estándar Colombia para referencia.
 * Longitud de horma = Talla * 6.67 + MargenFuncional(15mm)
 * Ancho de horma crece 4.5mm por talla.
 */

export type LastCategory = 'ninos' | 'mujeres' | 'hombres';

export interface LastSize {
  size: number;
  lengthMM: number;
  widthMM: number;
}

const FUNCTIONAL_MARGIN_MM = 15;
const INCREMENTO_LONGITUDINAL_MM = 6.67;
const INCREMENTO_TRANSVERSAL_MM = 4.5;

// Ancho base de referencia para talla 40 (aprox 90mm - valor industrial estándar)
const BASE_WIDTH_40_MM = 90;

export function calculateLastLength(size: number): number {
  return size * INCREMENTO_LONGITUDINAL_MM + FUNCTIONAL_MARGIN_MM;
}

export function calculateLastWidth(size: number, referenceSize: number = 40, referenceWidth: number = BASE_WIDTH_40_MM): number {
  const sizeDiff = size - referenceSize;
  return referenceWidth + sizeDiff * INCREMENTO_TRANSVERSAL_MM;
}

export function getStandardSizes(category: LastCategory): LastSize[] {
  const ranges: Record<LastCategory, [number, number]> = {
    ninos: [20, 35],
    mujeres: [35, 41],
    hombres: [39, 44],
  };
  const [min, max] = ranges[category];
  const sizes: LastSize[] = [];
  for (let s = min; s <= max; s++) {
    sizes.push({
      size: s,
      lengthMM: calculateLastLength(s),
      widthMM: calculateLastWidth(s),
    });
  }
  return sizes;
}

export { FUNCTIONAL_MARGIN_MM, INCREMENTO_LONGITUDINAL_MM, INCREMENTO_TRANSVERSAL_MM, BASE_WIDTH_40_MM };
