/**
 * Exportación a PDF listo para imprimir.
 *
 * A diferencia de "todas las tallas en una hoja gigante" (que ninguna
 * impresora acepta), aquí cada talla sale en su(s) propia(s) hoja(s) de un
 * tamaño real (Carta, Oficio, A4, A3...) y, si el molde no cabe, se parte en
 * varias hojas con solape y cruces de registro para pegarlas.
 *
 * Además cada hoja queda ENUMERADA automáticamente:
 *   - Encabezado grande: "TALLA 38", hoja n de N, mini-mapa de la cuadrícula.
 *   - Número estampado sobre el molde (opcional) y, si el usuario marcó el
 *     número escrito a mano del molde base, ese número se borra y se escribe
 *     la talla correcta en el mismo sitio de cada copia.
 *   - Barra de control de 100 mm para verificar que la impresora no re-escaló.
 *
 * Todo en mm. El recorte del molde base se incrusta UNA sola vez en el PDF
 * (alias) y se dibuja en cada hoja con el Stretch de la talla correspondiente.
 */

import { jsPDF } from 'jspdf';
import { Mode, ScaleResult } from './CorelStyleScaler';
import { PAPERS } from './ScannerConfig';
import { FOOTER_MM, HEADER_MM, Rect, SizeLayout, Tile } from './PageLayout';

export type NumberingMode = 'molde' | 'hoja';
export type StampCorner = 'arriba-izq' | 'arriba-der' | 'abajo-izq' | 'abajo-der';

export type TextAngle = 0 | 90 | 180 | 270;

/**
 * Región de un número escrito a mano en el molde BASE, en mm relativos a la
 * esquina superior izquierda del recuadro del molde. `angle` es la
 * orientación del texto (grados en sentido antihorario; 90 = se lee de abajo
 * hacia arriba).
 */
export interface NumberRegion extends Rect {
  angle: TextAngle;
}

export interface NumberingSettings {
  /** 'molde': encabezado + número sobre el molde. 'hoja': sólo encabezado. */
  mode: NumberingMode;
  /** Esquina del recuadro del molde donde estampar el número si no hay regiones marcadas. */
  corner: StampCorner;
  /** Altura del número estampado (mm) cuando no hay regiones marcadas. */
  stampHeightMM: number;
  /**
   * Números escritos a mano en el molde base (uno por pieza, los que haga
   * falta). Cada uno se borra (rectángulo blanco) y se escribe la talla
   * correcta en ese mismo lugar, escalado junto con el molde.
   */
  handwrittenRegionsMM: NumberRegion[];
}

export const DEFAULT_NUMBERING: NumberingSettings = {
  mode: 'molde',
  corner: 'arriba-izq',
  stampHeightMM: 10,
  handwrittenRegionsMM: [],
};

export interface ExportJob {
  /** Bytes de la imagen del recorte del molde base (JPEG o PNG). */
  imageBytes: Uint8Array;
  imageFormat: 'JPEG' | 'PNG';
  baseWidthMM: number;
  baseHeightMM: number;
  tallaBase: number;
  mode: Mode;
  escalas: ScaleResult[];
  layouts: SizeLayout[];
  numbering: NumberingSettings;
  marginMM: number;
  /** Nombre del modelo/archivo para el pie de página (opcional). */
  title?: string;
}

const IMAGE_ALIAS = 'molde-base';
const CAP_HEIGHT_EM = 0.716; // altura de mayúsculas/dígitos de Helvetica Bold
const PT_PER_MM = 72 / 25.4;

function fontSizePtForCapHeight(capMM: number): number {
  return (capMM / CAP_HEIGHT_EM) * PT_PER_MM;
}

/**
 * Escribe un texto centrado en (cx, cy) con altura de mayúsculas `capMM`,
 * reduciéndolo si no cabe en `maxWidthMM`. Con halo blanco opcional para
 * que se lea encima de las líneas del dibujo.
 */
function stampText(
  doc: jsPDF,
  text: string,
  cx: number,
  cy: number,
  capMM: number,
  maxWidthMM: number | null,
  halo: boolean,
): void {
  doc.setFont('helvetica', 'bold');
  let pt = fontSizePtForCapHeight(capMM);
  doc.setFontSize(pt);
  if (maxWidthMM && maxWidthMM > 0) {
    const w = doc.getTextWidth(text);
    if (w > maxWidthMM) {
      pt = pt * (maxWidthMM / w);
      doc.setFontSize(pt);
      capMM = capMM * (maxWidthMM / w);
    }
  }
  const baseline = cy + capMM / 2;
  if (halo) {
    doc.setDrawColor(255, 255, 255);
    doc.setLineWidth(Math.max(0.5, capMM * 0.09));
    doc.text(text, cx, baseline, { align: 'center', renderingMode: 'stroke' });
  }
  doc.setTextColor(0, 0, 0);
  doc.text(text, cx, baseline, { align: 'center', renderingMode: 'fill' });
}

