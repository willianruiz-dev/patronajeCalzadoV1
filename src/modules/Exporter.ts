import jsPDF from 'jspdf';
import { NestedPiece } from './AutoNester';
import { Point } from './ProportionalScaler';
import { PaperSize, PAPER_DIMENSIONS_MM, DPI } from './ScannerConfig';

/**
 * Exporta el resultado del nesting a formato DXF.
 * Formato DXF R12 simple, compatible con AutoCAD/Corel/plotters.
 */
export function exportToDXF(nestedPieces: NestedPiece[], unit: string = 'MM'): string {
  let dxf = '';

  // Header
  dxf += '0\nSECTION\n2\nHEADER\n';
  dxf += '9\n$INSUNITS\n70\n4\n'; // 4 = Millimeters
  dxf += '0\nENDSEC\n';

  // Tables
  dxf += '0\nSECTION\n2\nTABLES\n';
  dxf += '0\nTABLE\n2\nLAYER\n70\n1\n';
  dxf += '0\nLAYER\n2\nPIEZAS\n70\n0\n62\n7\n6\nCONTINUOUS\n';
  dxf += '0\nENDTAB\n';
  dxf += '0\nENDSEC\n';

  // Entities
  dxf += '0\nSECTION\n2\nENTITIES\n';

  for (const np of nestedPieces) {
    const { piece, offsetX, offsetY } = np;
    const points: Point[] = piece.points.map(p => ({
      x: p.x + offsetX,
      y: p.y + offsetY,
    }));

    dxf += '0\nPOLYLINE\n8\nPIEZAS\n66\n1\n70\n1\n';
    for (const p of points) {
      dxf += '0\nVERTEX\n8\nPIEZAS\n';
      dxf += `10\n${p.x.toFixed(3)}\n20\n${p.y.toFixed(3)}\n30\n0.0\n`;
    }
    dxf += '0\nSEQEND\n8\nPIEZAS\n';
  }

  dxf += '0\nENDSEC\n';
  dxf += '0\nEOF\n';

  return dxf;
}

/**
 * Descarga un string como archivo.
 */
export function downloadFile(content: string | Blob, filename: string, mimeType: string = 'text/plain') {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exporta el resultado del nesting a PDF (vectorial).
 * Orientación horizontal, unidades en mm.
 */
export function exportToPDF(
  nestedPieces: NestedPiece[],
  paperSize: PaperSize = 'carta',
  filename: string = 'patronaje.pdf'
) {
  const paper = PAPER_DIMENSIONS_MM[paperSize];
  // jsPDF usa mm; landscape: width > height
  const pdf = new jsPDF({
    orientation: paper.width > paper.height ? 'landscape' : 'landscape',
    unit: 'mm',
    format: [paper.width, paper.height],
  });

  // Dibujar piezas como líneas negras
  pdf.setDrawColor(0, 0, 0);
  pdf.setLineWidth(0.2);

  for (const np of nestedPieces) {
    const { piece, offsetX, offsetY } = np;
    const pts: [number, number][] = piece.points.map(p => [p.x + offsetX, paper.height - (p.y + offsetY)]);

    if (pts.length > 0) {
      pdf.lines(
        pts.map((p, i) => i === 0 ? [p[0] - pts[0][0], p[1] - pts[0][1]] : [p[0] - pts[i-1][0], p[1] - pts[i-1][1]]),
        pts[0][0],
        pts[0][1],
        [1, 1],
        'D'
      );
    }
  }

  pdf.save(filename);
}
