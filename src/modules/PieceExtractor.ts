import { DPI, pixelsToMM } from './ScannerConfig';
import { Piece, Point } from './ProportionalScaler';

/**
 * Binariza la imagen a blanco y negro usando umbral fijo.
 * Los trazos negros sobre fondo blanco se convierten en 0 (negro),
 * el fondo en 255 (blanco).
 */
export function binarizeImage(
  imageData: ImageData,
  threshold: number = 128
): ImageData {
  const data = imageData.data;
  const result = new ImageData(new Uint8ClampedArray(data), imageData.width, imageData.height);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Luminosidad ponderada
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const bin = gray < threshold ? 0 : 255;
    result.data[i] = bin;
    result.data[i + 1] = bin;
    result.data[i + 2] = bin;
    result.data[i + 3] = 255;
  }
  return result;
}

interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * Extrae todas las piezas (componentes conectados negros) de la imagen binarizada.
 * Usa flood fill para detectar contornos.
 * Ignora componentes muy pequeños (ruido).
 */
export function extractPieces(
  binaryData: ImageData,
  dpi: DPI,
  minPieceSizeMM: number = 5
): Piece[] {
  const width = binaryData.width;
  const height = binaryData.height;
  const data = binaryData.data;
  const visited = new Uint8Array(width * height);
  const pieces: Piece[] = [];
  const mmPerPx = pixelsToMM(1, dpi).toNumber();
  const minSizePx = Math.ceil(minPieceSizeMM / mmPerPx);
  const minAreaPx = minSizePx * minSizePx;

  const getPixel = (x: number, y: number): number => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 255;
    return data[(y * width + x) * 4];
  };

  const isBlack = (x: number, y: number): boolean => getPixel(x, y) < 128;
  const isVisited = (x: number, y: number): boolean => visited[y * width + x] === 1;
  const markVisited = (x: number, y: number) => { visited[y * width + x] = 1; };

  // flood fill de componente
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isBlack(x, y) && !isVisited(x, y)) {
        const component = floodFill(x, y, width, height, isBlack, isVisited, markVisited);

        // Calcular bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of component) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        const bbW = maxX - minX + 1;
        const bbH = maxY - minY + 1;

        // Filtrar piezas muy pequeñas (ruido)
        if (bbW < minSizePx || bbH < minSizePx || component.length < minAreaPx) {
          continue;
        }

        // Convertir a contorno aproximado (borde externo)
        const contour = extractOuterContour(component, width, height);

        // Convertir píxeles a mm y normalizar a origen (minX, minY) = 0
        const pointsMM: Point[] = contour.map(p => ({
          x: (p.x - minX) * mmPerPx,
          y: (p.y - minY) * mmPerPx,
        }));

        const widthMM = bbW * mmPerPx;
        const heightMM = bbH * mmPerPx;

        // Área aproximada en mm²
        const areaMM2 = component.length * mmPerPx * mmPerPx;

        pieces.push({
          id: `piece_${pieces.length}`,
          points: pointsMM,
          widthMM,
          heightMM,
          boundingBox: { minX: 0, minY: 0, maxX: widthMM, maxY: heightMM },
          areaMM2,
        });
      }
    }
  }

  return pieces;
}

function floodFill(
  startX: number,
  startY: number,
  width: number,
  height: number,
  isBlack: (x: number, y: number) => boolean,
  isVisited: (x: number, y: number) => boolean,
  markVisited: (x: number, y: number) => void
): Point[] {
  const component: Point[] = [];
  const stack: Point[] = [{ x: startX, y: startY }];
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) continue;
    if (isVisited(p.x, p.y)) continue;
    if (!isBlack(p.x, p.y)) continue;
    markVisited(p.x, p.y);
    component.push(p);
    stack.push({ x: p.x + 1, y: p.y });
    stack.push({ x: p.x - 1, y: p.y });
    stack.push({ x: p.x, y: p.y + 1 });
    stack.push({ x: p.x, y: p.y - 1 });
  }
  return component;
}

/**
 * Extrae el contorno externo simplificado de un componente.
 * Recorre los píxeles que tienen al menos un vecino blanco (fondo).
 */
function extractOuterContour(
  component: Point[],
  width: number,
  height: number
): Point[] {
  const pointSet = new Set(component.map(p => `${p.x},${p.y}`));
  const isInComponent = (x: number, y: number) => pointSet.has(`${x},${y}`);

  const edgePoints: Point[] = [];
  for (const p of component) {
    const { x, y } = p;
    // Es borde si alguno de los 4 vecinos NO está en el componente
    const isEdge =
      x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
      !isInComponent(x + 1, y) || !isInComponent(x - 1, y) ||
      !isInComponent(x, y + 1) || !isInComponent(x, y - 1);
    if (isEdge) {
      edgePoints.push(p);
    }
  }

  // Ordenar contorno en sentido horario (aproximación por convex hull simple)
  return orderConvexHull(edgePoints);
}

/**
 * Ordena puntos por ángulo polar desde centroide para obtener un contorno ordenado.
 */
function orderConvexHull(points: Point[]): Point[] {
  if (points.length < 3) return points;

  // Calcular centroide
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= points.length;
  cy /= points.length;

  // Ordenar por ángulo
  return [...points].sort((a, b) => {
    const angleA = Math.atan2(a.y - cy, a.x - cx);
    const angleB = Math.atan2(b.y - cy, b.x - cx);
    return angleA - angleB;
  });
}

/**
 * Carga una imagen desde un archivo y devuelve ImageData.
 */
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

/**
 * Dibuja una imagen en un canvas y devuelve el ImageData.
 */
export function getImageDataFromImage(img: HTMLImageElement): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