/**
 * Igual que stampText pero con el texto girado `angle` grados (antihorario),
 * centrado en (cx, cy). Sin halo (se usa sobre un rectángulo blanco).
 */
function stampTextRotated(
  doc: jsPDF,
  text: string,
  cx: number,
  cy: number,
  capMM: number,
  maxWidthMM: number,
  angle: TextAngle,
): void {
  doc.setFont('helvetica', 'bold');
  let pt = fontSizePtForCapHeight(capMM);
  doc.setFontSize(pt);
  let tw = doc.getTextWidth(text);
  if (maxWidthMM > 0 && tw > maxWidthMM) {
    const f = maxWidthMM / tw;
    pt *= f;
    capMM *= f;
    doc.setFontSize(pt);
    tw = doc.getTextWidth(text);
  }
  const th = (angle * Math.PI) / 180;
  // u = dirección de escritura, v = "arriba" del texto (coords de página, y hacia abajo)
  const ux = Math.cos(th), uy = -Math.sin(th);
  const vx = -Math.sin(th), vy = -Math.cos(th);
  const sx = cx - vx * (capMM / 2) - ux * (tw / 2);
  const sy = cy - vy * (capMM / 2) - uy * (tw / 2);
  doc.setTextColor(0, 0, 0);
  doc.text(text, sx, sy, { angle, renderingMode: 'fill' });
}

function drawCross(doc: jsPDF, x: number, y: number): void {
  doc.setDrawColor(60, 60, 60);
  doc.setLineWidth(0.2);
  doc.setLineDashPattern([], 0);
  doc.circle(x, y, 3, 'S');
  doc.line(x - 5, y, x + 5, y);
  doc.line(x, y - 5, x, y + 5);
}

function drawMiniMap(doc: jsPDF, layout: SizeLayout, tile: Tile, x0: number, top: number, maxW: number): void {
  const n = layout.rows * layout.cols;
  if (n <= 1) return;
  const cell = Math.min(3.2, maxW / layout.cols, 10 / layout.rows);
  doc.setLineWidth(0.15);
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const current = r === tile.row && c === tile.col;
      doc.setDrawColor(90, 90, 90);
      if (current) {
        doc.setFillColor(30, 30, 30);
        doc.rect(x0 + c * cell, top + r * cell, cell, cell, 'FD');
      } else {
        doc.rect(x0 + c * cell, top + r * cell, cell, cell, 'S');
      }
    }
  }
}

function modeLabel(mode: Mode): string {
  return mode === 'plantilla' ? 'PLANTILLA (+4.18 / +8.34 mm por talla)' : 'MOLDE (+3.33 / +6.67 mm por talla)';
}

