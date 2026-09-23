# 👞 Patronaje Calzado V1 - Digitalización de Moldes

SPA 100% estática (sin backend) para digitalizar moldes de calzado dibujados en papel, extraer sus contornos y generar tallas superiores/inferiores mediante el sistema **Punto Francés** con escalado proporcional global.

## 🎯 Regla de Oro Implementada
El escalado es **PROPORCIONAL GLOBAL**. Nunca se suman milímetros directamente a piezas individuales. Se usan factores multiplicativos basados en la longitud y ancho teórico de la horma:

- `FactorGlobalX = LongitudHorma(TallaDestino) / LongitudHorma(TallaBase)`
- `FactorGlobalY = AnchoHorma(TallaDestino) / AnchoHorma(TallaBase)`

Cada punto (x,y) de cada pieza se multiplica por estos factores: las piezas pequeñas crecen poco, las grandes mucho, manteniendo la relación de aspecto perfecta.

## 📊 Constantes del Punto Francés
- Incremento longitudinal por talla: **6.67 mm** (eje X: talón → punta)
- Incremento transversal por talla: **4.5 mm** (eje Y: suela → empeine)
- Margen funcional de horma: **15 mm**

## 🛠️ Stack Tecnológico
- **Framework**: React 18 + TypeScript + Vite
- **Procesamiento de imagen**: Canvas API Nativa (binarización/thresholding)
- **Detección de contornos**: Flood Fill / Componentes Conectados nativo
- **Precisión matemática**: decimal.js
- **Exportación**: DXF (R12 nativo) + PDF (jsPDF)
- **Nesting**: Algoritmo Shelf Packing (Bin Packing)

## 🚀 Flujo de Trabajo de la Aplicación

### Pantalla 1: Configuración de Escaneo
- Selecciona tamaño de papel: Carta / Oficio / A4
- Selecciona DPI (300 / 600)
- Ingresa talla base del dibujo
- Sube la imagen (drag & drop o clic)
- Indicador visual de orientación: ← TALÓN | PUNTA →
- Botón "Rotar 90°" por si escaneaste mal

### Pantalla 2: Detección de Piezas
- Binariza la imagen automáticamente (blanco/negro)
- Detecta TODOS los contornos cerrados usando flood fill
- Muestra cada pieza detectada con su orientación
- Ingresa talla destino
- Muestra los factores globales de escalado calculados

### Pantalla 3: Escalado y Reacomodo (Nesting)
- Aplica el escalado proporcional a TODAS las piezas simultáneamente
- Reacomoda automáticamente las piezas escaladas en una nueva hoja usando Bin Packing
- Añade márgenes de corte de 10mm
- Validación visual: superpone pieza original (negro) y escalada (azul semitransparente)
- Exporta a **DXF** (para cortadora/plotter) o **PDF** (para imprimir)

## 📁 Estructura del Código
```
src/
├── modules/
│   ├── colombianLasts.ts     # Tabla de tallas estándar Colombia (niños/mujeres/hombres)
│   ├── ScannerConfig.ts      # Cálculo mm/pixel, validación de papel/DPI
│   ├── PieceExtractor.ts     # Binarización, flood fill, extracción de contornos
│   ├── ProportionalScaler.ts # LÓGICA MATEMÁTICA DEL ESCALADO PROPORCIONAL
│   ├── AutoNester.ts         # Algoritmo Shelf Packing para reacomodo
│   └── Exporter.ts           # Exportación DXF/PDF
├── App.tsx                   # Interfaz de usuario (3 pantallas)
├── main.tsx
└── index.css
```

## ▶️ Ejecutar
```bash
npm install
npm run dev      # Servidor desarrollo en http://localhost:5173
npm run build    # Compilar para producción (carpeta dist/)
```

## 📐 Datos Estándar Colombia
- Niños: tallas 20–35
- Mujeres: tallas 35–41
- Hombres: tallas 39–44

## ✅ Características Clave
- 100% en el navegador: sin servidores, sin costos, sin latencia
- Precisión industrial: decimal.js + cálculo nativo por DPI = error < 0.1mm
- Orientación fija: X = Longitud, Y = Altura (sin ambigüedad)
- No deforma piezas pequeñas: escalado multiplicativo global, NO suma de mm
- Exportación lista para imprimir/cortar
