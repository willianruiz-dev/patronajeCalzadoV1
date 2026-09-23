import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RectSelector, { OverlayRect } from './components/RectSelector';
import SizePreview, { drawRegionNumber } from './components/SizePreview';
import {
  PxRect,
  createCropCanvas,
  createWorkCanvas,
  detectarBoundingBoxTinta,
  detectarNumerosEscritos,
  loadImageFromFile,
} from './modules/ImageLoader';
import { BoundingBoxMM, Mode, ScaleResult, generarEscalas, incrementos } from './modules/CorelStyleScaler';
import { DPI, PAPERS, PaperSize } from './modules/ScannerConfig';
import {
  DEFAULT_PRINT_SETTINGS,
  Orientation,
  PrintSettings,
  SizeLayout,
  describeLayout,
  layoutSize,
  totalPages,
} from './modules/PageLayout';
import {
  DEFAULT_NUMBERING,
  ExportJob,
  NumberRegion,
  NumberingMode,
  NumberingSettings,
  StampCorner,
  TextAngle,
  buildAllInOneSheetPdf,
  buildMultiPagePdf,
  dataUrlToBytes,
} from './modules/PdfExporter';

type Tool = 'crop' | 'number' | null;

/**
 * Sobre qué medidas se aplican los +3.33 / +6.67 mm por talla:
 *  - 'hoja':     la hoja escaneada completa (el molde completo ocupa la hoja).
 *  - 'manual':   medidas del molde completo que indica el usuario.
 *  - 'recuadro': el recuadro detectado (sólo si lo escaneado ES el molde completo).
 */
type RefMode = 'hoja' | 'manual' | 'recuadro';

/** Número escrito a mano marcado sobre la imagen de trabajo (px) + orientación del texto. */
interface NumMark extends PxRect {
  angle: TextAngle;
}

const ANGLE_LABELS: Record<TextAngle, string> = {
  0: 'Horizontal',
  90: 'Girado 90° (se lee de abajo a arriba)',
  180: 'Al revés (180°)',
  270: 'Girado 270° (se lee de arriba a abajo)',
};

/** Miniatura de una región de la imagen de trabajo (p. ej. el número marcado). */
const RegionThumb: React.FC<{ source: HTMLCanvasElement; rect: PxRect }> = ({ source, rect }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = Math.min(1, 64 / rect.h, 120 / rect.w);
    c.width = Math.max(1, Math.round(rect.w * k));
    c.height = Math.max(1, Math.round(rect.h * k));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  }, [source, rect]);
  return <canvas ref={ref} style={{ border: '2px solid #dc2626', borderRadius: 4, flex: '0 0 auto' }} />;
};

