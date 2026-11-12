import { Injectable, Logger } from '@nestjs/common';
import type {
  EnviadorPush,
  MensajePush,
} from '../common/notifications/ports.js';

/** Expo acepta hasta 100 mensajes por pedido. */
export const TANDA_EXPO = 100;

/** Cuánto se espera a Expo antes de abandonar una tanda (no puede colgar la API). */
const TIEMPO_LIMITE_MS = 10_000;

/** Un mensaje con la forma que pide Expo: uno por token. */
interface MensajeExpo {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: 'default';
}

/** Lo que contesta Expo: un ticket por mensaje, en el mismo orden en que se mandaron. */
interface TicketExpo {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Manda las push al servicio de Expo (docs/NOTIFICATIONS.md).
 *
 * Reglas:
 *  - Un mensaje por token, en tandas de a 100.
 *  - Los tokens que Expo marca con DeviceNotRegistered vuelven en `tokensInvalidos` para que la
 *    API los borre.
 *  - Si Expo falla (no responde, 5xx, JSON roto) NO se tira el error: se anota en el log y se
 *    sigue con la próxima tanda. Una push que no sale nunca rompe lo que estaba haciendo el
 *    usuario, y los tokens de esa tanda se conservan (no sabemos si son inválidos).
 */
@Injectable()
export class EnviadorExpo implements EnviadorPush {
  private readonly logger = new Logger('Expo');

  constructor(readonly url: string) {}

  async enviar(
    mensajes: MensajePush[],
  ): Promise<{ tokensInvalidos: string[] }> {
    const individuales: MensajeExpo[] = mensajes.flatMap((m) =>
      m.tokens.map((to) => ({
        to,
        title: m.titulo,
        body: m.cuerpo,
        data: m.datos,
        sound: 'default' as const,
      })),
    );

    const tokensInvalidos: string[] = [];
    for (let i = 0; i < individuales.length; i += TANDA_EXPO) {
      const tanda = individuales.slice(i, i + TANDA_EXPO);
      tokensInvalidos.push(...(await this.enviarTanda(tanda)));
    }
    return { tokensInvalidos };
  }

  /** Manda una tanda y devuelve los tokens dados de baja. Nunca lanza. */
  private async enviarTanda(tanda: MensajeExpo[]): Promise<string[]> {
    let respuesta: Response;
    try {
      respuesta = await fetch(this.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tanda),
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo hablar con Expo (${tanda.length} mensajes): ${(error as Error).message}`,
      );
      return [];
    }

    if (!respuesta.ok) {
      this.logger.warn(
        `Expo respondió ${respuesta.status} a una tanda de ${tanda.length} mensajes`,
      );
      return [];
    }

    let tickets: TicketExpo[];
    try {
      const cuerpo = (await respuesta.json()) as { data?: unknown };
      if (!Array.isArray(cuerpo.data)) throw new Error('falta "data"');
      tickets = cuerpo.data as TicketExpo[];
    } catch (error) {
      this.logger.warn(
        `Expo devolvió una respuesta que no se entiende: ${(error as Error).message}`,
      );
      return [];
    }

    const invalidos: string[] = [];
    tickets.forEach((ticket, indice) => {
      if (ticket?.status !== 'error') return;
      const token = tanda[indice]?.to;
      if (!token) return;
      if (ticket.details?.error === 'DeviceNotRegistered')
        invalidos.push(token);
      else
        this.logger.warn(
          `Expo no pudo mandar a un dispositivo: ${ticket.details?.error ?? ticket.message ?? 'error sin detalle'}`,
        );
    });
    return invalidos;
  }
}
