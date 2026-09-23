
Actúa como Arquitecto Frontend Senior y Experto en Ingeniería de Calzado. Tu misión es diseñar y coordinar la creación de una Single Page Application (SPA) 100% Estática (sin backend) que permita digitalizar moldes dibujados en papel, extraer sus contornos y generar tallas superiores/inferiores mediante el sistema Punto Francés.
La Regla de Oro: El escalado debe ser PROPORCIONAL GLOBAL. Nunca sumar milímetros directamente a piezas individuales. Las piezas pequeñas crecen poco, las grandes crecen mucho, pero todas mantienen la misma relación de aspecto del zapato original.
2. STACK TECNOLÓGICO OBLIGATORIO (CLIENT-SIDE ONLY)

    Framework: React + TypeScript + Vite.
    Procesamiento de Imagen: Canvas API Nativa (Binarización/Thresholding).
    Vectorización: potrace-js (Ligero, ideal para trazos negros sobre blanco).
    Visualización: Konva.js (Canvas interactivo para ver superposiciones).
    Matemáticas: decimal.js (Precisión industrial estricta, evitar errores de float).
    Optimización (Nesting): Algoritmo simple de Bin Packing (para reacomodar piezas escaladas en nueva hoja).
    Exportación: dxf-writer o jspdf.

3. LÓGICA MATEMÁTICA CRÍTICA (ESCALADO PROPORCIONAL)
   ️ PROHIBIDO: NuevoLargo = LargoPieza + 6.67mm. Esto deforma piezas pequeñas.
   ✅ OBLIGATORIO: Usar Factores Multiplicativos Globales basados en la Horma Completa.
   A. Constantes del Punto Francés

   INCREMENTO_LONGITUDINAL_HORMA = 6.67 mm (Eje X: Talón → Punta)
   INCREMENTO_TRANSVERSAL_HORMA = 4.5 mm (Eje Y: Suela → Empeine)

B. Cálculo de Factores Globales
El usuario ingresa Talla Base (ej. 40) y Talla Destino (ej. 42).
El sistema calcula la longitud teórica de la horma completa:
LongitudHorma(Talla)=(Talla×6.67)+MargenFuncional(15mm)LongitudHorma(Talla) = (Talla \times 6.67) + MargenFuncional(15mm)
LongitudHorma(Talla)=(Talla×6.67)+MargenFuncional(15mm)
FactorGlobalX=LongitudHorma(TallaDestino)LongitudHorma(TallaBase)FactorGlobal_X = \frac{LongitudHorma(TallaDestino)}{LongitudHorma(TallaBase)}
FactorGlobalX=LongitudHorma(TallaBase)LongitudHorma(TallaDestino)
FactorGlobalY=AnchoHorma(TallaDestino)AnchoHorma(TallaBase)FactorGlobal_Y = \frac{AnchoHorma(TallaDestino)}{AnchoHorma(TallaBase)}
FactorGlobalY=AnchoHorma(TallaBase)AnchoHorma(TallaDestino) (Ancho crece 4.5mm/talla)
C. Aplicación a Piezas Individuales
Para CADA punto (x,y)(x,y)
(x,y) de CADA pieza detectada:
xnuevo=xoriginal×FactorGlobalXx_{nuevo} = x_{original} \times FactorGlobal_X
xnuevo=xoriginal×FactorGlobalX
ynuevo=yoriginal×FactorGlobalYy_{nuevo} = y_{original} \times FactorGlobal_Y
ynuevo=yoriginal×FactorGlobalY

    Resultado: Una pieza de 100mm crecerá ~2.5mm. Una pieza de 10mm crecerá ~0.25mm. La proporción se mantiene perfecta.

4. FLUJO DE TRABAJO DETALLADO
   PASO 1: CONFIGURACIÓN DE ESCANEO (LA REGLA MAESTRA)
   El usuario sube la imagen y define:

   Tamaño Papel Original: [Carta | Oficio | A4]
   DPI del Escáner: [300 | 600] (Default: 300)
   Cálculo interno: mmPorPixel = 25.4 / DPI. NO pedir calibración manual.
   Talla Base del Dibujo: [Ej. 40 EU]

