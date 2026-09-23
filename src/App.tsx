import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ScanConfiguration, PaperSize, DPI } from './modules/ScannerConfig';
import { extractPiecesWithOptions, loadImageFromFile, getImageDataFromImage, rotateImageData90 } from './modules/PieceExtractor';
import { Piece, ScaledPiece, scaleAllPieces, calculateGlobalFactors, calculateLastLengthMM } from './modules/ProportionalScaler';
import { autoNest, NestingResult } from './modules/AutoNester';
import { exportToDXF, exportToPDF, downloadFile } from './modules/Exporter';

type Screen = 'upload' | 'detect' | 'result';

interface SizeBatch {
  size: number;
  pieces: ScaledPiece[];
  nesting: NestingResult;
}

const App: React.FC = () => {
  const [screen, setScreen] = useState<Screen>('upload');
  const [config, setConfig] = useState<ScanConfiguration>({
    paperSize: 'carta',
    dpi: 300,
    baseSize: 36,
  });
  const [targetSizes, setTargetSizes] = useState<string>('37,38,39');
  const [threshold, setThreshold] = useState<number>(180);
  const [closeRadius, setCloseRadius] = useState<number>(6);
  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null);
  const [rotated, setRotated] = useState(false);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [selectedPieces, setSelectedPieces] = useState<Set<string>>(new Set());
  const [batches, setBatches] = useState<SizeBatch[]>([]);
  const [activeBatchIdx, setActiveBatchIdx] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [debugOverlay, setDebugOverlay] = useState<ImageData | null>(null);
  const [usedRadius, setUsedRadius] = useState<number>(0);
  const [showDebug, setShowDebug] = useState<boolean>(false);

  const originalPreviewRef = useRef<HTMLCanvasElement>(null);
  const piecesPreviewRef = useRef<HTMLCanvasElement>(null);
  const nestingPreviewRef = useRef<HTMLCanvasElement>(null);
  const debugPreviewRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (file: File) => {
    try {
      setLoading(true);
      setWarning(null); setMessage(null); setDebugOverlay(null);
      const img = await loadImageFromFile(file);
      setOriginalImage(img);
      setMessage(`Imagen cargada: ${img.width}×${img.height}px. Haz clic en "Detectar piezas".`);
      setLoading(false);
    } catch {
      setWarning('Error al cargar la imagen. Intente nuevamente.');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!originalImage || !originalPreviewRef.current) return;
    const canvas = originalPreviewRef.current;
    const ctx = canvas.getContext('2d')!;
    const maxW = 700;
    let drawImg: HTMLImageElement | HTMLCanvasElement = originalImage;
    let w = originalImage.width, h = originalImage.height;
    if (rotated) {
      const c = document.createElement('canvas');
      c.width = h; c.height = w;
      const cctx = c.getContext('2d')!;
      cctx.save();
      cctx.translate(c.width/2, c.height/2);
      cctx.rotate(Math.PI/2);
      cctx.drawImage(originalImage, -w/2, -h/2);
      cctx.restore();
      drawImg = c;
      w = c.width; h = c.height;
    }
    const scale = Math.min(1, maxW / w);
    canvas.width = w * scale;
    canvas.height = h * scale;
    ctx.drawImage(drawImg, 0, 0, canvas.width, canvas.height);
  }, [originalImage, rotated]);

  // Detección con algoritmo de dilatación progresiva
  const runDetection = useCallback(() => {
    if (!originalImage) return;
    setLoading(true);
    setTimeout(() => {
      try {
        const imgData = rotated
          ? rotateImageData90(originalImage)
          : getImageDataFromImage(originalImage);

        const { pieces: extracted, debugOverlay: overlay, usedRadius: r } = extractPiecesWithOptions(imgData, config.dpi, {
          threshold,
          closeRadius,
          minPieceMM: 10,
        });

        setDebugOverlay(overlay);
        setUsedRadius(r);
        setPieces(extracted);
        setSelectedPieces(new Set(extracted.map(p => p.id)));
        setScreen('detect');
        if (extracted.length === 0) {
          setWarning(
            'No se detectaron piezas cerradas. Prueba a: ' +
            '(1) subir "Cierre de trazos" a 10-20px, ' +
            '(2) bajar el umbral si los trazos son claros, ' +
            '(3) verifica que la orientación sea correcta (el zapato horizontal).'
          );
        } else {
          setMessage(`✅ Se detectaron ${extracted.length} pieza(s) (radio de dilatación automático: ${r}px). Selecciona las que quieras escalar.`);
        }
      } catch (e) {
        setWarning('Error procesando imagen: ' + (e as Error).message);
      }
      setLoading(false);
    }, 50);
  }, [originalImage, rotated, config.dpi, threshold, closeRadius]);

  // Dibujar overlay de depuración
  useEffect(() => {
    if (debugOverlay && debugPreviewRef.current && showDebug) {
      const canvas = debugPreviewRef.current;
      canvas.width = debugOverlay.width;
      canvas.height = debugOverlay.height;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(debugOverlay, 0, 0);
    }
  }, [debugOverlay, showDebug]);

  // Dibujar piezas detectadas
  useEffect(() => {
    if (!piecesPreviewRef.current) return;
    const canvas = piecesPreviewRef.current;
    const ctx = canvas.getContext('2d')!;
    const padding = 30;
    const scale = 4;
    const cols = Math.min(pieces.length || 1, 3);
    const rows = Math.ceil(Math.max(pieces.length, 1) / cols);
    const maxW = Math.max(1, ...pieces.map(p => p.widthMM));
    const maxH = Math.max(1, ...pieces.map(p => p.heightMM));
    const cellW = maxW * scale + padding * 2;
    const cellH = maxH * scale + padding * 2;

    canvas.width = cols * cellW;
    canvas.height = rows * cellH;
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    pieces.forEach((piece, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = col * cellW + cellW / 2;
      const cy = row * cellH + cellH / 2;
      const ox = cx - (piece.widthMM * scale) / 2;
      const oy = cy - (piece.heightMM * scale) / 2;

      ctx.save();
      ctx.translate(ox, oy);
      ctx.strokeStyle = selectedPieces.has(piece.id) ? '#000' : '#d1d5db';
      ctx.fillStyle = selectedPieces.has(piece.id) ? 'rgba(37,99,235,0.08)' : 'transparent';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      piece.points.forEach((p, i) => {
        const px = p.x * scale, py = p.y * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('← Talón', 2, -4);
      ctx.fillText('Punta →', piece.widthMM * scale - 52, -4);
      ctx.fillStyle = '#374151';
      ctx.fillText(`#${idx+1} · ${piece.widthMM.toFixed(1)}×${piece.heightMM.toFixed(1)}mm`, 2, piece.heightMM * scale + 14);
      ctx.restore();
    });
  }, [pieces, selectedPieces]);

  const togglePiece = (id: string) => {
    const next = new Set(selectedPieces);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedPieces(next);
  };

  const doScaleAndNest = useCallback(() => {
    const chosen = pieces.filter(p => selectedPieces.has(p.id));
    if (chosen.length === 0) { setWarning('Selecciona al menos una pieza.'); return; }
    const sizes = targetSizes.split(/[,\s]+/).map(s => parseInt(s.trim(),10)).filter(n => !isNaN(n) && n>20 && n<50);
    if (sizes.length === 0) { setWarning('Ingresa al menos una talla destino (ej. 37,38,39).'); return; }
    setLoading(true);
    setTimeout(() => {
      const newBatches: SizeBatch[] = sizes.map(size => {
        const scaled = scaleAllPieces(chosen, config.baseSize, size);
        const nesting = autoNest(scaled, { paperSize: config.paperSize, marginMM: 8 });
        return { size, pieces: scaled, nesting };
      });
      setBatches(newBatches);
      setActiveBatchIdx(0);
      setScreen('result');
      setMessage(`Escalado de talla ${config.baseSize} a [${sizes.join(', ')}] completado.`);
      setLoading(false);
    }, 100);
  }, [pieces, selectedPieces, targetSizes, config]);

  useEffect(() => {
    if (batches.length === 0 || !nestingPreviewRef.current) return;
    const batch = batches[activeBatchIdx];
    if (!batch) return;
    const canvas = nestingPreviewRef.current;
    const ctx = canvas.getContext('2d')!;
    const padding = 30;
    const scale = Math.min(2.5, 900 / batch.nesting.totalWidthMM);
    canvas.width = batch.nesting.totalWidthMM * scale + padding*2;
    canvas.height = batch.nesting.totalHeightMM * scale + padding*2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle = '#94a3b8';
    ctx.setLineDash([4,4]);
    ctx.strokeRect(padding, padding, batch.nesting.totalWidthMM*scale, batch.nesting.totalHeightMM*scale);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    for (const np of batch.nesting.pieces) {
      ctx.save();
      ctx.translate(padding + np.offsetX*scale, padding + np.offsetY*scale);
      ctx.beginPath();
      np.piece.points.forEach((p, i) => {
        const px = p.x*scale, py = p.y*scale;
        if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = '#374151';
    ctx.font = '12px sans-serif';
    ctx.fillText(`Talla ${batch.size} — contornos listos para cortar`, padding, canvas.height-8);
  }, [batches, activeBatchIdx]);

  const downloadDXF = (batch: SizeBatch) => {
    downloadFile(exportToDXF(batch.nesting.pieces, 'MM'), `patronaje_talla${batch.size}.dxf`, 'application/dxf');
  };
  const downloadPDF = (batch: SizeBatch) => {
    exportToPDF(batch.nesting.pieces, config.paperSize, `patronaje_talla${batch.size}.pdf`);
  };
  const downloadAllDXF = () => batches.forEach((b, i) => setTimeout(() => downloadDXF(b), i*200));

  const reset = () => {
    setScreen('upload');
    setOriginalImage(null);
    setDebugOverlay(null);
    setPieces([]); setBatches([]);
    setSelectedPieces(new Set());
    setRotated(false);
    setMessage(null); setWarning(null);
    setShowDebug(false);
  };

  const firstTarget = parseInt(targetSizes.split(',')[0],10) || config.baseSize+1;
  const { factorX, factorY } = calculateGlobalFactors(config.baseSize, firstTarget);

  return (
    <div className="app-container">
      <h1>👞 Patronaje Digital de Calzado</h1>
      <p className="subtitle">Escalado Proporcional por Punto Francés · 100% en el navegador</p>

      <div className="step-indicator">
        <div className={`step ${screen==='upload'?'active':'done'}`}>1. Configuración</div>
        <div className={`step ${screen==='detect'?'active':screen==='result'?'done':''}`}>2. Detectar piezas</div>
        <div className={`step ${screen==='result'?'active':''}`}>3. Escalar y exportar</div>
      </div>

      {message && <div className="stats-box"><p>{message}</p></div>}
      {warning && <div className="warning-box"><p>⚠️ {warning}</p></div>}
      {loading && <div className="stats-box"><p>⏳ Procesando...</p></div>}

      {screen==='upload' && (
        <div className="screen">
          <h2>Paso 1: Configuración de escaneo</h2>
          <p style={{color:'#6b7280', marginBottom:20}}>Sube una foto/escaneo nítido de tus moldes en papel blanco con trazos negros. El zapato debe quedar horizontal (talón a la izquierda, punta a la derecha).</p>

          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:16}}>
            <div className="form-group">
              <label>Tamaño de papel</label>
              <select value={config.paperSize} onChange={e=>setConfig({...config,paperSize:e.target.value as PaperSize})}>
                <option value="carta">Carta (279.4 × 215.9 mm)</option>
                <option value="oficio">Oficio (355.6 × 215.9 mm)</option>
                <option value="a4">A4 (297 × 210 mm)</option>
              </select>
            </div>
            <div className="form-group">
              <label>DPI del escáner</label>
              <select value={config.dpi} onChange={e=>setConfig({...config,dpi:parseInt(e.target.value) as DPI})}>
                <option value={300}>300 DPI</option>
                <option value={600}>600 DPI</option>
              </select>
            </div>
            <div className="form-group">
              <label>Talla base del dibujo (EU)</label>
              <input type="number" min={20} max={50} value={config.baseSize}
                onChange={e=>setConfig({...config,baseSize:parseInt(e.target.value)||36})}/>
            </div>
          </div>

          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
            <div className="form-group">
              <label>Umbral binarizado ({threshold})</label>
              <input type="range" min={80} max={240} value={threshold}
                onChange={e=>setThreshold(parseInt(e.target.value))}/>
              <small style={{color:'#6b7280'}}>Bájalo si los trazos son grises/claros. Súbelo si el papel tiene sombra.</small>
            </div>
            <div className="form-group">
              <label>Cierre inicial de trazos ({closeRadius}px)</label>
              <input type="range" min={2} max={25} value={closeRadius}
                onChange={e=>setCloseRadius(parseInt(e.target.value))}/>
              <small style={{color:'#6b7280'}}>Cuánto "inflar" los trazos para cerrar huecos. Si no detecta nada, súbelo a 12-20. El algoritmo subirá automáticamente si no encuentra piezas.</small>
            </div>
          </div>

          <div
            className="file-input-area"
            onClick={()=>fileInputRef.current?.click()}
            onDragOver={e=>{e.preventDefault(); e.currentTarget.classList.add('dragover');}}
            onDragLeave={e=>e.currentTarget.classList.remove('dragover')}
            onDrop={e=>{e.preventDefault(); e.currentTarget.classList.remove('dragover'); if(e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);}}>
            <input ref={fileInputRef} type="file" accept="image/*" style={{display:'none'}}
              onChange={e=>e.target.files?.[0]&&handleFileUpload(e.target.files[0])}/>
            <p style={{fontSize:18,marginBottom:8}}>📁 Haz clic o arrastra la imagen aquí</p>
            <p style={{color:'#6b7280',fontSize:14}}>JPG / PNG · trazos negros sobre papel blanco bien iluminado</p>
          </div>

          {originalImage && (
            <>
              <div className="preview-container"><canvas ref={originalPreviewRef}/></div>
              <p style={{fontSize:13,color:'#6b7280',textAlign:'center',marginTop:8}}>
                Orientación: ← TALÓN (izquierda) | PUNTA → (derecha) · Y = Suela → Empeine
              </p>
              <div className="button-row">
                <button className="secondary" onClick={()=>setRotated(!rotated)}>🔄 Rotar 90° {rotated?'(activado)':''}</button>
                <button onClick={runDetection} disabled={loading}>{loading?'Detectando...':'🔍 Detectar piezas'}</button>
              </div>
            </>
          )}
        </div>
      )}

      {screen==='detect' && (
        <div className="screen">
          <h2>Paso 2: Revisa las piezas detectadas</h2>
          <p style={{color:'#6b7280', marginBottom:16}}>
            Haz clic en una pieza para incluirla/excluirla. Se usó un radio de dilatación de <b>{usedRadius}px</b> para cerrar los trazos.
          </p>

          {debugOverlay && (
            <div style={{marginBottom:12}}>
              <button className="secondary" style={{width:'auto',padding:'8px 16px',fontSize:14}}
                onClick={()=>setShowDebug(!showDebug)}>
                {showDebug?'Ocultar':'Ver'} depuración (rojo = tinta usada, azul = interior detectado)
              </button>
              {showDebug && (
                <div className="preview-container" style={{marginTop:10}}>
                  <canvas ref={debugPreviewRef} style={{maxWidth:'100%'}}/>
                </div>
              )}
            </div>
          )}

          <div className="preview-container" onClick={e=>{
            if(!piecesPreviewRef.current) return;
            const canvas = piecesPreviewRef.current;
            const rect = canvas.getBoundingClientRect();
            const mx = (e.clientX-rect.left)*(canvas.width/rect.width);
            const my = (e.clientY-rect.top)*(canvas.height/rect.height);
            const padding = 30;
            const scale = 4;
            const cols = Math.min(pieces.length,3);
            const maxW = Math.max(...pieces.map(p=>p.widthMM));
            const maxH = Math.max(...pieces.map(p=>p.heightMM));
            const cellW = maxW*scale + padding*2;
            const cellH = maxH*scale + padding*2;
            const col = Math.floor(mx/cellW);
            const row = Math.floor(my/cellH);
            const idx = row*cols+col;
            if(idx>=0 && idx<pieces.length) togglePiece(pieces[idx].id);
          }} style={{cursor:'pointer'}}>
            <canvas ref={piecesPreviewRef}/>
          </div>

          <div className="form-group" style={{marginTop:24}}>
            <label>Tallas destino (EU) — separadas por coma</label>
            <input type="text" value={targetSizes} onChange={e=>setTargetSizes(e.target.value)}
              placeholder="ej. 37,38,39,40"/>
            <small style={{color:'#6b7280'}}>Generarás un archivo por cada talla, escaladas desde la talla base {config.baseSize}.</small>
          </div>

          <div className="stats-box">
            <h4>📐 Factores de escalado (base {config.baseSize} → primera talla {firstTarget})</h4>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-label">Longitud base</div><div className="stat-value">{calculateLastLengthMM(config.baseSize).toFixed(2)} mm</div></div>
              <div className="stat-item"><div className="stat-label">Factor X (longitudinal)</div><div className="stat-value">{factorX.toFixed(5)}</div></div>
              <div className="stat-item"><div className="stat-label">Factor Y (transversal)</div><div className="stat-value">{factorY.toFixed(5)}</div></div>
              <div className="stat-item"><div className="stat-label">Piezas seleccionadas</div><div className="stat-value">{selectedPieces.size} / {pieces.length}</div></div>
            </div>
          </div>

          <div className="button-row">
            <button className="secondary" onClick={()=>setScreen('upload')}>← Volver</button>
            <button onClick={doScaleAndNest} disabled={loading}>{loading?'Escalando...':'📏 Escalar y reacomodar'}</button>
          </div>
        </div>
      )}

      {screen==='result' && batches.length>0 && (
        <div className="screen">
          <h2>Paso 3: Resultado</h2>
          <p style={{color:'#6b7280', marginBottom:12}}>Piezas escaladas proporcionalmente y reacomodadas en la hoja.</p>

          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>
            {batches.map((b,i)=>(
              <button key={b.size} onClick={()=>setActiveBatchIdx(i)}
                style={{flex:'0 0 auto',width:'auto',padding:'10px 20px',
                  background:i===activeBatchIdx?'#2563eb':'#e5e7eb',
                  color:i===activeBatchIdx?'white':'#111'}}>
                Talla {b.size}
              </button>
            ))}
          </div>

          <div className="preview-container"><canvas ref={nestingPreviewRef}/></div>

          {(() => {
            const b = batches[activeBatchIdx];
            const fx = calculateGlobalFactors(config.baseSize, b.size).factorX;
            const fy = calculateGlobalFactors(config.baseSize, b.size).factorY;
            return (
              <div className="stats-box">
                <h4>📊 Talla {b.size}</h4>
                <div className="stats-grid">
                  <div className="stat-item"><div className="stat-label">Factor X</div><div className="stat-value">{fx.toFixed(5)}</div></div>
                  <div className="stat-item"><div className="stat-label">Factor Y</div><div className="stat-value">{fy.toFixed(5)}</div></div>
                  <div className="stat-item"><div className="stat-label">Piezas</div><div className="stat-value">{b.nesting.pieces.length}</div></div>
                  <div className="stat-item"><div className="stat-label">Lienzo</div><div className="stat-value">{b.nesting.totalWidthMM.toFixed(1)}×{b.nesting.totalHeightMM.toFixed(1)}mm</div></div>
                </div>
              </div>
            );
          })()}

          <div className="button-row">
            <button className="secondary" onClick={()=>setScreen('detect')}>← Volver</button>
            <button className="success" onClick={()=>downloadDXF(batches[activeBatchIdx])}>⬇️ DXF talla {batches[activeBatchIdx].size}</button>
            <button className="success" onClick={()=>downloadPDF(batches[activeBatchIdx])}>⬇️ PDF talla {batches[activeBatchIdx].size}</button>
          </div>
          <div className="button-row">
            <button onClick={downloadAllDXF}>⬇️ Descargar DXF de TODAS las tallas</button>
            <button className="secondary" onClick={reset}>🔄 Nuevo escaneo</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
