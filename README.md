# 👞 Escalado de Calzado (estilo CorelDRAW) — versión web

SPA 100 % estática (sin backend) que replica la macro de CorelDRAW `EscalarCalzado`:
se carga el escaneo del molde, se detecta el recuadro del molde (el "grupo" que
seleccionarías en Corel), se generan las tallas con `Stretch(factorAncho, factorLargo)`
sobre el molde completo y **cada talla sale enumerada y en su propia hoja lista para
imprimir**.

## Qué hace

1. **Carga y detección**: sube el JPG/PNG del escaneo (300 o 600 DPI). El recuadro del
   molde se detecta solo, ignorando los bordes negros/sombras del escáner y el polvo.
   Puedes ajustarlo arrastrando sobre la imagen o rotar la imagen 90°.
2. **Escalado (igual que la macro)**:
   - Molde: `+3.33 mm` de ancho y `+6.67 mm` de largo por talla.
   - Plantilla: `+4.18 mm` de ancho y `+8.34 mm` de largo por talla.
   - `factorAncho = (refAncho + incAncho × dif) / refAncho`, `factorLargo = (refLargo + incLargo × dif) / refLargo`,
     donde la **referencia** son las medidas del molde completo: por defecto la hoja escaneada
     completa (o medidas manuales del molde completo). Los factores se aplican a lo escaneado
     (Stretch), así una pieza suelta (talón, puntera…) crece en la misma proporción que el
     molde entero y nunca se le suman los mm directamente.
   - El log es el mismo de la macro (ANTES / DESPUES / Δ mm por talla).
3. **Enumeración automática**:
   - Cada hoja lleva en grande `TALLA 38`, `Hoja 2 de 4 (fila 1 / columna 2)`, un
     mini-mapa de la cuadrícula de hojas y los factores usados.
   - **Re-enumeración de todas las piezas**: los números de talla escritos en el molde
     base se detectan solos (o se marcan a mano, uno por pieza, incluso girados 90°) y en
     cada copia se borran y se escribe la talla nueva en el mismo lugar de cada pieza.
     Si no hay números marcados, la talla se estampa en una esquina del molde.
4. **Una talla por hoja, en papel real**: Carta, Oficio, A4, A3, Doble carta o
   "plotter" (hoja a medida). Orientación automática (la que use menos hojas).
   Si una talla no cabe, se divide en varias hojas con **solape** y **cruces de registro**
   (mismas coordenadas del molde en las dos hojas vecinas) e instrucciones de montaje.
   Cada hoja incluye una **barra de control de 100 mm** para comprobar que la impresora
   no re-escaló (imprimir siempre al 100 %, sin "ajustar a la página").
5. **Exportación**:
   - `Descargar PDF para imprimir`: un PDF multipágina, cada talla en su(s) hoja(s).
   - `PDF` por talla (archivo separado) y `PNG` por talla a la resolución del escaneo.
   - `PDF plotter`: todas las tallas en fila en una sola hoja a medida (comportamiento de
     la macro; sólo para plotter/rollo).
   - Log en texto plano.

## Ejecutar

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # producción en dist/
```

Hay un botón **"Probar con una imagen de ejemplo"** (molde talla 36, Carta a 300 DPI) para
ver el flujo completo sin escanear nada.

## Estructura

```
src/
├── modules/
│   ├── CorelStyleScaler.ts   # Factores de la macro (molde/plantilla) y lista de tallas
│   ├── ImageLoader.ts        # Carga, rotación, recorte, blanqueo y detección robusta del recuadro
│   ├── PageLayout.ts         # Paginación: hojas por talla, mosaico con solape, orientación automática
│   ├── PdfExporter.ts        # PDF multipágina (jsPDF): encabezados, número sobre el molde, cruces, barra 100 mm
│   ├── ScannerConfig.ts      # DPI → mm/px y tamaños de papel
│   └── colombianLasts.ts     # Tabla de referencia de tallas (Colombia)
├── components/
│   ├── RectSelector.tsx      # Dibujar/ajustar rectángulos sobre la imagen (recuadro y número)
│   └── SizePreview.tsx       # Vista previa de cada talla con su reparto en hojas
├── App.tsx                   # Flujo: cargar → recuadro/talla/numeración → resultado e impresión
└── index.css
```

## Notas de precisión

- `mmPorPixel = 25.4 / DPI`; con 300 DPI el error es < 0.1 mm.
- El eje LARGO del molde (talón → punta, +6.67 mm/talla) es el eje **vertical** de la
  imagen; si el molde está acostado, usa "Rotar 90°".
- La imagen del molde se incrusta una sola vez en el PDF y se dibuja en cada hoja con el
  Stretch de su talla, así el archivo pesa poco aunque tenga muchas hojas.
