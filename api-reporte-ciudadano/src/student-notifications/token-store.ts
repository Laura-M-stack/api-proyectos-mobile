import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import type { Plataforma } from '../../contract/api.js';
import { esViolacionDeUnicidad } from '../common/db/uniqueness.js';
import type { AlmacenTokensPush } from '../common/notifications/ports.js';
import { DispositivoPush } from './push-token.entity.js';

/**
 * Los tokens de Expo de cada usuario, en la tabla `dispositivos` (docs/NOTIFICATIONS.md).
 *
 * Por qué alcanza con la base y no hace falta un `if` ni un lock: el token es la clave
 * primaria y `guardar` es un upsert (INSERT ... ON CONFLICT / ON DUPLICATE KEY UPDATE), que es
 * UNA sola sentencia atómica en los cuatro motores. Dos pedidos simultáneos con el mismo token
 * terminan en una sola fila; si los manda otro usuario, la fila queda del último.
 */
@Injectable()
export class AlmacenTokensBase implements AlmacenTokensPush {
  constructor(
    @InjectRepository(DispositivoPush)
    private readonly dispositivos: Repository<DispositivoPush>,
  ) {}

  async guardar(
    usuarioId: string,
    tokenExpo: string,
    plataforma: Plataforma,
  ): Promise<void> {
    try {
      await this.dispositivos.upsert(
        { tokenExpo, usuarioId, plataforma },
        { conflictPaths: ['tokenExpo'] },
      );
    } catch (error) {
      // Red de seguridad: si algún motor igual reporta la carrera como violación de unicidad,
      // la fila ya existe y alcanza con dejarla con los datos de este pedido.
      if (!esViolacionDeUnicidad(error)) throw error;
      await this.dispositivos.update({ tokenExpo }, { usuarioId, plataforma });
    }
  }

  async borrar(tokenExpo: string): Promise<void> {
    // delete de algo que no existe no falla: borrar dos veces es lo mismo que una.
    await this.dispositivos.delete({ tokenExpo });
  }

  async tokensDe(usuarioIds: string[]): Promise<string[]> {
    if (usuarioIds.length === 0) return [];
    const filas = await this.dispositivos.find({
      where: { usuarioId: In(usuarioIds) },
      select: { tokenExpo: true },
      order: { tokenExpo: 'ASC' },
    });
    return filas.map((f) => f.tokenExpo);
  }

  async descartar(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.dispositivos.delete({ tokenExpo: In(tokens) });
  }
}