function drawHeader(doc: jsPDF, job: ExportJob, layout: SizeLayout, tile: Tile, escala: ScaleResult): void {
  const m = job.marginMM;
  const { area, pageW } = layout;
  const total = layout.rows * layout.cols;

  // Talla en grande, a la izquierda
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(fontSizePtForCapHeight(7));
  const tallaTxt = `TALLA ${layout.size}`;
  doc.text(tallaTxt, area.x, m + 8.5);
  const tallaW = doc.getTextWidth(tallaTxt);

  // Mini-mapa de hojas justo al lado de la talla
  drawMiniMap(doc, layout, tile, area.x + tallaW + 5, m + 1.5, 45);

  // Bloque derecho: hoja n de N + detalle
  doc.setFontSize(fontSizePtForCapHeight(3.2));
  const hojaTxt = total === 1
    ? 'Hoja 1 de 1'
    : `Hoja ${tile.index} de ${total}  (fila ${tile.row + 1} / columna ${tile.col + 1})`;
  doc.text(hojaTxt, pageW - m, m + 4.2, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(fontSizePtForCapHeight(1.9));
  doc.setTextColor(70, 70, 70);
  const dif = escala.size - job.tallaBase;
  const line2 = `${modeLabel(job.mode)} · base ${job.tallaBase} · dif ${dif >= 0 ? '+' : ''}${dif}`;
  doc.text(line2, pageW - m, m + 8.6, { align: 'right' });
  const paperTxt = layout.paper === 'plotter'
    ? `hoja a medida ${layout.pageW.toFixed(0)} × ${layout.pageH.toFixed(0)} mm`
    : `${PAPERS[layout.paper].name.split(' (')[0]} ${layout.landscape ? 'horizontal' : 'vertical'}`;
  const line3 = `molde ${layout.moldeW.toFixed(1)} × ${layout.moldeH.toFixed(1)} mm · ${paperTxt} · fA ${escala.factorAncho.toFixed(4)} · fL ${escala.factorLargo.toFixed(4)}`;
  doc.text(line3, pageW - m, m + 12, { align: 'right' });

  // Separador
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.line(area.x, m + HEADER_MM - 0.8, area.x + area.w, m + HEADER_MM - 0.8);
}

function drawFooter(doc: jsPDF, job: ExportJob, layout: SizeLayout, tile: Tile): void {
  const m = job.marginMM;
  const { area, pageH, pageW } = layout;
  const yTop = pageH - m - FOOTER_MM + 1;
  const barY = yTop + 2.5;
  const textX = area.x + 106;
  const textW = Math.max(40, area.w - 106);

  // Barra de control de 100 mm
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.setLineDashPattern([], 0);
  doc.line(area.x, barY, area.x + 100, barY);
  for (let t = 0; t <= 100; t += 10) {
    const h = t % 50 === 0 ? 2.5 : 1.3;
    doc.line(area.x + t, barY - h, area.x + t, barY);
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(fontSizePtForCapHeight(1.7));
  doc.setTextColor(0, 0, 0);
  doc.text('0', area.x, barY + 2.6, { align: 'center' });
  doc.text('50', area.x + 50, barY + 2.6, { align: 'center' });
  doc.text('100 mm', area.x + 100, barY + 2.6, { align: 'center' });

  // Nota de control (a la derecha de la barra)
  doc.setTextColor(60, 60, 60);
  doc.setFontSize(fontSizePtForCapHeight(1.6));
  const nota = doc.splitTextToSize('La barra debe medir 100 mm: imprima al 100 % (tamaño real), SIN "ajustar a la página".', textW) as string[];
  doc.text(nota[0], textX, barY - 0.4);

  // Instrucción de montaje (sólo si la talla ocupa varias hojas)
  const total = layout.rows * layout.cols;
  if (total > 1) {
    const partes: string[] = [];
    if (tile.hasLeft) partes.push('IZQUIERDO');
    if (tile.hasTop) partes.push('SUPERIOR');
    const montaje = partes.length
      ? `Montaje: recorte el margen ${partes.join(' y ')} de esta hoja por la línea gris fina y péguela sobre la hoja vecina haciendo coincidir las cruces de registro.`
      : 'Montaje: esta hoja va debajo; las hojas vecinas se recortan y se pegan encima alineando las cruces de registro.';
    doc.setFontSize(fontSizePtForCapHeight(1.5));
    const lines = (doc.splitTextToSize(montaje, textW) as string[]).slice(0, 2);
    lines.forEach((ln, i) => doc.text(ln, textX, barY + 2.4 + i * 2.3));
  }

  // Pie derecho
  doc.setFontSize(fontSizePtForCapHeight(1.4));
  doc.setTextColor(130, 130, 130);
  const pie = `${job.title ? job.title + ' · ' : ''}Escalado Calzado · ${new Date().toLocaleDateString('es-CO')}`;
  doc.text(pie, pageW - m, barY + 7.3, { align: 'right' });
}

/**
 * Dibuja el número de talla sobre el molde (en coordenadas de página ya
 * transformadas). `ox, oy` = posición en la hoja del origen del molde.
 */
function drawStamp(doc: jsPDF, job: ExportJob, layout: SizeLayout, escala: ScaleResult, ox: number, oy: number): void {
  const num = job.numbering;
  if (num.mode !== 'molde') return;
  const text = String(layout.size);

  if (num.handwrittenRegionsMM.length > 0) {
    for (const r of num.handwrittenRegionsMM) {
      // Escalamos la región junto con el molde (mismo Stretch)
      const sx = r.x * escala.factorAncho;
      const sy = r.y * escala.factorLargo;
      const sw = r.w * escala.factorAncho;
      const sh = r.h * escala.factorLargo;
      const pad = 1.0;
      doc.setFillColor(255, 255, 255);
      doc.rect(ox + sx - pad, oy + sy - pad, sw + 2 * pad, sh + 2 * pad, 'F');
      const vertical = r.angle === 90 || r.angle === 270;
      const capMM = Math.max(3, (vertical ? sw : sh) * 0.85);
      const maxW = (vertical ? sh : sw) * 0.95 + 2 * pad;
      stampTextRotated(doc, text, ox + sx + sw / 2, oy + sy + sh / 2, capMM, maxW, r.angle);
    }
    return;
  }

  const h = Math.max(3, num.stampHeightMM);
  const inset = 3;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(fontSizePtForCapHeight(h));
  const tw = doc.getTextWidth(text);
  let cx: number, cy: number;
  switch (num.corner) {
    case 'arriba-der': cx = ox + layout.moldeW - inset - tw / 2; cy = oy + inset + h / 2; break;
    case 'abajo-izq': cx = ox + inset + tw / 2; cy = oy + layout.moldeH - inset - h / 2; break;
    case 'abajo-der': cx = ox + layout.moldeW - inset - tw / 2; cy = oy + layout.moldeH - inset - h / 2; break;
    case 'arriba-izq':
    default: cx = ox + inset + tw / 2; cy = oy + inset + h / 2; break;
  }
  stampText(doc, text, cx, cy, h, null, true);
}

function drawTilePage(doc: jsPDF, job: ExportJob, layout: SizeLayout, tile: Tile, escala: ScaleResult): void {
  const { area } = layout;
  const ov = layout.overlapMM;
  const ox = tile.dstX - tile.src.x; // origen del molde en coords de hoja
  const oy = tile.dstY - tile.src.y;

  drawHeader(doc, job, layout, tile, escala);

  // Línea gris fina = límite del área de dibujo (línea de corte para el montaje)
  doc.setDrawColor(190, 190, 190);
  doc.setLineWidth(0.12);
  doc.setLineDashPattern([], 0);
  doc.rect(area.x, area.y, area.w, area.h, 'S');

  // --- Todo lo que sigue va recortado al área de dibujo ---
  doc.saveGraphicsState();
  doc.rect(area.x, area.y, area.w, area.h, null);
  doc.clip();
  doc.discardPath();

  // Imagen del molde con el Stretch de la talla (misma imagen, alias compartido)
  doc.addImage(job.imageBytes, job.imageFormat, ox, oy, layout.moldeW, layout.moldeH, IMAGE_ALIAS, 'FAST');

  // Número de talla sobre el molde
  drawStamp(doc, job, layout, escala, ox, oy);

  // Cruces de registro en coordenadas del MOLDE: caen en el mismo punto del
  // dibujo en las dos hojas vecinas, así que al alinearlas coincide todo.
  if (ov > 0) {
    const s = tile.src;
    const ys = [s.y + 12, s.y + s.h / 2, s.y + s.h - 12].filter(y => y > s.y + 4 && y < s.y + s.h - 4);
    const xs = [s.x + 12, s.x + s.w / 2, s.x + s.w - 12].filter(x => x > s.x + 4 && x < s.x + s.w - 4);
    if (tile.hasRight) for (const y of ys) drawCross(doc, ox + s.x + s.w - ov / 2, oy + y);
    if (tile.hasLeft) for (const y of ys) drawCross(doc, ox + s.x + ov / 2, oy + y);
    if (tile.hasBottom) for (const x of xs) drawCross(doc, ox + x, oy + s.y + s.h - ov / 2);
    if (tile.hasTop) for (const x of xs) drawCross(doc, ox + x, oy + s.y + ov / 2);
  }

  // Líneas punteadas que delimitan las franjas de solape
  if (ov > 0) {
    doc.setDrawColor(120, 120, 120);
    doc.setLineWidth(0.2);
    doc.setLineDashPattern([2, 1.5], 0);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fontSizePtForCapHeight(1.8));
    doc.setTextColor(110, 110, 110);
    if (tile.hasRight) {
      const x = area.x + area.w - ov;
      doc.line(x, area.y, x, area.y + area.h);
      doc.text(`solape ${ov.toFixed(0)} mm · continúa en hoja ${tile.index + 1}`, x - 1, area.y + area.h - 3, { angle: 90 });
    }
    if (tile.hasLeft) {
      const x = area.x + ov;
      doc.line(x, area.y, x, area.y + area.h);
      doc.text(`solape ${ov.toFixed(0)} mm · viene de hoja ${tile.index - 1}`, x + 2.8, area.y + area.h - 3, { angle: 90 });
    }
    if (tile.hasBottom) {
      const y = area.y + area.h - ov;
      doc.line(area.x, y, area.x + area.w, y);
      doc.text(`solape ${ov.toFixed(0)} mm · continúa en hoja ${tile.index + layout.cols}`, area.x + 3, y - 1);
    }
    if (tile.hasTop) {
      const y = area.y + ov;
      doc.line(area.x, y, area.x + area.w, y);
      doc.text(`solape ${ov.toFixed(0)} mm · viene de hoja ${tile.index - layout.cols}`, area.x + 3, y + 2.8);
    }
    doc.setLineDashPattern([], 0);
  }

  doc.restoreGraphicsState();

  drawFooter(doc, job, layout, tile);
}

export interface BuildResult {
  doc: jsPDF;
  pages: number;
}

/**
 * PDF multipágina: cada talla en su(s) hoja(s).
 */
export function buildMultiPagePdf(job: ExportJob): BuildResult {
  if (job.layouts.length === 0) throw new Error('No hay tallas para exportar.');
  const first = job.layouts[0];
  const doc = new jsPDF({
    unit: 'mm',
    format: [first.pageW, first.pageH],
    orientation: first.pageW > first.pageH ? 'landscape' : 'portrait',
    compress: true,
  });
  let pages = 0;
  for (const layout of job.layouts) {
    const escala = job.escalas.find(e => e.size === layout.size);
    if (!escala) continue;
    for (const tile of layout.tiles) {
      if (pages > 0) doc.addPage([layout.pageW, layout.pageH], layout.pageW > layout.pageH ? 'landscape' : 'portrait');
      drawTilePage(doc, job, layout, tile, escala);
      pages++;
    }
  }
  doc.setProperties({ title: `Escalado tallas ${job.layouts[0].size}-${job.layouts[job.layouts.length - 1].size}`, creator: 'Escalado Calzado' });
  return { doc, pages };
}

/**
 * Variante para plotter/rollo: TODAS las tallas en una sola hoja a medida,
 * en fila y con 25 mm de separación (comportamiento de la macro de Corel).
 * Cada talla lleva su número debajo y, si aplica, estampado sobre el molde.
 */
export function buildAllInOneSheetPdf(job: ExportJob, gapMM = 25): BuildResult {
  const m = job.marginMM;
  const escalas = job.escalas;
  if (escalas.length === 0) throw new Error('No hay tallas para exportar.');
  const totalW = escalas.reduce((acc, e) => acc + e.newWidthMM, 0) + gapMM * (escalas.length - 1);
  const maxH = Math.max(...escalas.map(e => e.newHeightMM));
  const labelH = 14;
  const pageW = totalW + 2 * m;
  const pageH = maxH + 2 * m + HEADER_MM + labelH;
  const doc = new jsPDF({ unit: 'mm', format: [pageW, pageH], orientation: pageW > pageH ? 'landscape' : 'portrait', compress: true });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(fontSizePtForCapHeight(5));
  doc.setTextColor(0, 0, 0);
  doc.text(`ESCALADO ${modeLabel(job.mode)} · base ${job.tallaBase} · tallas ${escalas[0].size} a ${escalas[escalas.length - 1].size} · hoja a medida ${pageW.toFixed(0)} × ${pageH.toFixed(0)} mm (plotter)`, m, m + 6);

  let x = m;
  const y = m + HEADER_MM;
  for (const e of escalas) {
    const layout: SizeLayout = {
      size: e.size, moldeW: e.newWidthMM, moldeH: e.newHeightMM, pageW, pageH, landscape: pageW > pageH,
      area: { x, y, w: e.newWidthMM, h: e.newHeightMM }, rows: 1, cols: 1, tiles: [], overlapMM: 0, paper: 'plotter',
    };
    doc.addImage(job.imageBytes, job.imageFormat, x, y, e.newWidthMM, e.newHeightMM, IMAGE_ALIAS, 'FAST');
    drawStamp(doc, job, layout, e, x, y);
    // Etiqueta debajo de cada talla
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(fontSizePtForCapHeight(6));
    doc.setTextColor(0, 0, 0);
    doc.text(`TALLA ${e.size}`, x + e.newWidthMM / 2, y + maxH + 8, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fontSizePtForCapHeight(2));
    doc.setTextColor(80, 80, 80);
    doc.text(`${e.newWidthMM.toFixed(1)} × ${e.newHeightMM.toFixed(1)} mm`, x + e.newWidthMM / 2, y + maxH + 12, { align: 'center' });
    x += e.newWidthMM + gapMM;
  }
  return { doc, pages: 1 };
}

/** Convierte un data URL (base64) en bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
