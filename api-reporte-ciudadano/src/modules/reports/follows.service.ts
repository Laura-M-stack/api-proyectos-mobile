import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import { esViolacionDeUnicidad } from '../../common/db/uniqueness.js';
import { ErrorApi } from '../../common/errors/catalog.js';
import { nuevoId } from '../../common/ids/ids.js';
import { Reloj } from '../../common/clock/clock.js';
import { saltoYTamano, type Pagina } from '../../common/response/response.js';
import type { Usuario } from '../users/user.entity.js';
import { AvisosDeReportes } from './report-notices.service.js';
import { Adhesion } from './follow.entity.js';
import { Reporte } from './report.entity.js';
import { esEstadoAbierto } from './rules/statuses.js';
import { ServicioReportes, type ReporteCompleto } from './reports.service.js';

@Injectable()
export class ServicioAdhesiones {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Reporte) private readonly reportes: Repository<Reporte>,
    @InjectRepository(Adhesion)
    private readonly adhesiones: Repository<Adhesion>,
    private readonly servicioReportes: ServicioReportes,
    private readonly reloj: Reloj,
    private readonly avisos: AvisosDeReportes,
  ) {}

  /** Sumarse a un reporte ajeno y abierto (R10). `creada` es false si ya estaba sumado. */
  async sumar(
    reporteId: string,
    vecino: Usuario,
  ): Promise<ReporteCompleto & { creada: boolean }> {
    const reporte = await this.reportes.findOneBy({ id: reporteId });
    if (!reporte) throw new ErrorApi('REPORTE_NO_ENCONTRADO');
    if (reporte.autorId === vecino.id) {
      throw new ErrorApi('ADHESION_A_REPORTE_PROPIO');
    }
    const previa = await this.adhesiones.existsBy({
      reporteId,
      usuarioId: vecino.id,
    });
    if (previa) return this.respuesta(reporteId, false);
    if (!esEstadoAbierto(reporte.estado)) throw new ErrorApi('REPORTE_CERRADO');

    try {
      await this.dataSource.transaction(async (manager) => {
        // Toma el lock de la fila del reporte antes de insertar y contar: dos personas que se
        // suman a la vez esperan una a la otra y el recuento final ve las dos adhesiones.
        await manager.update(
          Reporte,
          { id: reporteId },
          { adhesiones: () => 'adhesiones' },
        );
        await manager.insert(
          Adhesion,
          Object.assign(new Adhesion(), {
            id: nuevoId('adh'),
            reporteId,
            usuarioId: vecino.id,
            creadoEn: this.reloj.ahora(),
          }),
        );
        await recalcularAdhesiones(manager, reporteId);
      });
    } catch (error) {
      // La misma persona, en otro pedido simultáneo, ya se había sumado.
      if (!esViolacionDeUnicidad(error)) throw error;
      return this.respuesta(reporteId, false);
    }
    const respuesta = await this.respuesta(reporteId, true);
    await this.avisos.adhesion(reporte, respuesta.reporte.adhesiones);
    return respuesta;
  }

  /**
   * Los reportes a los que el vecino se sumó, del más nuevo al más viejo (por la fecha en que
   * se sumó). Incluye los cerrados: el vecino quiere ver en qué terminó lo que apoyó. Un
   * reporte que se marcó como duplicado deja al autor sumado al original, así que también
   * aparece acá.
   */
  async listarDe(
    usuarioId: string,
    pagina: Pagina,
  ): Promise<[ReporteCompleto[], number]> {
    const [adhesiones, total] = await this.adhesiones.findAndCount({
      where: { usuarioId },
      order: { creadoEn: 'DESC', id: 'DESC' },
      ...saltoYTamano(pagina),
    });
    if (adhesiones.length === 0) return [[], total];
    const reportes = await this.reportes.findBy({
      id: In(adhesiones.map((a) => a.reporteId)),
    });
    const porId = new Map(reportes.map((r) => [r.id, r]));
    // Mismo orden que las adhesiones; un reporte borrado de la base no rompe la lista.
    const ordenados = adhesiones
      .map((a) => porId.get(a.reporteId))
      .filter((r): r is Reporte => r !== undefined);
    return [await this.servicioReportes.conFotos(ordenados), total];
  }

  private async respuesta(reporteId: string, creada: boolean) {
    const completo = await this.servicioReportes.obtener(reporteId);
    return { ...completo, creada };
  }
}

/** `adhesiones` sale de contar la tabla, no de sumar 1 (AGENTS §5.5). */
export async function recalcularAdhesiones(
  manager: DataSource['manager'],
  reporteId: string,
): Promise<number> {
  const total = await manager.countBy(Adhesion, { reporteId });
  await manager.update(Reporte, { id: reporteId }, { adhesiones: total });
  return total;
}
