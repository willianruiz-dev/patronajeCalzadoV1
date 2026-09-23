import React, { useState, useRef, useEffect, useCallback } from 'react';
import jsPDF from 'jspdf';
import { loadImageFromFile, detectarBoundingBoxTinta, detectarNumeroTalla } from './modules/ImageLoader';
import { calcularFactores, generarEscalas, Mode, ScaleResult, BoundingBoxMM } from './modules/CorelStyleScaler';
import { DPI, PaperSize, pixelsToMM } from './modules/ScannerConfig';

const App: React.FC = () => {
  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null);
  const [imgUrl, setImgUrl] = useState<string>('');
  const [dpi, setDpi] = useState<DPI>(300);
  const [paperSize, setPaperSize] = useState<PaperSize>('carta');
  const [tallaBase, setTallaBase] = useState<number>(0);
  const [tallaBaseManual, setTallaBaseManual] = useState<string>('36');
  const [tallaMenor, setTallaMenor] = useState<number>(34);
  const [tallaMayor, setTallaMayor] = useState<number>(40);
  const [mode, setMode] = useState<Mode>('molde');
  const [baseBox, setBaseBox] = useState<BoundingBoxMM | null>(null);
  const [cropRect, setCropRect] = useState<{x:number;y:number;w:number;h:number} | null>(null);
  const [escalas, setEscalas] = useState<ScaleResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const log = (line: string) => setLogs(l => [...l, line]);

  const handleFile = async (file: File) => {
    try {
      setLoading(true);
      setLogs([]);
      setMessage(null);
      setEscalas([]);
      setTallaBase(0);
      const img = await loadImageFromFile(file);
      setOriginalImage(img);
      setImgUrl(URL.createObjectURL(file));
      log('=== LOG DE ESCALADO (estilo CorelDRAW) ===');
      log(`Imagen cargada: ${img.width}×${img.height}px`);
      setLoading(false);
    } catch (e) {
      setMessage('Error al cargar la imagen.');
      setLoading(false);
    }
  };

  /**
   * Detecta automáticamente el BoundingBox de la tinta (el "grupo" seleccionado)
   * e intenta leer un número (talla) mediante OCR por posición/proximidad de píxeles.
   * Si no detecta el número, lo deja para ingreso manual.
   */
  const procesarImagen = useCallback(() => {
    if (!originalImage) return;
    setLoading(true);
    setTimeout(() => {
      try {
        const img = originalImage;
        const w0 = img.width, h0 = img.height;
        const tmp = document.createElement('canvas');
        tmp.width = w0; tmp.height = h0;
        const tctx = tmp.getContext('2d')!;
        if (rotated) {
          tmp.width = h0; tmp.height = w0;
          tctx.save();
          tctx.translate(tmp.width/2, tmp.height/2);
          tctx.rotate(Math.PI/2);
          tctx.drawImage(img, -w0/2, -h0/2);
          tctx.restore();
        } else {
          tctx.drawImage(img, 0, 0);
        }

        const imgData = tctx.getImageData(0,0,tmp.width,tmp.height);
        const bbox = detectarBoundingBoxTinta(imgData);

        if (!bbox) {
          setMessage('No se detectó tinta en la imagen. Prueba a subir una imagen más contrastada.');
          setLoading(false);
          return;
        }

        const mmPerPx = pixelsToMM(1, dpi).toNumber();
        const boxMM: BoundingBoxMM = {
          widthMM: bbox.w * mmPerPx,
          heightMM: bbox.h * mmPerPx,
        };

        // Bounding box de la tinta en píxeles sobre la imagen (posiblemente rotada)
        setCropRect({ x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h });
        setBaseBox(boxMM);

        log(`BoundingBox detectado (px): x=${bbox.x}, y=${bbox.y}, w=${bbox.w}, h=${bbox.h}`);
        log(`mmPorPixel (dpi=${dpi}): ${mmPerPx.toFixed(5)}`);
        log(`BoundingBox en mm: ancho=${boxMM.widthMM.toFixed(2)}mm, alto=${boxMM.heightMM.toFixed(2)}mm`);

        // Intento de detectar la talla del texto "36" usando una detección simple por bloques oscuros pequeños
        const detected = detectarNumeroTalla(imgData, bbox);
        if (detected > 0) {
          setTallaBase(detected);
          log(`Talla detectada automáticamente: ${detected}`);
        } else {
          log('Talla NO detectada automáticamente. Ingresa manualmente.');
          setTallaBase(parseInt(tallaBaseManual,10) || 36);
        }

        setMessage('Imagen procesada. Ingresa el rango de tallas y pulsa "Generar tallas".');
      } catch (e: any) {
        setMessage('Error procesando: ' + e.message);
      }
      setLoading(false);
    }, 50);
  }, [originalImage, dpi, rotated, tallaBaseManual]);

  // Dibujar preview con el bounding box recortado
  useEffect(() => {
    if (!originalImage || !previewRef.current || !cropRect) return;
    const canvas = previewRef.current;
    const ctx = canvas.getContext('2d')!;
    const maxW = 600;
    const scale = Math.min(1, maxW / cropRect.w);
    canvas.width = cropRect.w * scale;
    canvas.height = cropRect.h * scale;
    const tmp = document.createElement('canvas');
    let w=originalImage.width, h=originalImage.height;
    if (rotated) { tmp.width = h; tmp.height = w; } else { tmp.width = w; tmp.height = h; }
    const tctx = tmp.getContext('2d')!;
    if (rotated) {
      tctx.save(); tctx.translate(tmp.width/2, tmp.height/2); tctx.rotate(Math.PI/2);
      tctx.drawImage(originalImage,-w/2,-h/2); tctx.restore();
    } else {
      tctx.drawImage(originalImage,0,0);
    }
    ctx.drawImage(tmp, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, canvas.width, canvas.height);
  }, [originalImage, cropRect, rotated]);

  const generar = () => {
    if (!baseBox) { setMessage('Primero procesa la imagen.'); return; }
    const tb = tallaBase || parseInt(tallaBaseManual,10);
    if (!tb) { setMessage('Ingresa una talla base válida.'); return; }
    setTallaBase(tb);
    if (tallaMenor > tallaMayor) { setMessage('La talla menor no puede ser mayor que la mayor.'); return; }

    const result = generarEscalas(mode, baseBox, tb, tallaMenor, tallaMayor, 25);
    setEscalas(result);

    log('');
    log(`Modo: ${mode.toUpperCase()}`);
    log(`Talla base: ${tb}`);
    log(`Rango: ${tallaMenor} → ${tallaMayor}`);
    log('');
    for (const r of result) {
      log(`--- Talla ${r.size} (dif=${r.size - tb}) ---`);
      log(`   factorAncho=${r.factorAncho.toFixed(6)}  factorLargo=${r.factorLargo.toFixed(6)}`);
      log(`   ANTES mm: ancho=${baseBox.widthMM.toFixed(2)}  alto=${baseBox.heightMM.toFixed(2)}`);
      log(`   DESPUES mm: ancho=${r.newWidthMM.toFixed(2)}  alto=${r.newHeightMM.toFixed(2)}`);
      log(`   Δ mm: ancho=${r.deltaAnchoMM.toFixed(2)}  alto=${r.deltaLargoMM.toFixed(2)}`);
    }
    log('');
    log('ESCALADO COMPLETADO');
    setMessage(`Se generaron ${result.length} tallas desde ${tallaMenor} hasta ${tallaMayor}.`);
  };

  // Dibujar canvas con todas las tallas alineadas (como hace Corel)
  useEffect(() => {
    if (!resultCanvasRef.current || escalas.length === 0 || !originalImage || !cropRect) return;
    const canvas = resultCanvasRef.current;
    const ctx = canvas.getContext('2d')!;

    const totalW = escalas[escalas.length-1].offsetXMM + escalas[escalas.length-1].newWidthMM;
    const maxH = Math.max(...escalas.map(e => e.newHeightMM));
    const mmPerPx = pixelsToMM(1, dpi).toNumber();
    const canvasScalePxPerMM = 2.5; // px por mm en el canvas de resultado
    canvas.width = totalW * canvasScalePxPerMM + 40;
    canvas.height = maxH * canvasScalePxPerMM + 40;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0,0,canvas.width,canvas.height);

    // Preparar canvas con la imagen recortada del molde base
    const tmp = document.createElement('canvas');
    tmp.width = cropRect.w; tmp.height = cropRect.h;
    const tctx = tmp.getContext('2d')!;
    let w=originalImage.width,h=originalImage.height;
    const full = document.createElement('canvas');
    if (rotated) { full.width = h; full.height = w; } else { full.width = w; full.height = h; }
    const fctx = full.getContext('2d')!;
    if (rotated) {
      fctx.save(); fctx.translate(full.width/2,full.height/2); fctx.rotate(Math.PI/2);
      fctx.drawImage(originalImage,-w/2,-h/2); fctx.restore();
    } else {
      fctx.drawImage(originalImage,0,0);
    }
    tctx.drawImage(full, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);

    // Dibujar cada talla
    for (const e of escalas) {
      const wPx = e.newWidthMM / mmPerPx;
      const hPx = e.newHeightMM / mmPerPx;
      ctx.drawImage(
        tmp,
        20 + e.offsetXMM * canvasScalePxPerMM,
        20,
        wPx * mmPerPx * canvasScalePxPerMM,
        hPx * mmPerPx * canvasScalePxPerMM
      );
      // Etiqueta de talla debajo
      ctx.fillStyle = '#2563eb';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Talla ${e.size}`, 20 + (e.offsetXMM + e.newWidthMM/2)*canvasScalePxPerMM, 20 + maxH*canvasScalePxPerMM + 20);
    }
  }, [escalas, originalImage, cropRect, dpi, rotated]);

  const descargarPDF = () => {
    if (!resultCanvasRef.current) return;
    const canvas = resultCanvasRef.current;
    const totalWMM = parseFloat((canvas.width/2.5).toFixed(2));
    const totalHMM = parseFloat((canvas.height/2.5).toFixed(2));
    const pdf = new jsPDF({ orientation: totalWMM>totalHMM?'landscape':'portrait', unit:'mm', format:[totalWMM+20, totalHMM+20] });
    const imgData = canvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', 10, 10, totalWMM, totalHMM);
    pdf.save(`escalado_tallas_${tallaMenor}-${tallaMayor}.pdf`);
  };

  const descargarPNG = () => {
    if (!resultCanvasRef.current) return;
    const a = document.createElement('a');
    a.href = resultCanvasRef.current.toDataURL('image/png');
    a.download = `escalado_tallas_${tallaMenor}-${tallaMayor}.png`;
    a.click();
  };

  const descargarLog = () => {
    const blob = new Blob([logs.join('\n')], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `log_escalado_${Date.now()}.txt`;
    a.click();
  };

  const reset = () => {
    setOriginalImage(null); setImgUrl(''); setCropRect(null); setBaseBox(null);
    setEscalas([]); setLogs([]); setTallaBase(0); setMessage(null); setRotated(false);
  };

  return (
    <div className="app-container">
      <h1>👞 Escalado de Calzado (estilo CorelDRAW)</h1>
      <p className="subtitle">Replicación web 1:1 del macro de CorelDRAW · Stretch(factorAncho, factorLargo) sobre el grupo completo</p>

      {message && <div className="stats-box"><p>{message}</p></div>}
      {loading && <div className="stats-box"><p>⏳ Procesando...</p></div>}

      <div className="screen">
        <h2>1. Cargar imagen del molde</h2>

        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:16}}>
          <div className="form-group">
            <label>DPI del escaneo</label>
            <select value={dpi} onChange={e=>setDpi(parseInt(e.target.value) as DPI)}>
              <option value={300}>300 DPI</option>
              <option value={600}>600 DPI</option>
            </select>
          </div>
          <div className="form-group">
            <label>Tamaño de papel (para exportar PDF)</label>
            <select value={paperSize} onChange={e=>setPaperSize(e.target.value as PaperSize)}>
              <option value="carta">Carta</option>
              <option value="oficio">Oficio</option>
              <option value="a4">A4</option>
            </select>
          </div>
          <div className="form-group">
            <label>Modo</label>
            <select value={mode} onChange={e=>setMode(e.target.value as Mode)}>
              <option value="molde">Molde (+3.33mm / +6.67mm por talla)</option>
              <option value="plantilla">Plantilla (+4.18mm / +8.34mm por talla)</option>
            </select>
          </div>
        </div>

        <div
          className="file-input-area"
          onClick={()=>fileInputRef.current?.click()}
          onDragOver={e=>{e.preventDefault(); e.currentTarget.classList.add('dragover');}}
          onDragLeave={e=>e.currentTarget.classList.remove('dragover')}
          onDrop={e=>{e.preventDefault(); e.currentTarget.classList.remove('dragover'); if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);}}>
          <input ref={fileInputRef} type="file" accept="image/*" style={{display:'none'}}
            onChange={e=>e.target.files?.[0]&&handleFile(e.target.files[0])}/>
          <p style={{fontSize:18,marginBottom:8}}>📁 Arrastra el escaneo del molde o haz clic</p>
          <p style={{color:'#6b7280',fontSize:14}}>JPG/PNG · Escanea/exporta el MOLDE COMPLETO (como lo seleccionas en Corel)</p>
        </div>

        {originalImage && (
          <>
            <div className="button-row">
              <button className="secondary" onClick={()=>setRotated(!rotated)}>🔄 Rotar 90° {rotated?'(deshacer)':''}</button>
              <button onClick={procesarImagen} disabled={loading}>🔍 Detectar bounding box del molde</button>
            </div>
            {cropRect && (
              <>
                <div style={{marginTop:20}}>
                  <h3>Previsualización del molde detectado (se escalará como grupo completo):</h3>
                  <div className="preview-container" style={{marginTop:10}}><canvas ref={previewRef}/></div>
                </div>

                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:16, marginTop:20}}>
                  <div className="form-group">
                    <label>Talla base (detectada o manual)</label>
                    <input type="number" min={20} max={50}
                      value={tallaBase || tallaBaseManual}
                      onChange={e=>{setTallaBase(0); setTallaBaseManual(e.target.value);}}/>
                  </div>
                  <div className="form-group">
                    <label>Talla menor</label>
                    <input type="number" min={20} max={50} value={tallaMenor}
                      onChange={e=>setTallaMenor(parseInt(e.target.value)||tallaMenor)}/>
                  </div>
                  <div className="form-group">
                    <label>Talla mayor</label>
                    <input type="number" min={20} max={50} value={tallaMayor}
                      onChange={e=>setTallaMayor(parseInt(e.target.value)||tallaMayor)}/>
                  </div>
                </div>

                {baseBox && (
                  <div className="stats-box">
                    <h4>📐 BoundingBox base (igual que CorelDRAW mediría el grupo)</h4>
                    <div className="stats-grid">
                      <div className="stat-item"><div className="stat-label">Ancho (mm)</div><div className="stat-value">{baseBox.widthMM.toFixed(2)}</div></div>
                      <div className="stat-item"><div className="stat-label">Alto/Largo (mm)</div><div className="stat-value">{baseBox.heightMM.toFixed(2)}</div></div>
                      <div className="stat-item"><div className="stat-label">DPI</div><div className="stat-value">{dpi}</div></div>
                    </div>
                  </div>
                )}

                <div className="button-row">
                  <button className="secondary" onClick={reset}>← Reiniciar</button>
                  <button onClick={generar}>📏 Generar tallas (igual que "Generar Tallas" en Corel)</button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {escalas.length > 0 && (
        <div className="screen">
          <h2>2. Resultado del escalado</h2>
          <p style={{color:'#6b7280',marginBottom:12}}>
            Cada talla es el molde duplicado y escalado con Stretch(), posicionado al lado con gap de 25mm, exactamente como hace la macro.
          </p>

          <div className="preview-container"><canvas ref={resultCanvasRef}/></div>

          <div className="stats-box">
            <h4>📊 Factores aplicados</h4>
            <div className="stats-grid">
              {escalas.map(e => (
                <div key={e.size} className="stat-item">
                  <div className="stat-label">Talla {e.size}</div>
                  <div className="stat-value" style={{fontSize:12}}>fA={e.factorAncho.toFixed(4)} fL={e.factorLargo.toFixed(4)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="button-row">
            <button className="success" onClick={descargarPDF}>⬇️ Descargar PDF</button>
            <button className="success" onClick={descargarPNG}>⬇️ Descargar PNG</button>
            <button onClick={descargarLog}>📄 Descargar log</button>
          </div>

          <div style={{marginTop:20}}>
            <h4>Log (igual que el log de la macro):</h4>
            <pre style={{background:'#f3f4f6', padding:12, borderRadius:8, fontSize:12, overflowX:'auto', maxHeight:300, overflowY:'auto'}}>
{logs.join('\n')}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
