/**
 * Replicación EXACTA de la lógica del macro de CorelDRAW ThisMacroStorage_EscalarCalzado.
 *
 * CorelDRAW trabaja en pulgadas; aquí lo hacemos todo en mm (1 pulgada = 25.4 mm).
 *
 * Increíble pero la macro SÍ suma milímetros al BoundingBox COMPLETO del molde agrupado:
 *   - Molde:       +3.33 mm ancho (Y en Corel), +6.67 mm largo (X en Corel)
 *   - Plantilla:   +4.18 mm ancho,             +8.34 mm largo
 * Esto es diferente del "escalado proporcional global" descrito en el plan.md:
 * la macro adapta los factores al tamaño REAL del cuadro escaneado (bounding box),
 * no al tamaño teórico de horma.
 *
 *   factorAncho = (baseWidth + incAnchoMM * diferenciaTallas) / baseWidth
 *   factorLargo = (baseHeight + incLargoMM * diferenciaTallas) / baseHeight
 *
 * Luego se hace Stretch sobre el grupo entero (igual que newShape.Stretch en Corel).
 *
 * IMPORTANTE — el papel físico NO crece; sólo crecen las piezas.
 * En Corel el grupo seleccionado es el bitmap de la HOJA (Carta, Tabloide…).
 * Las piezas van sueltas al CENTRO de esa hoja (no llenan la horma real).
 * Los +3.33 / +6.67 mm se miden sobre esa hoja (`refBox`), y el mismo factor
 * se aplica a las piezas (`baseBox`):
 *
 *   factorAncho = (hojaAncho + incAncho * dif) / hojaAncho
 *   factorLargo = (hojaLargo + incLargo * dif) / hojaLargo
 *   piezaNueva  = pieza * factor
 *
 * Un talón de 38 × 116 mm en una Carta de 216 × 280 mm crece ~0.59 × 2.77 mm
 * por talla, no 3.33 × 6.67. La hoja de la impresora sigue siendo Carta.
 */

export type Mode = 'molde' | 'plantilla';

export const INC_MOLDE_ANCHO_MM = 3.33;
export const INC_MOLDE_LARGO_MM = 6.67;
export const INC_PLANTILLA_ANCHO_MM = 4.18;
export const INC_PLANTILLA_LARGO_MM = 8.34;
export const MM_PER_INCH = 25.4;

export interface BoundingBoxMM {
  /** Ancho en mm (corresponde a Width en CorelDRAW, que es el eje Y transversal) */
  widthMM: number;
  /** Alto/Largo en mm (corresponde a Height en CorelDRAW, que es el eje X longitudinal) */
  heightMM: number;
}

export interface ScaleResult {
  size: number;
  factorAncho: number;
  factorLargo: number;
  deltaAnchoMM: number;
  deltaLargoMM: number;
  newWidthMM: number;
  newHeightMM: number;
  offsetXMM: number; // desplazamiento acumulado para colocar al lado
}

/** Incrementos por talla (mm) según el modo. */
export function incrementos(mode: Mode): { incAncho: number; incLargo: number } {
  return mode === 'plantilla'
    ? { incAncho: INC_PLANTILLA_ANCHO_MM, incLargo: INC_PLANTILLA_LARGO_MM }
    : { incAncho: INC_MOLDE_ANCHO_MM, incLargo: INC_MOLDE_LARGO_MM };
}

/**
 * Calcula los factores de escalado EXACTAMENTE como la macro de Corel, sobre
 * la REFERENCIA (molde completo).
 *
 * @param mode      'molde' o 'plantilla'
 * @param refBox    Medidas de referencia en mm (molde completo / hoja escaneada)
 * @param tallaBase Talla base
 * @param talla     Talla destino
 */
export function calcularFactores(
  mode: Mode,
  refBox: BoundingBoxMM,
  tallaBase: number,
  talla: number
): { factorAncho: number; factorLargo: number } {
  const diff = talla - tallaBase;
  const { incAncho, incLargo } = incrementos(mode);

  const factorAncho = (refBox.widthMM + incAncho * diff) / refBox.widthMM;
  const factorLargo = (refBox.heightMM + incLargo * diff) / refBox.heightMM;

  return { factorAncho, factorLargo };
}

/**
 * Genera la lista de tallas y sus factores, con los desplazamientos para
 * colocar cada copia al lado de la anterior (como hace la macro:
 *   desplazamiento += newShape.SizeWidth + 25
 *   newShape.Move(desplazamiento, 0)
 * en mm).
 */
export function generarEscalas(
  mode: Mode,
  baseBox: BoundingBoxMM,
  tallaBase: number,
  tallaMenor: number,
  tallaMayor: number,
  gapMM: number = 25,
  /** Referencia para los factores (molde completo). Por defecto, el propio recuadro. */
  refBox: BoundingBoxMM = baseBox,
): ScaleResult[] {
  const results: ScaleResult[] = [];
  let offsetMM = 0;

  for (let talla = tallaMenor; talla <= tallaMayor; talla++) {
    const { factorAncho, factorLargo } = calcularFactores(mode, refBox, tallaBase, talla);

    const newWidthMM = baseBox.widthMM * factorAncho;
    const newHeightMM = baseBox.heightMM * factorLargo;
    // Crecimiento REAL de lo escaneado (si es una pieza, crece menos que el molde completo)
    const deltaAnchoMM = newWidthMM - baseBox.widthMM;
    const deltaLargoMM = newHeightMM - baseBox.heightMM;

    results.push({
      size: talla,
      factorAncho,
      factorLargo,
      deltaAnchoMM,
      deltaLargoMM,
      newWidthMM,
      newHeightMM,
      offsetXMM: offsetMM,
    });

    // El desplazamiento para la siguiente talla se acumula con el ancho de ESTA talla + gap
    // (igual que en Corel: desplazamiento += newShape.SizeWidth + 25)
    offsetMM += newWidthMM + gapMM;
  }

  return results;
}