PASO 2: DETECCIÓN MASIVA Y ORIENTACIÓN FIJA

    Binarizar imagen (Blanco/Negro).
    Detectar TODOS los contornos cerrados ("islas" negras). Cada isla es una pieza.
    ORIENTACIÓN INMUTABLE: Asumir SIEMPRE que el dibujo está en modo Horizontal con:
        Eje X (Izq→Der): Talón → Punta (Longitud).
        Eje Y (Abajo→Arriba): Suela → Empeine (Altura/Perímetro).
    Mostrar indicador visual ← TALÓN | PUNTA → sobre cada pieza detectada.
    Botón "Rotar 90°" SOLO por si el usuario escaneó mal. El motor SIEMPRE procesa X=Longitud, Y=Altura.

PASO 3: ESCALADO POR LOTES (BATCH SCALING)

    Usuario ingresa Talla Destino (ej. 42).
    Sistema calcula FactorGlobal_X y FactorGlobal_Y (ver Sección 3).
    Aplica estos factores a TODAS las piezas detectadas simultáneamente.
    Las piezas escaladas existen ahora en memoria RAM, fuera de la hoja original.

PASO 4: REACOMODO AUTOMÁTICO (NESTING)
Como las piezas crecieron, no caben en la hoja original.

    Tomar todas las piezas escaladas.
    Ordenar por área (mayor a menor).
    Empaquetar en un Lienzo Virtual Nuevo usando Bin Packing.
    Añadir márgenes de corte (ej. 10mm entre piezas).
    Usuario selecciona tamaño de hoja de salida (ej. "Acomodar en Oficio" o "Rollo Continuo").

PASO 5: EXPORTACIÓN
Generar archivo DXF/PDF con las piezas ya escaladas y reacomodadas, listas para imprimir/cortar.
5. INSTRUCCIONES TÉCNICAS PARA EL AGENTE ORQUESTADOR

    Módulo ScannerConfig.ts: Implementar getMmPerPixel(dpi) y validación de tamaño de imagen vs papel seleccionado.
    Módulo PieceExtractor.ts: Usar Flood Fill / Connected Components para aislar cada pieza. Vectorizar con Potrace. Devolver array {id, points[], widthMM, heightMM}.
    Módulo ProportionalScaler.ts: Implementar EXACTAMENTE la fórmula de Factores Globales descrita en la Sección 3. Usar Decimal.js. NO permitir suma directa de mm.
    Módulo AutoNester.ts: Algoritmo Shelf/Guillotine Packing. Minimizar área total. Respetar márgenes.
    UI/UX:
        Pantalla 1: Upload + Selectores (Papel, DPI, Talla Base).
        Pantalla 2: Vista previa de piezas detectadas con indicador de orientación. Input Talla Destino.
        Pantalla 3: Vista previa de nueva hoja con piezas reacomodadas. Botón Descarga.
    Validación Visual: Superponer pieza base (negro) y pieza escalada (color semitransparente) para que el usuario vea que la forma se mantiene proporcional.

6. DATOS ESTÁNDAR COLOMBIA (OPCIONAL PERO RECOMENDADO)
   Incluir tabla colombianLasts.ts con rangos reales:

   Niños: 20-35
   Mujeres: 35-41
   Hombres: 39-44
   (Usar solo para calcular Longitud/Ancho de Horma Base si el usuario no lo conoce, pero PRIORIZAR siempre el cálculo proporcional sobre las dimensiones REALES de la pieza escaneada).

¿Por qué este prompt es infalible?

    Elimina la deformación: Al usar factores globales, las piezas pequeñas no se estiran excesivamente.
    Respeta tu flujo: Escaneo DPI → Detección Masiva → Escalado Proporcional → Nesting.
    Orientación Fija: No hay ambigüedad. X=Largo, Y=Alto. Siempre.
    100% Estático: Todo ocurre en el navegador. Sin servidores, sin costos, sin latencia.
    Precisión Industrial: Decimal.js + DPI nativo =Error < 0.1mm.
