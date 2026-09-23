import { Piece, Point } from './ProportionalScaler';
import { PaperSize, PAPER_DIMENSIONS_MM } from './ScannerConfig';

export interface NestedPiece {
  piece: Piece;
  offsetX: number;
  offsetY: number;
}

export interface NestingResult {
  pieces: NestedPiece[];
  totalWidthMM: number;
  totalHeightMM: number;
  paperSize?: PaperSize;
  continuous?: boolean;
}

interface Shelf {
  y: number;
  height: number;
  currentX: number;
}

const DEFAULT_MARGIN_MM = 10;

/**
 * Algoritmo Shelf Packing (Bin Packing simple) para reacomodar piezas.
 * Ordena piezas por área (mayor a menor) y las coloca en "estantes".
 * Minimiza el área total respetando los márgenes de corte.
 */
export function autoNest(
  pieces: Piece[],
  options: {
    paperSize?: PaperSize;
    continuous?: boolean;
    marginMM?: number;
    rollWidthMM?: number;
  } = {}
): NestingResult {
  const margin = options.marginMM ?? DEFAULT_MARGIN_MM;

  // Ordenar piezas por área descendente (mayores primero)
  const sortedPieces = [...pieces].sort((a, b) => b.areaMM2 - a.areaMM2);

  const shelves: Shelf[] = [];
  const placed: NestedPiece[] = [];

  // Determinar ancho del lienzo
  let canvasWidthMM: number;
  if (options.paperSize && !options.continuous) {
    canvasWidthMM = PAPER_DIMENSIONS_MM[options.paperSize].width;
  } else if (options.continuous && options.rollWidthMM) {
    canvasWidthMM = options.rollWidthMM;
  } else {
    // Automático: usar el ancho de la pieza más grande
    canvasWidthMM = Math.max(...sortedPieces.map(p => p.widthMM)) * 1.5;
  }

  let currentY = margin;

  for (const piece of sortedPieces) {
    const pieceW = piece.widthMM + margin * 2;
    const pieceH = piece.heightMM + margin * 2;

    let placedOnShelf = false;

    // Intentar colocar en un shelf existente
    for (const shelf of shelves) {
      if (shelf.currentX + pieceW <= canvasWidthMM && pieceH <= shelf.height + 0.001) {
        placed.push({
          piece,
          offsetX: shelf.currentX + margin,
          offsetY: shelf.y + margin,
        });
        shelf.currentX += pieceW;
        placedOnShelf = true;
        break;
      }
    }

    if (!placedOnShelf) {
      // Crear nuevo shelf
      const newShelf: Shelf = {
        y: currentY,
        height: pieceH,
        currentX: pieceW,
      };
      shelves.push(newShelf);
      placed.push({
        piece,
        offsetX: margin,
        offsetY: currentY + margin,
      });
      currentY += pieceH;
    }
  }

  const totalWidthMM = canvasWidthMM;
  let totalHeightMM = currentY;
  if (shelves.length > 0) {
    const lastShelf = shelves[shelves.length - 1];
    totalHeightMM = Math.max(totalHeightMM, lastShelf.y + lastShelf.height + margin);
  }

  return {
    pieces: placed,
    totalWidthMM,
    totalHeightMM,
    paperSize: options.paperSize,
    continuous: options.continuous,
  };
}

/**
 * Reacomoda piezas para un tamaño de papel específico.
 * Si no caben en una hoja, devuelve múltiples páginas (roll continuo).
 */
export function nestForPaper(pieces: Piece[], paperSize: PaperSize, marginMM: number = DEFAULT_MARGIN_MM): NestingResult[] {
  const paper = PAPER_DIMENSIONS_MM[paperSize];
  const results: NestingResult[] = [];

  // Primer intento: todas en una hoja
  const singleSheet = autoNest(pieces, { paperSize, marginMM });
  if (singleSheet.totalHeightMM <= paper.height) {
    return [singleSheet];
  }

  // Si no caben, usar rollo continuo del ancho del papel
  const continuous = autoNest(pieces, { continuous: true, rollWidthMM: paper.width, marginMM });
  // Dividir en páginas del alto del papel
  const pages: Piece[][] = [[]];
  let pageHeightUsed = 0;
  // TODO: Dividir piezas en páginas si es necesario. Por ahora devolvemos el resultado continuo.
  results.push({ ...continuous, paperSize, continuous: true });
  return results;
}
