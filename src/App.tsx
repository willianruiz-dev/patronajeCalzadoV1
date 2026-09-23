import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ScanConfiguration, PaperSize, DPI, validateImageSize } from './modules/ScannerConfig';
import { binarizeImage, extractPieces, loadImageFromFile, getImageDataFromImage } from './modules/PieceExtractor';
import { Piece, ScaledPiece, scaleAllPieces, calculateGlobalFactors, calculateLastLengthMM, calculateLastWidthMM } from './modules/ProportionalScaler';
import { autoNest, NestingResult } from './modules/AutoNester';
import { exportToDXF, exportToPDF, downloadFile } from './modules/Exporter';

type Screen = 'upload' | 'detect' | 'nest';

const App: React.FC = () => {
  const [screen, setScreen] = useState<Screen>('upload');
  const [config, setConfig] = useState<ScanConfiguration>({
    paperSize: 'carta',
    dpi: 300,
    baseSize: 40,
  });
  const [targetSize, setTargetSize] = useState<number>(42);
  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [scaledPieces, setScaledPieces] = useState<ScaledPiece[]>([]);
  const [nestingResult, setNestingResult] = useState<NestingResult | null>(null);
  const [rotated, setRotated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const originalPreviewRef = useRef<HTMLCanvasElement>(null);
  const piecesPreviewRef = useRef<HTMLCanvasElement>(null);
  const nestingPreviewRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // PASO 1: Manejar carga de imagen
  const handleFileUpload = async (file: File) => {
    try {
      setLoading(true);
      setWarning(null);
      const img = await loadImageFromFile(file);
      setOriginalImage(img);

      // Validar tamaño
      const validation = validateImageSize(img.width, img.height, config.paperSize, config.dpi);
      if (!validation.valid) {
        setWarning(validation.message);
      } else {
        setMessage('Imagen cargada correctamente.');
      }
      setLoading(false);
    } catch (err) {
      setWarning('Error al cargar la imagen. Intente nuevamente.');
      setLoading(false);
    }
  };

  // Dibujar preview original
  useEffect(() => {
    if (originalImage && originalPreviewRef.current) {
      const canvas = originalPreviewRef.current;
      const ctx = canvas.getContext('2d')!;
      const maxW = 800;
      const scale = Math.min(1, maxW / originalImage.width);
      canvas.width = originalImage.width * scale;
      canvas.height = originalImage.height * scale;
      ctx.drawImage(originalImage, 0, 0, canvas.width, canvas.height);
    }
  }, [originalImage, rotated]);

  // PASO 2: Detectar piezas
  const detectPieces = useCallback(() => {
    if (!originalImage) return;
    setLoading(true);

    setTimeout(() => {
      let img = originalImage;
      if (rotated) {
        // Rotar 90 grados
        const c = document.createElement('canvas');
        c.width = img.height;
        c.height = img.width;
        const ctx = c.getContext('2d')!;
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        const rotatedImg = new Image();
        rotatedImg.src = c.toDataURL();
        img = rotatedImg;
      }

      const imageData = getImageDataFromImage(img);
      const binary = binarizeImage(imageData, 150);
      const extracted = extractPieces(binary, config.dpi, 5);
      setPieces(extracted);
      setMessage(`Se detectaron ${extracted.length} piezas.`);
      setScreen('detect');
      setLoading(false);
    }, 100);
  }, [originalImage, rotated, config.dpi]);

  // Dibujar piezas detectadas
  useEffect(() => {
    if (pieces.length > 0 && piecesPreviewRef.current) {
      const canvas = piecesPreviewRef.current;
      const ctx = canvas.getContext('2d')!;
      const padding = 20;
      const scale = 3; // 3px por mm

      const totalW = pieces.reduce((sum, p) => sum + p.widthMM * scale + padding, padding);
      const maxH = Math.max(...pieces.map(p => p.heightMM * scale)) + padding * 2;
      canvas.width = Math.min(totalW, 1200);
      canvas.height = maxH;

      ctx.fillStyle = '#fafafa';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let xOffset = padding;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;

      for (const piece of pieces) {
        const ps = piece.widthMM * scale;
        ctx.save();
        ctx.translate(xOffset, padding + maxH / 2 - piece.heightMM * scale / 2);
        ctx.beginPath();
        piece.points.forEach((p, i) => {
          const px = p.x * scale;
          const py = p.y * scale;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
        // Etiquetas orientación
        ctx.fillStyle = '#ef4444';
        ctx.font = '10px sans-serif';
        ctx.fillText('← TALÓN', 0, -5);
        ctx.fillText('PUNTA →', ps - 45, -5);
        ctx.restore();
        xOffset += ps + padding;
      }
    }
  }, [pieces]);

  // PASO 3: Escalar y nestear
  const doScaleAndNest = useCallback(() => {
    if (pieces.length === 0) return;
    setLoading(true);

    setTimeout(() => {
      const scaled = scaleAllPieces(pieces, config.baseSize, targetSize);
      setScaledPieces(scaled);

      // Nesting en tamaño carta por defecto
      const result = autoNest(scaled, { paperSize: config.paperSize, marginMM: 10 });
      setNestingResult(result);
      setScreen('nest');
      setMessage(`Escalado de talla ${config.baseSize} a ${targetSize} completado.`);
      setLoading(false);
    }, 100);
  }, [pieces, config.baseSize, config.paperSize, targetSize]);

  // Dibujar resultado del nesting con comparación visual
  useEffect(() => {
    if (nestingResult && nestingPreviewRef.current) {
      const canvas = nestingPreviewRef.current;
      const ctx = canvas.getContext('2d')!;
      const padding = 20;
      const scale = 2.5;

      canvas.width = nestingResult.totalWidthMM * scale + padding * 2;
      canvas.height = nestingResult.totalHeightMM * scale + padding * 2;

      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Dibujar piezas escaladas (azul semitransparente)
      ctx.strokeStyle = '#2563eb';
      ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
      ctx.lineWidth = 1.5;
      for (const np of nestingResult.pieces) {
        ctx.save();
        ctx.translate(padding + np.offsetX * scale, padding + np.offsetY * scale);
        ctx.beginPath();
        np.piece.points.forEach((p, i) => {
          const px = p.x * scale;
          const py = p.y * scale;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Dibujar superposición de piezas originales (negro) a la izquierda para comparación
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      let compX = padding;
      ctx.save();
      ctx.translate(padding, canvas.height - padding - 60);
      for (let i = 0; i < Math.min(pieces.length, 3); i++) {
        const op = pieces[i];
        ctx.save();
        ctx.translate(compX, -op.heightMM * scale);
        ctx.beginPath();
        op.points.forEach((p, idx) => {
          const px = p.x * scale;
          const py = p.y * scale;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
        compX += op.widthMM * scale + 10;
      }
      ctx.restore();

      ctx.fillStyle = '#000';
      ctx.font = '12px sans-serif';
      ctx.fillText('Negro = Original (talla base) | Azul = Escalado', padding, canvas.height - 5);
    }
  }, [nestingResult, pieces]);

  const handleDownloadDXF = () => {
    if (!nestingResult) return;
    const dxf = exportToDXF(nestingResult.pieces, 'MM');
    downloadFile(dxf, `patronaje_talla${targetSize}.dxf`, 'application/dxf');
  };

  const handleDownloadPDF = () => {
    if (!nestingResult) return;
    exportToPDF(nestingResult.pieces, config.paperSize, `patronaje_talla${targetSize}.pdf`);
  };

  const reset = () => {
    setScreen('upload');
    setOriginalImage(null);
    setPieces([]);
    setScaledPieces([]);
    setNestingResult(null);
    setMessage(null);
    setWarning(null);
    setRotated(false);
  };

  const { factorX, factorY } = calculateGlobalFactors(config.baseSize, targetSize);
  const baseLength = calculateLastLengthMM(config.baseSize).toFixed(2);
  const targetLength = calculateLastLengthMM(targetSize).toFixed(2);
  const baseWidth = calculateLastWidthMM(config.baseSize).toFixed(2);
  const targetWidth = calculateLastWidthMM(targetSize).toFixed(2);

  return (
    <div className="app-container">
      <h1>👞 Patronaje Digital de Calzado</h1>
      <p className="subtitle">Escalado Proporcional por Punto Francés · 100% en el navegador</p>

      <div className="step-indicator">
        <div className={`step ${screen === 'upload' ? 'active' : screen === 'detect' || screen === 'nest' ? 'done' : ''}`}>
          1. Configuración
        </div>
        <div className={`step ${screen === 'detect' ? 'active' : screen === 'nest' ? 'done' : ''}`}>
          2. Detección de Piezas
        </div>
        <div className={`step ${screen === 'nest' ? 'active' : ''}`}>
          3. Escalado y Nesting
        </div>
      </div>

      {message && (
        <div className="stats-box">
          <p>{message}</p>
        </div>
      )}

      {warning && (
        <div className="warning-box">
          <p>⚠️ {warning}</p>
        </div>
      )}

      {/* PANTALLA 1: UPLOAD Y CONFIGURACIÓN */}
      {screen === 'upload' && (
        <div className="screen">
          <h2>Paso 1: Configuración de Escaneo</h2>
          <p style={{ color: '#6b7280', marginBottom: 24 }}>
            Sube la imagen de tus moldes dibujados en papel y configura los parámetros de escaneo.
          </p>

          <div className="form-group">
            <label>Tamaño de Papel</label>
            <select
              value={config.paperSize}
              onChange={e => setConfig({ ...config, paperSize: e.target.value as PaperSize })}
            >
              <option value="carta">Carta (279.4 × 215.9 mm)</option>
              <option value="oficio">Oficio (355.6 × 215.9 mm)</option>
              <option value="a4">A4 (297 × 210 mm)</option>
            </select>
          </div>

          <div className="form-group">
            <label>DPI del Escáner</label>
            <select
              value={config.dpi}
              onChange={e => setConfig({ ...config, dpi: parseInt(e.target.value) as DPI })}
            >
              <option value={300}>300 DPI (estándar)</option>
              <option value={600}>600 DPI (alta precisión)</option>
            </select>
          </div>

          <div className="form-group">
            <label>Talla Base del Dibujo (EU)</label>
            <input
              type="number"
              min={20}
              max={50}
              value={config.baseSize}
              onChange={e => setConfig({ ...config, baseSize: parseInt(e.target.value) || 40 })}
            />
          </div>

          <div
            className="file-input-area"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
            onDragLeave={e => e.currentTarget.classList.remove('dragover')}
            onDrop={e => {
              e.preventDefault();
              e.currentTarget.classList.remove('dragover');
              if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
            />
            <p style={{ fontSize: 18, marginBottom: 8 }}>📁 Haz clic o arrastra una imagen aquí</p>
            <p style={{ color: '#6b7280', fontSize: 14 }}>
              Formato: JPG, PNG · Escanea tus moldes con trazos negros sobre papel blanco
            </p>
          </div>

          {originalImage && (
            <div className="preview-container">
              <canvas ref={originalPreviewRef} />
              <div className="orientation-label" style={{ padding: '8px 16px' }}>
                <span>← TALÓN (Eje X = Longitud)</span>
                <span>(Eje Y = Altura) EMPEINE ↑</span>
                <span>PUNTA →</span>
              </div>
            </div>
          )}

          {originalImage && (
            <div className="button-row">
              <button
                className="secondary"
                onClick={() => setRotated(!rotated)}
              >
                🔄 Rotar 90° {rotated ? '(activado)' : ''}
              </button>
              <button
                onClick={detectPieces}
                disabled={loading}
              >
                {loading ? 'Procesando...' : '🔍 Detectar Piezas'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* PANTALLA 2: PIEZAS DETECTADAS */}
      {screen === 'detect' && (
        <div className="screen">
          <h2>Paso 2: Piezas Detectadas</h2>
          <p style={{ color: '#6b7280', marginBottom: 16 }}>
            Se han identificado {pieces.length} pieza(s). La orientación es fija: X = Longitud (Talón→Punta), Y = Altura (Suela→Empeine).
          </p>

          <div className="preview-container">
            <canvas ref={piecesPreviewRef} />
          </div>

          <div className="form-group" style={{ marginTop: 24 }}>
            <label>Talla Destino (EU)</label>
            <input
              type="number"
              min={20}
              max={50}
              value={targetSize}
              onChange={e => setTargetSize(parseInt(e.target.value) || config.baseSize + 1)}
            />
          </div>

          <div className="stats-box">
            <h4>📐 Factores Globales de Escalado</h4>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-label">Longitud Base (talla {config.baseSize})</div>
                <div className="stat-value">{baseLength} mm</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Longitud Destino (talla {targetSize})</div>
                <div className="stat-value">{targetLength} mm</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Factor X (Longitudinal)</div>
                <div className="stat-value">{factorX.toFixed(5)}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Ancho Base (talla {config.baseSize})</div>
                <div className="stat-value">{baseWidth} mm</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Ancho Destino (talla {targetSize})</div>
                <div className="stat-value">{targetWidth} mm</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Factor Y (Transversal)</div>
                <div className="stat-value">{factorY.toFixed(5)}</div>
              </div>
            </div>
            <p style={{ fontSize: 12, color: '#166534', marginTop: 8 }}>
              ✅ Escalado proporcional global: NO se suma milímetros directamente, se multiplica cada punto por estos factores.
            </p>
          </div>

          <div className="button-row">
            <button className="secondary" onClick={() => setScreen('upload')}>← Volver</button>
            <button onClick={doScaleAndNest} disabled={loading || targetSize === config.baseSize}>
              {loading ? 'Escalando...' : `📏 Escalar a Talla ${targetSize} y Reacomodar`}
            </button>
          </div>
        </div>
      )}

      {/* PANTALLA 3: NESTING Y EXPORTACIÓN */}
      {screen === 'nest' && nestingResult && (
        <div className="screen">
          <h2>Paso 3: Resultado - Talla {targetSize}</h2>
          <p style={{ color: '#6b7280', marginBottom: 16 }}>
            Las piezas han sido escaladas proporcionalmente y reacomodadas en la hoja. El contorno negro es la pieza original, el azul es la pieza escalada.
          </p>

          <div className="preview-container">
            <canvas ref={nestingPreviewRef} />
          </div>

          <div className="stats-box">
            <h4>📊 Resumen del Nesting</h4>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-label">Piezas reacomodadas</div>
                <div className="stat-value">{nestingResult.pieces.length}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Ancho total lienzo</div>
                <div className="stat-value">{nestingResult.totalWidthMM.toFixed(1)} mm</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Alto total lienzo</div>
                <div className="stat-value">{nestingResult.totalHeightMM.toFixed(1)} mm</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">Tamaño papel</div>
                <div className="stat-value">{nestingResult.paperSize?.toUpperCase()}</div>
              </div>
            </div>
          </div>

          <div className="button-row">
            <button className="secondary" onClick={() => setScreen('detect')}>← Volver</button>
            <button className="success" onClick={handleDownloadDXF}>⬇️ Descargar DXF</button>
            <button className="success" onClick={handleDownloadPDF}>⬇️ Descargar PDF</button>
          </div>

          <div style={{ marginTop: 16 }}>
            <button onClick={reset}>🔄 Nuevo Escaneo</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
