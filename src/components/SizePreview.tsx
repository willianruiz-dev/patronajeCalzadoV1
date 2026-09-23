import React, { useEffect, useRef } from 'react';
import { ScaleResult } from '../modules/CorelStyleScaler';
import { SizeLayout, describeLayout } from '../modules/PageLayout';
import { NumberingSettings, TextAngle } from '../modules/PdfExporter';

/**
 * Borra una región (rectángulo blanco) y escribe el número centrado, girado
 * `angle` grados antihorario. Coordenadas en píxeles del canvas destino.
 */
export function drawRegionNumber(
  ctx: CanvasRenderingContext2D,
  text: string,
  sx: number, sy: number, sw: number, sh: number,
  angle: TextAngle,
  padPx: number,
): void {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(sx - padPx, sy - padPx, sw + 2 * padPx, sh + 2 * padPx);
  const vertical = angle === 90 || angle === 270;
  const capPx = (vertical ? sw : sh) * 0.85;
  const maxW = (vertical ? sh : sw) * 0.95 + 2 * padPx;
  let px = capPx / 0.716;
  ctx.font = `bold ${px}px Helvetica, Arial, sans-serif`;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) { px *= maxW / tw; ctx.font = `bold ${px}px Helvetica, Arial, sans-serif`; }
  ctx.translate(sx + sw / 2, sy + sh / 2);
  ctx.rotate(-(angle * Math.PI) / 180);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

interface Props {
  crop: HTMLCanvasElement;
  escala: ScaleResult;
  layout: SizeLayout;
  numbering: NumberingSettings;
  maxW?: number;
  maxH?: number;
}

const TILE_COLORS = ['rgba(37,99,235,0.10)', 'rgba(234,88,12,0.10)', 'rgba(22,163,74,0.10)', 'rgba(147,51,234,0.10)'];
const TILE_BORDERS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea'];

/**
 * Vista previa de una talla: el molde ya escalado (Stretch) con la
 * cuadrícula de hojas superpuesta y el número de talla donde quedará.
 */
const SizePreview: React.FC<Props> = ({ crop, escala, layout, numbering, maxW = 240, maxH = 300 }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const k = Math.min(maxW / layout.moldeW, maxH / layout.moldeH); // px por mm
    const w = Math.max(1, Math.round(layout.moldeW * k));
    const h = Math.max(1, Math.round(layout.moldeH * k));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(crop, 0, 0, w, h);

    // Número de talla
    if (numbering.mode === 'molde') {
      const text = String(layout.size);
      ctx.save();
      if (numbering.handwrittenRegionsMM.length > 0) {
        for (const r of numbering.handwrittenRegionsMM) {
          const sx = r.x * escala.factorAncho * k, sy = r.y * escala.factorLargo * k;
          const sw = r.w * escala.factorAncho * k, sh = r.h * escala.factorLargo * k;
          drawRegionNumber(ctx, text, sx, sy, sw, sh, r.angle, 2);
        }
      } else {
        const hmm = Math.max(3, numbering.stampHeightMM);
        const px = hmm * k / 0.716;
        ctx.font = `bold ${px}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(text).width;
        const inset = 3 * k;
        let x: number, y: number;
        switch (numbering.corner) {
          case 'arriba-der': x = w - inset - tw; y = inset + hmm * k / 2; break;
          case 'abajo-izq': x = inset; y = h - inset - hmm * k / 2; break;
          case 'abajo-der': x = w - inset - tw; y = h - inset - hmm * k / 2; break;
          default: x = inset; y = inset + hmm * k / 2;
        }
        ctx.lineWidth = Math.max(2, px * 0.12);
        ctx.strokeStyle = '#fff';
        ctx.strokeText(text, x, y);
        ctx.fillStyle = '#000';
        ctx.fillText(text, x, y);
      }
      ctx.restore();
    }

    // Cuadrícula de hojas
    const n = layout.tiles.length;
    layout.tiles.forEach((t, i) => {
      const x = t.src.x * k, y = t.src.y * k, tw = t.src.w * k, th = t.src.h * k;
      const ci = (t.row + t.col) % TILE_COLORS.length;
      if (n > 1) {
        ctx.fillStyle = TILE_COLORS[ci];
        ctx.fillRect(x, y, tw, th);
      }
      ctx.save();
      ctx.strokeStyle = n > 1 ? TILE_BORDERS[ci] : '#94a3b8';
      ctx.lineWidth = 1.5;
      ctx.setLineDash(n > 1 ? [5, 3] : []);
      ctx.strokeRect(x + 0.75, y + 0.75, Math.max(0, tw - 1.5), Math.max(0, th - 1.5));
      ctx.restore();
      if (n > 1) {
        const label = `Hoja ${t.index}`;
        ctx.font = 'bold 11px sans-serif';
        const lw = ctx.measureText(label).width + 8;
        // Etiqueta en una esquina que no se pise con la vecina
        const lx = t.hasLeft ? x + tw - lw - 4 : x + 4;
        const ly = t.hasTop ? y + th - 20 : y + 4;
        ctx.fillStyle = TILE_BORDERS[ci];
        ctx.fillRect(lx, ly, lw, 16);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, lx + 4, ly + 12);
      }
    });
  }, [crop, escala, layout, numbering, maxW, maxH]);

  const n = layout.tiles.length;
  return (
    <div className="preview-card">
      <div className="preview-card-title">Talla {layout.size}</div>
      <div className="preview-card-canvas"><canvas ref={ref} /></div>
      <div className="piece-info">
        {layout.moldeW.toFixed(1)} × {layout.moldeH.toFixed(1)} mm<br />
        <span className={n > 1 ? 'pill warn' : 'pill ok'}>{describeLayout(layout)}</span>
      </div>
    </div>
  );
};

export default SizePreview;
