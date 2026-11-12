// Endpoints agregados por el grupo (issue: "Agregar GET /yo/adhesiones y PATCH /reportes/:id/zona").
import { crearApp, type AppDePrueba } from '../utilities/create-app.js';
import { esperarContrato, esperarError } from '../utilities/contract.js';
import { crearCuadrilla, crearTipo, crearZona } from '../utilities/catalogs.js';
import {
  crearOperador,
  crearVecino,
  type UsuarioDePrueba,
} from '../utilities/users.js';
import { crearCambio, crearReporte } from '../utilities/reports.js';
import type { EstadoReporte } from '../../contract/types.js';
import { Adhesion } from '../../src/modules/reports/follow.entity.js';
import { CambioDeEstado } from '../../src/modules/reports/status-change.entity.js';
import { FotoDeReporte } from '../../src/modules/reports/photo.entity.js';
import { Reporte } from '../../src/modules/reports/report.entity.js';

const AHORA = '2026-09-14T10:00:00-03:00';

let ctx: AppDePrueba;
let autor: UsuarioDePrueba;
let ana: UsuarioDePrueba;
let beto: UsuarioDePrueba;
let op: UsuarioDePrueba;
let tipoId: string;
let cuadrillaA: string;
let cuadrillaB: string;

beforeAll(async () => {
  ctx = await crearApp({ ahora: AHORA });
  autor = await crearVecino(ctx);
  ana = await crearVecino(ctx);
  beto = await crearVecino(ctx);
  op = await crearOperador(ctx, { zonaId: 'zon-norte' });
  tipoId = (await crearTipo(ctx, { id: 'tip-bache' })).id;
  await crearZona(ctx, { id: 'zon-norte', nombre: 'Zona A' });
  await crearZona(ctx, { id: 'zon-sur', nombre: 'Zona B' });
  cuadrillaA = (
    await crearCuadrilla(ctx, { zonaId: 'zon-norte', nombre: 'Cuadrilla A' })
  ).id;
  cuadrillaB = (
    await crearCuadrilla(ctx, { zonaId: 'zon-sur', nombre: 'Cuadrilla B' })
  ).id;
});
afterAll(() => ctx.cerrar());

beforeEach(async () => {
  ctx.reloj.mover(AHORA);
  await ctx.dataSource.getRepository(Adhesion).clear();
  await ctx.dataSource.getRepository(CambioDeEstado).clear();
  await ctx.dataSource.getRepository(FotoDeReporte).clear();
  await ctx.dataSource.getRepository(Reporte).clear();
});

async function reporte(
  estado: EstadoReporte = 'recibido',
  extra: Partial<Reporte> = {},
): Promise<Reporte> {
  const r = await crearReporte(ctx, {
    autorId: autor.usuario.id,
    tipoId,
    zonaId: 'zon-norte',
    estado,
    ...extra,
  });
  await crearCambio(ctx, { reporteId: r.id, estado });
  return r;
}

const sumar = (id: string, quien: UsuarioDePrueba) =>
  ctx
    .http()
    .post(`/reportes/${id}/adhesiones`)
    .set(...quien.auth);

const misAdhesiones = (quien: UsuarioDePrueba, query = '') =>
  ctx
    .http()
    .get(`/yo/adhesiones${query}`)
    .set(...quien.auth);

const cambiarZona = (id: string, cuerpo: object, quien = op) =>
  ctx
    .http()
    .patch(`/reportes/${id}/zona`)
    .set(...quien.auth)
    .send(cuerpo);

const enBase = (id: string) =>
  ctx.dataSource.getRepository(Reporte).findOneByOrFail({ id });

const cambiosDe = (reporteId: string) =>
  ctx.dataSource
    .getRepository(CambioDeEstado)
    .find({ where: { reporteId }, order: { secuencia: 'ASC' } });

describe('GET /yo/adhesiones', () => {
  it('sin adhesiones: lista vacía con el sobre de siempre', async () => {
    const res = await misAdhesiones(ana);
    expect(res.status).toBe(200);
    expect(res.body.datos).toEqual([]);
    expect(res.body.meta).toEqual({ total: 0, pagina: 1, porPagina: 20 });
  });

  it('los reportes a los que me sumé, del más nuevo al más viejo', async () => {
    const viejo = await reporte();
    const nuevo = await reporte();
    await sumar(viejo.id, ana).expect(201);
    ctx.reloj.mover('2026-09-14T11:00:00-03:00');
    await sumar(nuevo.id, ana).expect(201);

    const res = await misAdhesiones(ana);
    expect(res.status).toBe(200);
    esperarContrato(res, 'Reporte');
    expect(res.body.datos.map((r: { id: string }) => r.id)).toEqual([
      nuevo.id,
      viejo.id,
    ]);
    expect(res.body.meta.total).toBe(2);
  });

  it('no muestra las adhesiones de otros vecinos', async () => {
    const r = await reporte();
    await sumar(r.id, beto).expect(201);
    expect((await misAdhesiones(ana)).body.datos).toEqual([]);
    expect((await misAdhesiones(beto)).body.datos).toHaveLength(1);
  });

  it('sigue mostrando el reporte aunque después se haya resuelto', async () => {
    const r = await reporte();
    await sumar(r.id, ana).expect(201);
    await ctx.dataSource
      .getRepository(Reporte)
      .update({ id: r.id }, { estado: 'resuelto' });
    const res = await misAdhesiones(ana);
    expect(res.body.datos).toHaveLength(1);
    expect(res.body.datos[0].estado).toBe('resuelto');
  });

  it('pagina como las demás listas', async () => {
    for (let i = 0; i < 3; i++) {
      ctx.reloj.mover(`2026-09-14T1${i}:00:00-03:00`);
      await sumar((await reporte()).id, ana).expect(201);
    }
    const res = await misAdhesiones(ana, '?pagina=2&porPagina=2');
    expect(res.status).toBe(200);
    expect(res.body.datos).toHaveLength(1);
    expect(res.body.meta).toEqual({ total: 3, pagina: 2, porPagina: 2 });
  });

  it('401 sin sesión', async () => {
    esperarError(await ctx.http().get('/yo/adhesiones'), 401, 'NO_AUTENTICADO');
  });
});

