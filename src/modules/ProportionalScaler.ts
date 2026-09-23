import Decimal from 'decimal.js';
import { INCREMENTO_LONGITUDINAL_MM, INCREMENTO_TRANSVERSAL_MM, FUNCTIONAL_MARGIN_MM, BASE_WIDTH_40_MM } from './colombianLasts';

export interface Point {
  x: number;
  y: number;
}

export interface Piece {
  id: string;
  points: Point[];
  widthMM: number;
  heightMM: number;
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
  areaMM2: number;
}

export interface ScaledPiece extends Piece {
  originalPiece: Piece;
  factorX: Decimal;
  factorY: Decimal;
  targetSize: number;
}

/**
 * Calcula la longitud teórica de la horma para una talla dada.
 * LongitudHorma = Talla * 6.67 + MargenFuncional(15mm)
 */
export function calculateLastLengthMM(size: number): Decimal {
  return new Decimal(size).times(INCREMENTO_LONGITUDINAL_MM).plus(FUNCTIONAL_MARGIN_MM);
}

/**
 * Calcula el ancho teórico de la horma para una talla dada.
 * Basado en ancho base de 90mm para talla 40, creciendo 4.5mm por talla.
 */
export function calculateLastWidthMM(size: number, referenceSize: number = 40, referenceWidthMM: number = BASE_WIDTH_40_MM): Decimal {
  const sizeDiff = new Decimal(size).minus(referenceSize);
  return new Decimal(referenceWidthMM).plus(sizeDiff.times(INCREMENTO_TRANSVERSAL_MM));
}

/**
 * Calcula los factores globales de escalado X e Y.
 * FactorGlobalX = LongitudHorma(Destino) / LongitudHorma(Base)
 * FactorGlobalY = AnchoHorma(Destino) / AnchoHorma(Base)
 */
export function calculateGlobalFactors(
  baseSize: number,
  targetSize: number
): { factorX: Decimal; factorY: Decimal } {
  const baseLength = calculateLastLengthMM(baseSize);
  const targetLength = calculateLastLengthMM(targetSize);
  const baseWidth = calculateLastWidthMM(baseSize);
  const targetWidth = calculateLastWidthMM(targetSize);

  return {
    factorX: targetLength.dividedBy(baseLength),
    factorY: targetWidth.dividedBy(baseWidth),
  };
}

/**
 * Aplica el escalado proporcional a una pieza individual.
 * IMPORTANTE: Usa factores multiplicativos GLOBALES, NO suma de milímetros.
 * Cada punto (x,y) se escala como: x_nuevo = x_original * factorX, y_nuevo = y_original * factorY
 */
export function scalePiece(
  piece: Piece,
  factorX: Decimal,
  factorY: Decimal,
  targetSize: number
): ScaledPiece {
  const scaledPoints: Point[] = piece.points.map(p => ({
    x: new Decimal(p.x).times(factorX).toNumber(),
    y: new Decimal(p.y).times(factorY).toNumber(),
  }));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of scaledPoints) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const widthMM = maxX - minX;
  const heightMM = maxY - minY;

  // Área aproximada usando polígono simple
  const areaMM2 = calculatePolygonArea(scaledPoints);

  return {
    id: `${piece.id}_scaled_${targetSize}`,
    points: scaledPoints,
    widthMM,
    heightMM,
    boundingBox: { minX, minY, maxX, maxY },
    areaMM2,
    originalPiece: piece,
    factorX,
    factorY,
    targetSize,
  };
}

/**
 * Escala todas las piezas de una sola vez usando los mismos factores globales.
 */
export function scaleAllPieces(
  pieces: Piece[],
  baseSize: number,
  targetSize: number
): ScaledPiece[] {
  const { factorX, factorY } = calculateGlobalFactors(baseSize, targetSize);
  return pieces.map(p => scalePiece(p, factorX, factorY, targetSize));
}

/**
 * Calcula el área de un polígono usando la fórmula del shoelace.
 */
function calculatePolygonArea(points: Point[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
}