const App: React.FC = () => {
  // --- Entrada ---
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [dpi, setDpi] = useState<DPI>(300);
  const [mode, setMode] = useState<Mode>('molde');
  const [rotated, setRotated] = useState(false);

  // --- Recorte / número ---
  const [cropRect, setCropRect] = useState<PxRect | null>(null);
  const [numMarks, setNumMarks] = useState<NumMark[]>([]);
  const [tool, setTool] = useState<Tool>(null);

  // --- Tallas ---
  const [tallaBaseTxt, setTallaBaseTxt] = useState('36');
  const [refMode, setRefMode] = useState<RefMode>('hoja');
  const [refManual, setRefManual] = useState<{ widthMM: string; heightMM: string }>({ widthMM: '216', heightMM: '280' });
  const [tallaMenor, setTallaMenor] = useState(34);
  const [tallaMayor, setTallaMayor] = useState(40);
  const [generated, setGenerated] = useState(false);

  // --- Numeración e impresión ---
  const [numbering, setNumbering] = useState<NumberingSettings>(DEFAULT_NUMBERING);
  const [print, setPrint] = useState<PrintSettings>(DEFAULT_PRINT_SETTINGS);
  const [whiten, setWhiten] = useState(true);

  // --- UI ---
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const logEvent = useCallback((line: string) => setEventLog(l => [...l, line]), []);

  // Canvas de trabajo (imagen rotada y reducida)
  const work = useMemo(() => (image ? createWorkCanvas(image, rotated) : null), [image, rotated]);
  const mmPerPxWork = work ? (25.4 / dpi) / work.scale : 0;

  // Carga de archivo
  const handleFile = async (file: File) => {
    try {
      setBusy('Cargando imagen...');
      setError(null);
      setMessage(null);
      setGenerated(false);
      setCropRect(null);
      setNumMarks([]);
      setTool(null);
      setRotated(false);
      const img = await loadImageFromFile(file);
      setImage(img);
      setFileName(file.name.replace(/\.[^.]+$/, ''));
      setEventLog(['=== LOG DE ESCALADO (estilo CorelDRAW) ===', `Imagen cargada: ${img.naturalWidth}×${img.naturalHeight}px (${file.name})`]);
    } catch {
      setError('No se pudo cargar la imagen. Usa JPG o PNG.');
    } finally {
      setBusy(null);
    }
  };

  const cargarEjemplo = async () => {
    try {
      setBusy('Cargando imagen de ejemplo...');
      const res = await fetch(`${import.meta.env.BASE_URL}ejemplo_molde.jpg`);
      const blob = await res.blob();
      await handleFile(new File([blob], 'ejemplo_molde.jpg', { type: 'image/jpeg' }));
    } catch {
      setError('No se pudo cargar la imagen de ejemplo.');
      setBusy(null);
    }
  };

  // Detección automática del recuadro del molde
  const detectar = useCallback(() => {
    if (!work) return;
    const ctx = work.canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, work.canvas.width, work.canvas.height);
    const det = detectarBoundingBoxTinta(data);
    if (!det.bbox) {
      setError('No se detectó tinta en la imagen. Prueba con un escaneo más contrastado o dibuja el recuadro a mano.');
      setCropRect({ x: 0, y: 0, w: work.canvas.width, h: work.canvas.height });
      return;
    }
    setError(null);
    setCropRect(det.bbox);
    const ox = Math.round(det.bbox.x / work.scale), oy = Math.round(det.bbox.y / work.scale);
    const ow = Math.round(det.bbox.w / work.scale), oh = Math.round(det.bbox.h / work.scale);
    const trimmedTxt = Object.values(det.trimmed).some(v => v > 0)
      ? ` (bordes oscuros del escáner descartados: izq ${det.trimmed.left}px, arr ${det.trimmed.top}px, der ${det.trimmed.right}px, aba ${det.trimmed.bottom}px)`
      : '';
    logEvent(`BoundingBox detectado (px): x=${ox}, y=${oy}, w=${ow}, h=${oh} · umbral=${det.threshold}${trimmedTxt}`);
    logEvent(`mmPorPixel (dpi=${dpi}): ${(25.4 / dpi).toFixed(5)}`);
    logEvent(`BoundingBox en mm: ancho=${(ow * 25.4 / dpi).toFixed(2)}mm, alto=${(oh * 25.4 / dpi).toFixed(2)}mm`);

    // Números de talla escritos en el molde: se detectan solos para re-enumerarlos
    const mmPerPxW = (25.4 / dpi) / work.scale;
    const found = detectarNumerosEscritos(data, det.bbox, mmPerPxW);
    setNumMarks(found.map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h, angle: f.angle })));
    logEvent(found.length > 0
      ? `Números escritos detectados: ${found.length} (${found.map(f => `${(f.w * mmPerPxW).toFixed(0)}×${(f.h * mmPerPxW).toFixed(0)} mm${f.angle ? ' girado' : ''}`).join(', ')}). Se borrarán y se escribirá la talla nueva en cada copia.`
      : 'Números escritos: ninguno detectado automáticamente. Puedes marcarlos a mano.');
    setMessage(found.length > 0
      ? `Recuadro del molde detectado y ${found.length} número(s) escrito(s) encontrado(s) (recuadros rojos). Revísalos, ingresa las tallas y genera.`
      : 'Recuadro del molde detectado. No se encontraron números escritos: márcalos a mano si quieres re-enumerar cada pieza.');
  }, [work, dpi, logEvent]);

  const detectarNumeros = () => {
    if (!work || !cropRect) return;
    const ctx = work.canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, work.canvas.width, work.canvas.height);
    const mmPerPxW = (25.4 / dpi) / work.scale;
    const found = detectarNumerosEscritos(data, cropRect, mmPerPxW);
    setNumMarks(found.map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h, angle: f.angle })));
    setNumbering(n => ({ ...n, mode: 'molde' }));
    setMessage(found.length > 0 ? `Se encontraron ${found.length} número(s) escrito(s).` : 'No se encontraron números escritos dentro del recuadro. Márcalos a mano arrastrando.');
    logEvent(`Detección de números repetida: ${found.length} encontrado(s)`);
  };

  useEffect(() => {
    if (!work) return;
    setNumMarks([]);
    setTool(null);
    const t = setTimeout(detectar, 20);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work]);

  // Recorte a resolución de trabajo (para previsualizar)
  const cropWork = useMemo(() => {
    if (!work || !cropRect) return null;
    const c = document.createElement('canvas');
    c.width = Math.max(1, cropRect.w);
    c.height = Math.max(1, cropRect.h);
    c.getContext('2d')!.drawImage(work.canvas, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, c.width, c.height);
    return c;
  }, [work, cropRect]);

  const baseBox: BoundingBoxMM | null = cropRect && work
    ? { widthMM: cropRect.w * mmPerPxWork, heightMM: cropRect.h * mmPerPxWork }
    : null;

  // Hoja escaneada completa en mm (ya rotada si aplica)
  const sheetBox: BoundingBoxMM | null = work
    ? { widthMM: work.canvas.width * mmPerPxWork, heightMM: work.canvas.height * mmPerPxWork }
    : null;

  // Referencia sobre la que se aplican los mm por talla (molde completo)
  const refBox: BoundingBoxMM | null = useMemo(() => {
    if (refMode === 'recuadro') return baseBox;
    if (refMode === 'manual') {
      const w = parseFloat(refManual.widthMM), h = parseFloat(refManual.heightMM);
      return w > 10 && h > 10 ? { widthMM: w, heightMM: h } : null;
    }
    return sheetBox;
  }, [refMode, refManual, baseBox?.widthMM, baseBox?.heightMM, sheetBox?.widthMM, sheetBox?.heightMM]);

  const refLabel = refBox
    ? `${refMode === 'hoja' ? 'hoja completa' : refMode === 'manual' ? 'molde completo (manual)' : 'recuadro detectado'} ${refBox.widthMM.toFixed(1)} × ${refBox.heightMM.toFixed(1)} mm`
    : '';

  // Regiones de los números escritos a mano, en mm relativos al recuadro del molde
  const handwrittenRegionsMM: NumberRegion[] = useMemo(() => {
    if (!cropRect || !work) return [];
    const out: NumberRegion[] = [];
    for (const m of numMarks) {
      const x0 = Math.max(m.x, cropRect.x), y0 = Math.max(m.y, cropRect.y);
      const x1 = Math.min(m.x + m.w, cropRect.x + cropRect.w);
      const y1 = Math.min(m.y + m.h, cropRect.y + cropRect.h);
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      out.push({ x: (x0 - cropRect.x) * mmPerPxWork, y: (y0 - cropRect.y) * mmPerPxWork, w: (x1 - x0) * mmPerPxWork, h: (y1 - y0) * mmPerPxWork, angle: m.angle });
    }
    return out;
  }, [numMarks, cropRect, work, mmPerPxWork]);
  const hasRegions = handwrittenRegionsMM.length > 0;

  const numberingFull: NumberingSettings = useMemo(() => ({ ...numbering, handwrittenRegionsMM }), [numbering, handwrittenRegionsMM]);

  const tallaBase = parseInt(tallaBaseTxt, 10);
  const rangoValido = Number.isFinite(tallaBase) && tallaBase > 0 && tallaMenor <= tallaMayor && tallaMayor - tallaMenor <= 30;

  // Escalas (factores) y paginación: siempre derivadas de los datos actuales
  const escalas: ScaleResult[] = useMemo(() => {
    if (!baseBox || !refBox || !rangoValido) return [];
    return generarEscalas(mode, baseBox, tallaBase, tallaMenor, tallaMayor, 25, refBox);
  }, [baseBox?.widthMM, baseBox?.heightMM, refBox, mode, tallaBase, tallaMenor, tallaMayor, rangoValido]);

  // Crecimiento por talla de lo escaneado con la referencia elegida (para mostrarlo)
  const growthPerSize = baseBox && refBox
    ? { ancho: baseBox.widthMM * incrementos(mode).incAncho / refBox.widthMM, largo: baseBox.heightMM * incrementos(mode).incLargo / refBox.heightMM }
    : null;

  const layouts: SizeLayout[] = useMemo(
    () => escalas.map(e => layoutSize(e.size, e.newWidthMM, e.newHeightMM, print)),
    [escalas, print],
  );
  const nPages = totalPages(layouts);

  // Comparativa de hojas por papel (para elegir bien)
  const comparativa = useMemo(() => {
    const ids: PaperSize[] = ['carta', 'oficio', 'a4', 'a3', 'tabloide'];
    return ids.map(id => ({
      id,
      pages: totalPages(escalas.map(e => layoutSize(e.size, e.newWidthMM, e.newHeightMM, { ...print, paper: id }))),
    }));
  }, [escalas, print]);

  // Log derivado (mismo formato que la macro) + paginación
  const derivedLog = useMemo(() => {
    if (!baseBox || escalas.length === 0) return [];
    const inc = incrementos(mode);
    const lines: string[] = ['', `Modo: ${mode.toUpperCase()}`, `Talla base: ${tallaBase}`, `Rango: ${tallaMenor} → ${tallaMayor}`];
    if (refBox) {
      lines.push(`Referencia del crecimiento (molde completo): ${refLabel}`);
      lines.push(`   factorAncho = (${refBox.widthMM.toFixed(2)} + ${inc.incAncho} × dif) / ${refBox.widthMM.toFixed(2)}   factorLargo = (${refBox.heightMM.toFixed(2)} + ${inc.incLargo} × dif) / ${refBox.heightMM.toFixed(2)}`);
      if (growthPerSize) lines.push(`   Lo escaneado (${baseBox.widthMM.toFixed(2)} × ${baseBox.heightMM.toFixed(2)} mm) crece ${growthPerSize.ancho.toFixed(2)} mm de ancho y ${growthPerSize.largo.toFixed(2)} mm de largo por talla`);
    }
    lines.push('');
    for (const r of escalas) {
      lines.push(`--- Talla ${r.size} (dif=${r.size - tallaBase}) ---`);
      lines.push(`   factorAncho=${r.factorAncho.toFixed(6)}  factorLargo=${r.factorLargo.toFixed(6)}`);
      lines.push(`   ANTES mm: ancho=${baseBox.widthMM.toFixed(2)}  alto=${baseBox.heightMM.toFixed(2)}`);
      lines.push(`   DESPUES mm: ancho=${r.newWidthMM.toFixed(2)}  alto=${r.newHeightMM.toFixed(2)}`);
      lines.push(`   Δ mm: ancho=${r.deltaAnchoMM.toFixed(2)}  alto=${r.deltaLargoMM.toFixed(2)}`);
    }
    lines.push('', 'ESCALADO COMPLETADO', '');
    lines.push(`=== ENUMERACIÓN ===`);
    if (numberingFull.mode === 'hoja') lines.push('Número de talla: sólo en el encabezado de cada hoja');
    else if (hasRegions) {
      lines.push(`Número de talla: encabezado + re-enumeración de ${handwrittenRegionsMM.length} número(s) escrito(s) en el molde:`);
      handwrittenRegionsMM.forEach((r, i) => lines.push(`   Nº ${i + 1}: x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} ${r.w.toFixed(1)}×${r.h.toFixed(1)} mm · ${ANGLE_LABELS[r.angle]} → se borra y se escribe la talla de cada copia`));
    } else lines.push(`Número de talla: encabezado + estampado en la esquina ${numbering.corner} del molde (${numbering.stampHeightMM} mm)`);
    lines.push('', `=== PAGINACIÓN (${PAPERS[print.paper].name}, margen ${print.marginMM} mm, solape ${print.overlapMM} mm) ===`);
    for (const l of layouts) lines.push(`Talla ${l.size}: ${l.moldeW.toFixed(1)}×${l.moldeH.toFixed(1)} mm → ${describeLayout(l)}`);
    lines.push(`TOTAL: ${nPages} hoja(s) en ${escalas.length} talla(s)`);
    return lines;
  }, [baseBox, refBox, refLabel, growthPerSize, escalas, layouts, mode, tallaBase, tallaMenor, tallaMayor, numberingFull, handwrittenRegionsMM, hasRegions, numbering, print, nPages]);

  const fullLog = [...eventLog, ...(generated ? derivedLog : [])];

  const generar = () => {
    if (!baseBox) { setError('Primero carga una imagen y detecta el recuadro del molde.'); return; }
    if (!refBox) { setError('Ingresa medidas válidas del molde completo (ancho y largo en mm).'); return; }
    if (!Number.isFinite(tallaBase) || tallaBase <= 0) { setError('Ingresa una talla base válida.'); return; }
    if (tallaMenor > tallaMayor) { setError('La talla menor no puede ser mayor que la talla mayor.'); return; }
    if (tallaMayor - tallaMenor > 30) { setError('El rango de tallas es demasiado grande.'); return; }
    setError(null);
    setGenerated(true);
    setTool(null);
    setMessage(`Se generaron ${escalas.length} tallas (${tallaMenor} → ${tallaMayor}). Cada talla sale en su propia hoja: ${nPages} hoja(s) en total.`);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  // --- Exportación ---
  const buildJob = (): ExportJob => {
    if (!image || !cropRect || !work || !baseBox) throw new Error('Faltan datos para exportar.');
    const orig: PxRect = {
      x: Math.round(cropRect.x / work.scale),
      y: Math.round(cropRect.y / work.scale),
      w: Math.round(cropRect.w / work.scale),
      h: Math.round(cropRect.h / work.scale),
    };
    const crop = createCropCanvas(image, rotated, orig, 3600, whiten);
    const dataUrl = crop.toDataURL('image/jpeg', 0.85);
    return {
      imageBytes: dataUrlToBytes(dataUrl),
      imageFormat: 'JPEG',
      baseWidthMM: baseBox.widthMM,
      baseHeightMM: baseBox.heightMM,
      tallaBase,
      mode,
      escalas,
      layouts,
      numbering: numberingFull,
      marginMM: print.marginMM,
      title: fileName,
      referenceLabel: refLabel,
    };
  };

  const nombreBase = () => `escalado_${mode}_base${tallaBase}_tallas_${tallaMenor}-${tallaMayor}`;

  const runBusy = (label: string, fn: () => void) => {
    setBusy(label);
    setError(null);
    setTimeout(() => {
      try { fn(); }
      catch (e: any) { setError('Error al exportar: ' + (e?.message || e)); }
      finally { setBusy(null); }
    }, 30);
  };

  const descargarPDF = () => runBusy(`Generando PDF (${nPages} hojas)...`, () => {
    const job = buildJob();
    const { doc, pages } = buildMultiPagePdf(job);
    doc.save(`${nombreBase()}_${print.paper}_${pages}hojas.pdf`);
    logEvent(`PDF generado: ${pages} hojas (${PAPERS[print.paper].name})`);
  });

  const descargarPDFTalla = (e: ScaleResult) => runBusy(`Generando PDF de la talla ${e.size}...`, () => {
    const job = buildJob();
    const layout = layouts.find(l => l.size === e.size);
    if (!layout) return;
    const { doc, pages } = buildMultiPagePdf({ ...job, escalas: [e], layouts: [layout] });
    doc.save(`${nombreBase()}_talla${e.size}_${print.paper}_${pages}hojas.pdf`);
    logEvent(`PDF generado sólo para la talla ${e.size}: ${pages} hoja(s)`);
  });

  const descargarPlotter = () => runBusy('Generando PDF para plotter...', () => {
    const job = buildJob();
    const { doc } = buildAllInOneSheetPdf(job);
    doc.save(`${nombreBase()}_plotter_una_hoja.pdf`);
    logEvent('PDF plotter generado: todas las tallas en una hoja a medida');
  });

  const descargarPNG = (e: ScaleResult) => runBusy(`Generando PNG talla ${e.size}...`, () => {
    if (!image || !cropRect || !work) return;
    const orig: PxRect = {
      x: Math.round(cropRect.x / work.scale), y: Math.round(cropRect.y / work.scale),
      w: Math.round(cropRect.w / work.scale), h: Math.round(cropRect.h / work.scale),
    };
    const crop = createCropCanvas(image, rotated, orig, 3600, whiten);
    const pxPerMM = dpi / 25.4;
    const c = document.createElement('canvas');
    c.width = Math.round(e.newWidthMM * pxPerMM);
    c.height = Math.round(e.newHeightMM * pxPerMM);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(crop, 0, 0, c.width, c.height);
    if (numberingFull.mode === 'molde') {
      const text = String(e.size);
      ctx.fillStyle = '#000';
      if (numberingFull.handwrittenRegionsMM.length > 0) {
        for (const r of numberingFull.handwrittenRegionsMM) {
          const sx = r.x * e.factorAncho * pxPerMM, sy = r.y * e.factorLargo * pxPerMM;
          const sw = r.w * e.factorAncho * pxPerMM, sh = r.h * e.factorLargo * pxPerMM;
          drawRegionNumber(ctx, text, sx, sy, sw, sh, r.angle, pxPerMM);
        }
      } else {
        const px = numberingFull.stampHeightMM * pxPerMM / 0.716;
        ctx.font = `bold ${px}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(text).width;
        const inset = 3 * pxPerMM, hh = numberingFull.stampHeightMM * pxPerMM;
        let x: number, y: number;
        switch (numberingFull.corner) {
          case 'arriba-der': x = c.width - inset - tw; y = inset + hh / 2; break;
          case 'abajo-izq': x = inset; y = c.height - inset - hh / 2; break;
          case 'abajo-der': x = c.width - inset - tw; y = c.height - inset - hh / 2; break;
          default: x = inset; y = inset + hh / 2;
        }
        ctx.lineWidth = px * 0.12;
        ctx.strokeStyle = '#fff';
        ctx.strokeText(text, x, y);
        ctx.fillStyle = '#000';
        ctx.fillText(text, x, y);
      }
    }
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `${nombreBase()}_talla${e.size}_${dpi}dpi.png`;
    a.click();
  });

  const descargarLog = () => {
    const blob = new Blob([fullLog.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `log_escalado_${Date.now()}.txt`;
    a.click();
  };

  const reset = () => {
    setImage(null); setFileName(''); setCropRect(null); setNumMarks([]); setTool(null);
    setGenerated(false); setEventLog([]); setMessage(null); setError(null); setRotated(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Overlays del selector
  const overlays: OverlayRect[] = [];
  if (cropRect) overlays.push({ rect: cropRect, color: '#2563eb', label: baseBox ? `Molde ${baseBox.widthMM.toFixed(1)} × ${baseBox.heightMM.toFixed(1)} mm` : 'Molde' });
  numMarks.forEach((m, i) => overlays.push({ rect: m, color: '#dc2626', label: `Nº ${i + 1}` }));

  const onSelectRect = (r: PxRect) => {
    if (tool === 'crop') {
      setCropRect(r);
      logEvent(`Recuadro ajustado a mano (px): x=${Math.round(r.x / (work?.scale || 1))}, y=${Math.round(r.y / (work?.scale || 1))}, w=${Math.round(r.w / (work?.scale || 1))}, h=${Math.round(r.h / (work?.scale || 1))}`);
      setTool(null);
    } else if (tool === 'number') {
      // Si el rectángulo es más alto que ancho, el número está girado
      const angle: TextAngle = r.h > r.w * 1.25 ? 90 : 0;
      setNumMarks(ms => [...ms, { ...r, angle }]);
      setNumbering(n => ({ ...n, mode: 'molde' }));
      // La herramienta sigue activa para marcar el siguiente número (uno por pieza)
    }
  };

  const setMarkAngle = (i: number, angle: TextAngle) => setNumMarks(ms => ms.map((m, k) => (k === i ? { ...m, angle } : m)));
  const removeMark = (i: number) => setNumMarks(ms => ms.filter((_, k) => k !== i));

  const paperName = (id: PaperSize) => PAPERS[id].name.split(' (')[0];

  return (
    <div className="app-container">
      <h1>👞 Escalado de Calzado (estilo CorelDRAW)</h1>
      <p className="subtitle">
        Réplica web de la macro: Stretch(factorAncho, factorLargo) sobre el molde completo ·
        <strong> cada talla enumerada y en su propia hoja lista para imprimir</strong>
      </p>

      {error && <div className="error-box">{error}</div>}
      {message && !error && <div className="stats-box"><p>{message}</p></div>}
      {busy && <div className="warning-box">⏳ {busy}</div>}

      {/* ============ 1. CARGA ============ */}
      <div className="screen">
        <h2>1. Cargar imagen del molde</h2>
        <div className="grid-3">
          <div className="form-group">
            <label>DPI del escaneo</label>
            <select value={dpi} onChange={e => setDpi(parseInt(e.target.value) as DPI)}>
              <option value={300}>300 DPI</option>
              <option value={600}>600 DPI</option>
            </select>
          </div>
          <div className="form-group">
            <label>Modo</label>
            <select value={mode} onChange={e => setMode(e.target.value as Mode)}>
              <option value="molde">Molde (+3.33 mm ancho / +6.67 mm largo por talla)</option>
              <option value="plantilla">Plantilla (+4.18 mm ancho / +8.34 mm largo por talla)</option>
            </select>
          </div>
          <div className="form-group">
            <label>Orientación</label>
            <div className="hint">El eje LARGO (talón → punta, +6.67 mm/talla) es el <b>vertical</b> de la imagen. Si tu molde está acostado, usa “Rotar 90°”.</div>
          </div>
        </div>

        <div
          className="file-input-area"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
          onDragLeave={e => e.currentTarget.classList.remove('dragover')}
          onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
          <p style={{ fontSize: 18, marginBottom: 8 }}>📁 Arrastra el escaneo del molde o haz clic</p>
          <p style={{ color: '#6b7280', fontSize: 14 }}>JPG/PNG · Escanea el MOLDE COMPLETO (como lo seleccionas en Corel){image ? ` · cargado: ${fileName} (${image.naturalWidth}×${image.naturalHeight}px)` : ''}</p>
        </div>

        {!image && (
          <div className="button-row">
            <button className="secondary" onClick={cargarEjemplo} disabled={!!busy}>🧪 Probar con una imagen de ejemplo (molde de 2 piezas, talla 36, Carta a 300 DPI)</button>
          </div>
        )}

        {image && (
          <div className="button-row">
            <button className="secondary" onClick={() => setRotated(r => !r)}>🔄 Rotar 90° {rotated ? '(deshacer)' : ''}</button>
            <button className="secondary" onClick={detectar} disabled={!work}>🔍 Volver a detectar el recuadro</button>
            <button className="secondary" onClick={reset}>🗑️ Quitar imagen</button>
          </div>
        )}
      </div>

      {/* ============ 2. RECUADRO, TALLAS, NUMERACIÓN ============ */}
      {work && cropRect && (
        <div className="screen">
          <h2>2. Recuadro del molde, talla base y numeración</h2>

          <div className="two-col">
            <div>
              <div className="tool-row">
                <button className={`tool-btn ${tool === 'crop' ? 'active' : ''}`} onClick={() => setTool(tool === 'crop' ? null : 'crop')}>
                  ✏️ Ajustar recuadro del molde
                </button>
                <button className={`tool-btn red ${tool === 'number' ? 'active' : ''}`} onClick={() => setTool(tool === 'number' ? null : 'number')}>
                  🔢 {tool === 'number' ? 'Listo (terminar de marcar)' : 'Marcar números a mano'}
                </button>
                <button className="tool-btn red" onClick={detectarNumeros}>🔎 Detectar números automáticamente</button>
                {numMarks.length > 0 && <button className="tool-btn" onClick={() => setNumMarks([])}>✖ Quitar todos ({numMarks.length})</button>}
              </div>
              {tool && (
                <div className="warning-box" style={{ marginTop: 0 }}>
                  {tool === 'crop'
                    ? 'Arrastra sobre la imagen para dibujar el recuadro que contiene TODO el molde (equivale al grupo seleccionado en Corel). Los factores se calculan sobre este recuadro.'
                    : 'Arrastra un rectángulo alrededor de CADA número de talla escrito en el molde (uno por pieza). Puedes marcar varios seguidos; al terminar pulsa "Listo". En cada copia esos números se borran y se escribe la talla nueva en el mismo sitio.'}
                </div>
              )}
              <div className="preview-container selector-wrap">
                <RectSelector
                  source={work.canvas}
                  overlays={overlays}
                  active={tool !== null}
                  activeColor={tool === 'number' ? '#dc2626' : '#2563eb'}
                  onSelect={onSelectRect}
                />
              </div>
            </div>

            <div>
              {baseBox && (
                <div className="stats-box">
                  <h4>📐 BoundingBox base (lo que Corel mediría del grupo)</h4>
                  <div className="stats-grid">
                    <div className="stat-item"><div className="stat-label">Ancho (mm)</div><div className="stat-value">{baseBox.widthMM.toFixed(2)}</div></div>
                    <div className="stat-item"><div className="stat-label">Alto/Largo (mm)</div><div className="stat-value">{baseBox.heightMM.toFixed(2)}</div></div>
                    <div className="stat-item"><div className="stat-label">DPI</div><div className="stat-value">{dpi}</div></div>
                  </div>
                </div>
              )}

              <h4 style={{ margin: '8px 0' }}>📏 Referencia del crecimiento (+{incrementos(mode).incAncho} mm ancho / +{incrementos(mode).incLargo} mm largo por talla)</h4>
              <div className="grid-3">
                <div className="form-group" style={{ gridColumn: refMode === 'manual' ? 'auto' : '1 / -1' }}>
                  <label>Esos milímetros son del molde completo; se aplican a…</label>
                  <select value={refMode} onChange={e => setRefMode(e.target.value as RefMode)}>
                    <option value="hoja">La hoja escaneada completa{sheetBox ? ` (${sheetBox.widthMM.toFixed(1)} × ${sheetBox.heightMM.toFixed(1)} mm)` : ''}</option>
                    <option value="manual">Medidas del molde completo que yo indico</option>
                    <option value="recuadro">El recuadro detectado (sólo si lo escaneado es el molde completo)</option>
                  </select>
                </div>
                {refMode === 'manual' && (
                  <>
                    <div className="form-group">
                      <label>Ancho total del molde base (mm)</label>
                      <input type="number" min={20} max={1000} value={refManual.widthMM} onChange={e => setRefManual(r => ({ ...r, widthMM: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Largo total del molde base (mm)</label>
                      <input type="number" min={20} max={1000} value={refManual.heightMM} onChange={e => setRefManual(r => ({ ...r, heightMM: e.target.value }))} />
                    </div>
                  </>
                )}
              </div>
              {baseBox && refBox && growthPerSize && (
                <div className="hint">
                  Lo escaneado mide <b>{baseBox.widthMM.toFixed(1)} × {baseBox.heightMM.toFixed(1)} mm</b> y crecerá
                  <b> {growthPerSize.ancho.toFixed(2)} mm de ancho</b> y <b>{growthPerSize.largo.toFixed(2)} mm de largo por talla</b>
                  {' '}({(100 * incrementos(mode).incAncho / refBox.widthMM).toFixed(2)} % / {(100 * incrementos(mode).incLargo / refBox.heightMM).toFixed(2)} %), igual que crecería dentro del molde completo.
                  {refMode === 'recuadro' && baseBox.heightMM < 200 && (
                    <div style={{ color: '#b45309', marginTop: 6 }}>⚠️ El recuadro es pequeño ({baseBox.heightMM.toFixed(0)} mm de largo): si es una pieza suelta (talón, puntera…), NO uses esta opción; usa la hoja completa o las medidas del molde completo.</div>
                  )}
                </div>
              )}

              <div className="grid-3">
                <div className="form-group">
                  <label>Talla base (la del dibujo)</label>
                  <input type="number" min={15} max={60} value={tallaBaseTxt} onChange={e => setTallaBaseTxt(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Talla menor</label>
                  <input type="number" min={15} max={60} value={tallaMenor} onChange={e => setTallaMenor(parseInt(e.target.value) || tallaMenor)} />
                </div>
                <div className="form-group">
                  <label>Talla mayor</label>
                  <input type="number" min={15} max={60} value={tallaMayor} onChange={e => setTallaMayor(parseInt(e.target.value) || tallaMayor)} />
                </div>
              </div>

              <h4 style={{ margin: '8px 0' }}>🔢 Enumeración automática</h4>
              <div className="grid-3">
                <div className="form-group">
                  <label>Número de talla</label>
                  <select value={numbering.mode} onChange={e => setNumbering(n => ({ ...n, mode: e.target.value as NumberingMode }))}>
                    <option value="molde">En cada hoja Y sobre el molde</option>
                    <option value="hoja">Sólo en el encabezado de cada hoja</option>
                  </select>
                </div>
                {numbering.mode === 'molde' && !hasRegions && (
                  <>
                    <div className="form-group">
                      <label>Posición sobre el molde</label>
                      <select value={numbering.corner} onChange={e => setNumbering(n => ({ ...n, corner: e.target.value as StampCorner }))}>
                        <option value="arriba-izq">Esquina superior izquierda</option>
                        <option value="arriba-der">Esquina superior derecha</option>
                        <option value="abajo-izq">Esquina inferior izquierda</option>
                        <option value="abajo-der">Esquina inferior derecha</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Altura del número (mm)</label>
                      <input type="number" min={4} max={40} value={numbering.stampHeightMM}
                        onChange={e => setNumbering(n => ({ ...n, stampHeightMM: Math.max(3, parseFloat(e.target.value) || n.stampHeightMM) }))} />
                    </div>
                  </>
                )}
              </div>
              {numbering.mode === 'molde' && (
                hasRegions ? (
                  <div className="hint">
                    <div style={{ marginBottom: 8 }}>
                      ✅ <b>Re-enumeración automática:</b> en cada talla se borran estos {numMarks.length} número(s) y se escribe la talla nueva en el mismo lugar de cada pieza. Verifica que la talla base coincida con lo que está escrito.
                    </div>
                    <div className="marks-list">
                      {numMarks.map((m, i) => (
                        <div key={i} className="mark-item">
                          {work && <RegionThumb source={work.canvas} rect={m} />}
                          <div className="mark-info">
                            <b>Nº {i + 1}</b> · {(m.w * mmPerPxWork).toFixed(0)} × {(m.h * mmPerPxWork).toFixed(0)} mm
                            <select value={m.angle} onChange={e => setMarkAngle(i, parseInt(e.target.value) as TextAngle)}>
                              {([0, 90, 180, 270] as TextAngle[]).map(a => <option key={a} value={a}>{ANGLE_LABELS[a]}</option>)}
                            </select>
                          </div>
                          <button className="small secondary" onClick={() => removeMark(i)} title="Quitar">✖</button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="hint">
                    💡 No hay números marcados: la talla se estampará en una esquina del recuadro y los números escritos en el molde se repetirían en todas las tallas.
                    Usa <b>“Detectar números automáticamente”</b> o <b>“Marcar números a mano”</b> (uno por pieza) para que se borren y se re-enumeren.
                  </div>
                )
              )}

              <div className="button-row">
                <button onClick={generar} disabled={!rangoValido || !baseBox}>📏 Generar tallas (igual que “Generar Tallas” en Corel)</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ 3. RESULTADO E IMPRESIÓN ============ */}
      {generated && escalas.length > 0 && (
        <div className="screen" ref={resultRef}>
          <h2>3. Resultado: {escalas.length} tallas · {nPages} hoja(s) para imprimir</h2>
          <p style={{ color: '#6b7280', marginBottom: 12 }}>
            Cada talla es el molde duplicado y escalado con Stretch() y va en <b>su propia hoja</b>. Si una talla no cabe en la hoja
            elegida se divide en varias hojas con solape y cruces de registro para pegarlas. Todas las hojas salen enumeradas.
          </p>

          <h4>🖨️ Hoja de impresión</h4>
          <div className="grid-4">
            <div className="form-group">
              <label>Tamaño de hoja</label>
              <select value={print.paper} onChange={e => setPrint(p => ({ ...p, paper: e.target.value as PaperSize }))}>
                {(Object.keys(PAPERS) as PaperSize[]).map(id => <option key={id} value={id}>{PAPERS[id].name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Orientación</label>
              <select value={print.orientation} onChange={e => setPrint(p => ({ ...p, orientation: e.target.value as Orientation }))} disabled={print.paper === 'plotter'}>
                <option value="auto">Automática (menos hojas)</option>
                <option value="vertical">Vertical</option>
                <option value="horizontal">Horizontal</option>
              </select>
            </div>
            <div className="form-group">
              <label>Margen de impresora (mm)</label>
              <input type="number" min={0} max={25} step={1} value={print.marginMM}
                onChange={e => setPrint(p => ({ ...p, marginMM: Math.min(25, Math.max(0, parseFloat(e.target.value) || 0)) }))} />
            </div>
            <div className="form-group">
              <label>Solape entre hojas (mm)</label>
              <input type="number" min={0} max={30} step={1} value={print.overlapMM} disabled={print.paper === 'plotter'}
                onChange={e => setPrint(p => ({ ...p, overlapMM: Math.min(30, Math.max(0, parseFloat(e.target.value) || 0)) }))} />
            </div>
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input id="whiten" type="checkbox" checked={whiten} onChange={e => setWhiten(e.target.checked)} style={{ width: 'auto' }} />
            <label htmlFor="whiten" style={{ margin: 0 }}>Blanquear el fondo del escaneo (imprime más limpio y el PDF pesa menos)</label>
          </div>

          <div className="compare-row">
            <span className="compare-label">Hojas necesarias según el papel:</span>
            {comparativa.map(c => (
              <button key={c.id} className={`pill-btn ${print.paper === c.id ? 'active' : ''}`} onClick={() => setPrint(p => ({ ...p, paper: c.id }))}>
                {paperName(c.id)}: <b>{c.pages}</b>
              </button>
            ))}
          </div>

          <table className="table">
            <thead>
              <tr><th>Talla</th><th>Dif.</th><th>factorAncho</th><th>factorLargo</th><th>Ancho × Alto (mm)</th><th>Δ mm</th><th>Hojas</th><th>Por separado</th></tr>
            </thead>
            <tbody>
              {escalas.map((e, i) => {
                const l = layouts[i];
                const n = l.rows * l.cols;
                return (
                  <tr key={e.size} className={e.size === tallaBase ? 'base-row' : ''}>
                    <td><b>{e.size}</b>{e.size === tallaBase ? ' (base)' : ''}</td>
                    <td>{e.size - tallaBase >= 0 ? '+' : ''}{e.size - tallaBase}</td>
                    <td>{e.factorAncho.toFixed(6)}</td>
                    <td>{e.factorLargo.toFixed(6)}</td>
                    <td>{e.newWidthMM.toFixed(2)} × {e.newHeightMM.toFixed(2)}</td>
                    <td>{e.deltaAnchoMM >= 0 ? '+' : ''}{e.deltaAnchoMM.toFixed(2)} / {e.deltaLargoMM >= 0 ? '+' : ''}{e.deltaLargoMM.toFixed(2)}</td>
                    <td><span className={n > 1 ? 'pill warn' : 'pill ok'}>{describeLayout(l)}</span></td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="small" onClick={() => descargarPDFTalla(e)} disabled={!!busy}>PDF</button>
                      <button className="small secondary" onClick={() => descargarPNG(e)} disabled={!!busy}>PNG</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="button-row">
            <button className="success" onClick={descargarPDF} disabled={!!busy}>⬇️ Descargar PDF para imprimir ({nPages} hojas, una talla por hoja)</button>
            <button className="secondary" onClick={descargarPlotter} disabled={!!busy}>🖨️ PDF plotter (todas las tallas en una sola hoja a medida)</button>
            <button onClick={descargarLog}>📄 Descargar log</button>
          </div>

          <h4 style={{ marginTop: 20 }}>Vista previa de cada talla y su reparto en hojas</h4>
          {cropWork && (
            <div className="preview-grid">
              {escalas.map((e, i) => (
                <SizePreview key={e.size} crop={cropWork} escala={e} layout={layouts[i]} numbering={numberingFull} />
              ))}
            </div>
          )}

          <div style={{ marginTop: 20 }}>
            <h4>Log (igual que el log de la macro):</h4>
            <pre className="log">{fullLog.join('\n')}</pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