describe('PATCH /reportes/:id/zona', () => {
  it('sin cuadrilla: cambia la zona y no agrega cambios de estado', async () => {
    const r = await reporte('en_revision');
    const res = await cambiarZona(r.id, { zonaId: 'zon-sur' });
    expect(res.status).toBe(200);
    esperarContrato(res, 'Reporte');
    expect(res.body.datos.zonaId).toBe('zon-sur');
    expect(res.body.datos.estado).toBe('en_revision');
    expect(await cambiosDe(r.id)).toHaveLength(1);
  });

  it('con una cuadrilla de otra zona: se suelta, vuelve a en_revision y queda el cambio', async () => {
    const r = await reporte('asignado', { cuadrillaId: cuadrillaA });
    const res = await cambiarZona(r.id, { zonaId: 'zon-sur' });
    expect(res.status).toBe(200);
    expect(res.body.datos.zonaId).toBe('zon-sur');
    expect(res.body.datos.estado).toBe('en_revision');
    expect(res.body.datos.cuadrillaId).toBeNull();

    const cambios = await cambiosDe(r.id);
    expect(cambios).toHaveLength(2);
    const ultimo = cambios[1]!;
    expect(ultimo.estado).toBe('en_revision');
    expect(ultimo.operadorId).toBe(op.usuario.id);
    expect(ultimo.comentario).toContain('Zona A → Zona B');
    expect(ultimo.comentario).toContain('Cuadrilla A');
  });

  it('el comentario del operador se agrega al motivo', async () => {
    const r = await reporte('asignado', { cuadrillaId: cuadrillaA });
    await cambiarZona(r.id, {
      zonaId: 'zon-sur',
      comentario: 'El pozo está del otro lado del bulevar.',
    }).expect(200);
    const ultimo = (await cambiosDe(r.id))[1]!;
    expect(ultimo.comentario).toContain('El pozo está del otro lado');
  });

  it('con una cuadrilla de la zona nueva: la cuadrilla se queda', async () => {
    const r = await reporte('asignado', { cuadrillaId: cuadrillaB });
    const res = await cambiarZona(r.id, { zonaId: 'zon-sur' });
    expect(res.status).toBe(200);
    expect(res.body.datos.estado).toBe('asignado');
    expect(res.body.datos.cuadrillaId).toBe(cuadrillaB);
    expect(await cambiosDe(r.id)).toHaveLength(1);
  });

  it('la misma zona: 200 y no cambia nada (se puede repetir)', async () => {
    const r = await reporte('asignado', { cuadrillaId: cuadrillaA });
    for (let i = 0; i < 2; i++) {
      const res = await cambiarZona(r.id, { zonaId: 'zon-norte' });
      expect(res.status).toBe(200);
      expect(res.body.datos.cuadrillaId).toBe(cuadrillaA);
    }
    expect(await cambiosDe(r.id)).toHaveLength(1);
    expect((await enBase(r.id)).zonaId).toBe('zon-norte');
  });

  it('422 ZONA_NO_ENCONTRADA con una zona que no existe', async () => {
    const r = await reporte();
    esperarError(
      await cambiarZona(r.id, { zonaId: 'zon-inexistente' }),
      422,
      'ZONA_NO_ENCONTRADA',
    );
    expect((await enBase(r.id)).zonaId).toBe('zon-norte');
  });

  it('422 REPORTE_CERRADO con un reporte resuelto o rechazado', async () => {
    for (const estado of ['resuelto', 'rechazado'] as const) {
      const r = await reporte(estado);
      esperarError(
        await cambiarZona(r.id, { zonaId: 'zon-sur' }),
        422,
        'REPORTE_CERRADO',
      );
    }
  });

  it.each([
    ['sin zona', {}],
    ['zona con otro formato', { zonaId: 'norte' }],
    ['zona que no es texto', { zonaId: 3 }],
    ['campo de más', { zonaId: 'zon-sur', estado: 'resuelto' }],
  ])('400 VALIDACION_FALLIDA %s', async (_caso, cuerpo) => {
    const r = await reporte();
    esperarError(await cambiarZona(r.id, cuerpo), 400, 'VALIDACION_FALLIDA');
  });

  it('404 con un reporte que no existe', async () => {
    esperarError(
      await cambiarZona('rep-noexiste', { zonaId: 'zon-sur' }),
      404,
      'REPORTE_NO_ENCONTRADO',
    );
  });

  it('403 para un vecino', async () => {
    const r = await reporte();
    esperarError(
      await cambiarZona(r.id, { zonaId: 'zon-sur' }, ana),
      403,
      'SIN_PERMISO',
    );
  });

  it('401 sin sesión', async () => {
    const r = await reporte();
    esperarError(
      await ctx
        .http()
        .patch(`/reportes/${r.id}/zona`)
        .send({ zonaId: 'zon-sur' }),
      401,
      'NO_AUTENTICADO',
    );
  });
});
