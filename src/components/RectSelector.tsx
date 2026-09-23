import React, { useEffect, useRef, useState } from 'react';
import { PxRect } from '../modules/ImageLoader';

export interface OverlayRect {
  rect: PxRect;
  color: string;
  label: string;
}

interface Props {
  /** Imagen de trabajo (canvas ya rotado/reducido). */
  source: HTMLCanvasElement;
  /** Rectángulos a dibujar encima (recuadro del molde, número, etc.). */
  overlays: OverlayRect[];
  /** Si hay una herramienta activa, arrastrar sobre la imagen dibuja un rectángulo nuevo. */
  active: boolean;
  activeColor?: string;
  onSelect: (rect: PxRect) => void;
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Muestra la imagen y permite dibujar un rectángulo arrastrando el ratón/dedo.
 * Devuelve el rectángulo en píxeles de la imagen `source`.
 */
const RectSelector: React.FC<Props> = ({ source, overlays, active, activeColor = '#2563eb', onSelect, maxWidth = 760, maxHeight = 640 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  const dw = Math.max(1, Math.round(source.width * scale));
  const dh = Math.max(1, Math.round(source.height * scale));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dw, dh);
    ctx.drawImage(source, 0, 0, dw, dh);

    const drawRect = (r: PxRect, color: string, label: string, dashed: boolean) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      if (dashed) ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x * scale + 0.5, r.y * scale + 0.5, r.w * scale, r.h * scale);
      if (label) {
        ctx.setLineDash([]);
        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(label).width + 8;
        const lx = r.x * scale;
        const ly = Math.max(0, r.y * scale - 18);
        ctx.fillStyle = color;
        ctx.fillRect(lx, ly, tw, 18);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, lx + 4, ly + 13);
      }
      ctx.restore();
    };

    for (const o of overlays) drawRect(o.rect, o.color, o.label, false);
    if (drag) {
      const r = normalize(drag);
      ctx.save();
      ctx.fillStyle = hexToRgba(activeColor, 0.12);
      ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      ctx.restore();
      drawRect(r, activeColor, '', true);
    }
  }, [source, overlays, drag, dw, dh, scale, activeColor]);

  const toSource = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const b = canvas.getBoundingClientRect();
    const x = ((e.clientX - b.left) / b.width) * source.width;
    const y = ((e.clientY - b.top) / b.height) * source.height;
    return {
      x: Math.max(0, Math.min(source.width, x)),
      y: Math.max(0, Math.min(source.height, y)),
    };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return;
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const p = toSource(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active || !drag) return;
    const p = toSource(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active || !drag) return;
    const p = toSource(e);
    const r = normalize({ ...drag, x1: p.x, y1: p.y });
    setDrag(null);
    if (r.w >= 4 && r.h >= 4) {
      onSelect({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    }
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', maxWidth: dw, height: 'auto', display: 'block', cursor: active ? 'crosshair' : 'default', touchAction: active ? 'none' : 'auto', userSelect: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDrag(null)}
    />
  );
};

function normalize(d: { x0: number; y0: number; x1: number; y1: number }): PxRect {
  const x = Math.min(d.x0, d.x1);
  const y = Math.min(d.y0, d.y1);
  return { x, y, w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export default RectSelector;
