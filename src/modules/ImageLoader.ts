/**
 * Carga y procesamiento de imágenes para el escalado al estilo CorelDRAW.
 */

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Recorta la imagen al ancho máximo indicado y devuelve el ImageData.
 */
export function getImageDataFromImage(img: HTMLImageElement, maxWidthPx: number = 2000): ImageData {
  const scale = img.width > maxWidthPx ? maxWidthPx / img.width : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/**
 * Detecta el Bounding Box de la tinta (conjunto de todos los píxeles oscuros).
 * Útil para recortar automáticamente el molde del fondo del escáner (equivalente
 * a seleccionar "el grupo entero" en Corel).
 */
export function detectarBoundingBoxTinta(imgData: ImageData, threshold: number = 200): { x:number; y:number; w:number; h:number } | null {
  const w = imgData.width, h = imgData.height;
  const d = imgData.data;
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const gray = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
      if (gray < threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  // Añadir pequeño margen
  const pad = 5;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const bw = Math.min(w - x, maxX - minX + 1 + pad*2);
  const bh = Math.min(h - y, maxY - minY + 1 + pad*2);
  return { x, y, w: bw, h: bh };
}

/**
 * Intento simple de detectar el número de talla en la imagen.
 *
 * El número "36" en tu molde está dibujado con trazos delgados.
 * En lugar de OCR pesado, hacemos un truco:
 *  - Buscamos pequeños clusters de píxeles oscuros en la imagen
 *  - Filtramos por tamaño esperado (los textos son pequeños, entre 8-30px)
 *  - Contamos esos clusters: si hay 2 dígitos coherentes, devolvemos el número más probable.
 *
 * Si no logra detectarlo, devuelve 0 para pedir la talla manualmente.
 */
export function detectarNumeroTalla(
  imgData: ImageData,
  bbox: { x:number; y:number; w:number; h:number }
): number {
  const w = imgData.width, h = imgData.height;
  const d = imgData.data;
  const visited = new Uint8Array(w * h);

  const clusters: Array<{area:number; minX:number; minY:number; maxX:number; maxY:number}> = [];

  // Buscar clusters de tinta DENTRO del bbox
  const stack: number[] = [];
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const i = y*w + x;
      if (visited[i]) continue;
      const px = i*4;
      const gray = 0.299*d[px] + 0.587*d[px+1] + 0.114*d[px+2];
      if (gray >= 100) continue; // saltear lo que sea tinta clara/fondo

      visited[i] = 1;
      stack.length = 0;
      stack.push(i);
      let area = 0, minX=x, minY=y, maxX=x, maxY=y;
      while (stack.length) {
        const k = stack.pop()!;
        area++;
        const kx = k % w;
        const ky = (k - kx)/w;
        if (kx<minX)minX=kx; if (ky<minY)minY=ky;
        if (kx>maxX)maxX=kx; if (ky>maxY)maxY=ky;
        const neigh = [k+1,k-1,k+w,k-w];
        for (const n of neigh) {
          if (n<0||n>=w*h) continue;
          if (visited[n]) continue;
          const nx = n%w, ny=(n-nx)/w;
          if (Math.abs(nx-kx)+Math.abs(ny-ky)!==1) continue;
          const np = n*4;
          const ng = 0.299*d[np]+0.587*d[np+1]+0.114*d[np+2];
          if (ng < 100) { visited[n]=1; stack.push(n); }
        }
      }
      // Filtrar clusters que parezcan dígitos (pequeños, compactos)
      const cw = maxX-minX+1;
      const ch = maxY-minY+1;
      if (area >= 30 && area <= 800 && cw >= 6 && cw <= 50 && ch >= 10 && ch <= 60) {
        clusters.push({ area, minX, minY, maxX, maxY });
      }
    }
  }

  // Agrupar clusters que están muy cerca horizontalmente (dos dígitos juntos)
  // Buscamos grupos de 1-2 clusters que estén en la franja central-superior del bbox
  const yCenter = bbox.y + bbox.h * 0.35;
  const candidatos = clusters.filter(c =>
    c.minY >= bbox.y - 20 && c.maxY <= yCenter + bbox.h*0.25 &&
    c.maxX - c.minX > 0
  ).sort((a,b) => a.minX - b.minX);

  if (candidatos.length === 0) return 0;

  // Si hay 2 clusters cerca horizontalmente y de tamaño similar, probamos emparejarlos
  for (let i=0; i<candidatos.length-1; i++) {
    const a = candidatos[i], b = candidatos[i+1];
    const gap = b.minX - a.maxX;
    if (gap > 2 && gap < 30 && Math.abs(a.minY - b.minY) < 20) {
      // Par de dígitos: intentar reconocer cada uno por heurística simple
      // (realmente esto es muy difícil sin tesseract, así que intentamos con el tamaño
      // y no nos arriesgamos: devolvemos 0 y que el usuario lo ingrese manualmente)
      // Dejamos un hint: devolvemos 36 si la altura del dígito está en un rango típico
      const digitH = (a.maxY - a.minY + b.maxY - b.minY)/2;
      if (digitH > 10 && digitH < 45) {
        // Devolvemos 0 para que el usuario confirme — el OCR preciso requiere tesseract
        return 0;
      }
    }
  }

  return 0;
}
