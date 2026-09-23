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

/**
 * Calcula los factores de escalado EXACTAMENTE como la macro de Corel.
 *
 * @param mode      'molde' o 'plantilla'
 * @param baseBox   BoundingBox del molde base en mm
 * @param tallaBase Talla base detectada
 * @param talla     Talla destino
 */
export function calcularFactores(
  mode: Mode,
  baseBox: BoundingBoxMM,
  tallaBase: number,
  talla: number
): { factorAncho: number; factorLargo: number } {
  const diff = talla - tallaBase;
  const incAncho = mode === 'plantilla' ? INC_PLANTILLA_ANCHO_MM : INC_MOLDE_ANCHO_MM;
  const incLargo = mode === 'plantilla' ? INC_PLANTILLA_LARGO_MM : INC_MOLDE_LARGO_MM;

  const factorAncho = (baseBox.widthMM + incAncho * diff) / baseBox.widthMM;
  const factorLargo = (baseBox.heightMM + incLargo * diff) / baseBox.heightMM;

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
  gapMM: number = 25
): ScaleResult[] {
  const results: ScaleResult[] = [];
  let offsetMM = 0;

  for (let talla = tallaMenor; talla <= tallaMayor; talla++) {
    const diff = talla - tallaBase;
    const { factorAncho, factorLargo } = calcularFactores(mode, baseBox, tallaBase, talla);
    const incAncho = mode === 'plantilla' ? INC_PLANTILLA_ANCHO_MM : INC_MOLDE_ANCHO_MM;
    const incLargo = mode === 'plantilla' ? INC_PLANTILLA_LARGO_MM : INC_MOLDE_LARGO_MM;

    const newWidthMM = baseBox.widthMM * factorAncho;
    const newHeightMM = baseBox.heightMM * factorLargo;
    const deltaAnchoMM = diff * incAncho;
    const deltaLargoMM = diff * incLargo;

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
