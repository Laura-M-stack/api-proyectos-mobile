import { Entity, Index } from 'typeorm';
import type { Plataforma } from '../../contract/api.js';
import { ColumnaClave, ColumnaEnum, ColumnaRef } from '../common/db/columns.js';

/** Largo máximo del token: el mismo que acepta el DTO de POST /dispositivos. */
export const LARGO_TOKEN_EXPO = 200;

/**
 * Un teléfono que recibe push. El token es la clave primaria: un token es de UN solo usuario a
 * la vez (si otro usuario lo registra, la fila pasa a ése) y la base garantiza que no se repita
 * aunque lleguen dos pedidos juntos.
 */
@Entity('dispositivos')
@Index(['usuarioId'])
export class DispositivoPush {
  @ColumnaClave(LARGO_TOKEN_EXPO)
  tokenExpo: string;

  @ColumnaRef()
  usuarioId: string;

  @ColumnaEnum()
  plataforma: Plataforma;
}
